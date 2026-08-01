(() => {
  "use strict";

  /**
   * Force English — silent in-page translation via the service worker
   * (page CSP often blocks translate.googleapis.com from content scripts).
   */
  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return false;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-gosafe-force-english") !== "off";
    }
  }

  class PageLanguageProbe {
    static #EN = /^(en)([-_]|$)/i;
    /** Khmer, CJK, Cyrillic, Arabic, Thai, Lao, Myanmar, etc. */
    static #NON_LATIN =
      /[\u0400-\u04FF\u0600-\u06FF\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u4E00-\u9FFF]/;

    static skipHost() {
      const h = (location.hostname || "").toLowerCase();
      if (!h) return true;
      if (h.endsWith(".translate.goog") || h.includes("translate.google.")) return true;
      if (/(^|\.)(accounts\.google|paypal\.|stripe\.|bank)/i.test(h)) return true;
      // Gmail / Workspace — DOM rewrite triggers Gmail error #2014.
      if (
        h === "gmail.com" ||
        h.endsWith(".gmail.com") ||
        /^(mail|accounts|docs|drive|calendar|meet|chat|contacts|photos|sheets|slides|classroom|keep|script|sites|admin|myaccount|workspace|ogs)\./i.test(
          h
        )
      ) {
        return true;
      }
      // Meta / NVIDIA SPAs — DOM thrash breaks buttons & navigation.
      if (
        /(^|\.)(facebook\.com|fb\.com|messenger\.com|instagram\.com|meta\.com|threads\.net|whatsapp\.com)$/i.test(
          h
        ) ||
        /(^|\.)(nvidia\.com|nvidiagrid\.net|auth0\.com)$/i.test(h)
      ) {
        return true;
      }
      // Never rewrite stream/movie watch pages — DOM thrash breaks player routing.
      if (
        /movie|film|khhd|anime|stream|rpmvip|watch|vidsrc|filemoon|megacloud|jwplayer|rbtv|rbtvplus|superabbit/i.test(h) ||
        /\/(watch|movie|episode|play|embed|player|stream|football|live)\b/i.test(location.pathname || "")
      ) {
        return true;
      }
      if (location.protocol !== "http:" && location.protocol !== "https:") return true;
      if (window !== window.top) return true;
      return false;
    }

    static isEnglishCode(code) {
      return PageLanguageProbe.#EN.test(String(code || ""));
    }

    static declaredLang() {
      const html = document.documentElement?.getAttribute("lang") || "";
      const meta =
        document.querySelector('meta[http-equiv="content-language" i]')?.getAttribute("content") ||
        "";
      return String(html || meta || "")
        .trim()
        .toLowerCase()
        .split(/[,;]/)[0]
        .trim();
    }

    static sampleText() {
      const body = document.body?.innerText || "";
      return `${document.title || ""} ${body}`.replace(/\s+/g, " ").trim().slice(0, 2400);
    }

    static hasNonLatin(text) {
      return PageLanguageProbe.#NON_LATIN.test(String(text || ""));
    }

    static heuristicNonEnglish(text) {
      const t = String(text || "");
      if (!t.trim()) return false;
      // Any Khmer/CJK/etc. character counts — even a short word.
      if (PageLanguageProbe.hasNonLatin(t)) return true;
      if (t.length < 8) return false;
      if (/[áéíóúñü¿¡]/i.test(t)) return true;
      if (
        /\b(no se|especifi|volver|agenda|transmisi[oó]n|en vivo|desactivar|bloqueador|anuncios|experiencia|ning[uú]n|evento)\b/i.test(
          t
        )
      ) {
        return true;
      }
      return false;
    }

    static async needsEnglish() {
      if (!FeatureGate.on() || PageLanguageProbe.skipHost()) return false;
      try {
        if (sessionStorage.getItem("gosafe-en-skip") === "1") return false;
      } catch {
        // ignore
      }

      const lang = PageLanguageProbe.declaredLang();
      if (lang && PageLanguageProbe.isEnglishCode(lang)) return false;
      if (lang && !PageLanguageProbe.isEnglishCode(lang)) return true;

      const sample = PageLanguageProbe.sampleText();
      if (sample.length < 8) return false;
      if (PageLanguageProbe.heuristicNonEnglish(sample)) return true;

      try {
        const result = await chrome.i18n.detectLanguage(sample);
        const top = result?.languages?.[0];
        const code = String(top?.language || "").toLowerCase();
        const pct = Number(top?.percentage) || 0;
        if (!code || PageLanguageProbe.isEnglishCode(code)) return false;
        return pct >= 35;
      } catch {
        return false;
      }
    }
  }

  class TranslationCache {
    /** @param {number} capacity */
    constructor(capacity = 800) {
      this._cap = capacity;
      /** @type {Map<string, string>} */
      this._map = new Map();
    }

    get(key) {
      if (!this._map.has(key)) return undefined;
      const v = this._map.get(key);
      this._map.delete(key);
      this._map.set(key, v);
      return v;
    }

    set(key, value) {
      if (this._map.has(key)) this._map.delete(key);
      this._map.set(key, value);
      while (this._map.size > this._cap) {
        this._map.delete(this._map.keys().next().value);
      }
    }
  }

  /** Talks to background GTX proxy (avoids page CSP). */
  class SwTranslator {
    static #cache = new TranslationCache(1000);

    /**
     * @param {string[]} texts
     * @returns {Promise<string[]>}
     */
    static async translateMany(texts) {
      const input = texts.map((t) => String(t || ""));
      if (!input.length) return [];

      /** @type {(string|null)[]} */
      const out = input.map((t) => {
        const hit = SwTranslator.#cache.get(t);
        return hit != null ? hit : null;
      });
      const missingIdx = [];
      const missing = [];
      for (let i = 0; i < input.length; i += 1) {
        if (out[i] == null) {
          missingIdx.push(i);
          missing.push(input[i]);
        }
      }
      if (!missing.length) return /** @type {string[]} */ (out);

      try {
        const res = await chrome.runtime.sendMessage({
          type: "translateToEnglish",
          texts: missing,
        });
        const translated = Array.isArray(res?.texts) ? res.texts : missing;
        for (let j = 0; j < missingIdx.length; j += 1) {
          const i = missingIdx[j];
          const val = String(translated[j] ?? missing[j] ?? input[i]);
          out[i] = val;
          SwTranslator.#cache.set(input[i], val);
        }
      } catch {
        for (const i of missingIdx) out[i] = input[i];
      }
      return /** @type {string[]} */ (out);
    }

    /** @param {string} text */
    static async translate(text) {
      const [one] = await SwTranslator.translateMany([text]);
      return one;
    }
  }

  class DomEnglishRewriter {
    static #SKIP = new Set([
      "SCRIPT",
      "STYLE",
      "NOSCRIPT",
      "TEXTAREA",
      "CODE",
      "PRE",
      "KBD",
      "SAMP",
      "SVG",
      "MATH",
      "IFRAME",
      "OBJECT",
      "VIDEO",
      "AUDIO",
      "CANVAS",
    ]);

    static #ATTRS = Object.freeze(["placeholder", "title", "aria-label", "alt"]);

    /** @type {WeakSet<Text>} */
    static #done = new WeakSet();
    static #busy = false;

    /**
     * @param {Node} root
     * @returns {Text[]}
     */
    static #collectTextNodes(root) {
      /** @type {Text[]} */
      const out = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (DomEnglishRewriter.#SKIP.has(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest?.("code, pre, script, style, textarea, [contenteditable='true']")) {
            return NodeFilter.FILTER_REJECT;
          }
          const t = node.nodeValue || "";
          if (!t.trim()) return NodeFilter.FILTER_REJECT;
          if (DomEnglishRewriter.#done.has(node)) return NodeFilter.FILTER_REJECT;
          if (!PageLanguageProbe.heuristicNonEnglish(t) && !/[^\x00-\x7F]/.test(t)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let n = walker.nextNode();
      while (n) {
        out.push(/** @type {Text} */ (n));
        n = walker.nextNode();
      }
      return out;
    }

    static async rewrite(root = document.body) {
      if (!root || DomEnglishRewriter.#busy) return;
      DomEnglishRewriter.#busy = true;
      try {
        const nodes = DomEnglishRewriter.#collectTextNodes(root).slice(0, 600);
        const chunkSize = 40;
        for (let i = 0; i < nodes.length; i += chunkSize) {
          const batch = nodes.slice(i, i + chunkSize).filter((n) => n.isConnected);
          const texts = batch.map((n) => n.nodeValue || "");
          const translated = await SwTranslator.translateMany(texts);
          for (let j = 0; j < batch.length; j += 1) {
            const node = batch[j];
            const next = translated[j];
            const prev = texts[j];
            if (next && next !== prev && node.isConnected) {
              node.nodeValue = next;
              DomEnglishRewriter.#done.add(node);
            }
          }
        }

        /** @type {{ el: Element, attr: string, val: string }[]} */
        const attrJobs = [];
        for (const el of root.querySelectorAll(
          "input[placeholder], textarea[placeholder], [title], [aria-label], img[alt]"
        )) {
          for (const attr of DomEnglishRewriter.#ATTRS) {
            const val = el.getAttribute?.(attr);
            if (!val || !val.trim()) continue;
            if (!PageLanguageProbe.heuristicNonEnglish(val) && !/[^\x00-\x7F]/.test(val)) {
              continue;
            }
            const key = `a:${attr}:${val}`;
            if (el.getAttribute("data-gosafe-en") === key) continue;
            attrJobs.push({ el, attr, val });
          }
        }
        if (attrJobs.length) {
          const translated = await SwTranslator.translateMany(attrJobs.map((j) => j.val));
          for (let i = 0; i < attrJobs.length; i += 1) {
            const job = attrJobs[i];
            const next = translated[i];
            if (next && next !== job.val && job.el.isConnected) {
              job.el.setAttribute(job.attr, next);
              job.el.setAttribute("data-gosafe-en", `a:${job.attr}:${job.val}`);
            }
          }
        }

        if (document.title && PageLanguageProbe.heuristicNonEnglish(document.title)) {
          const t = await SwTranslator.translate(document.title);
          if (t) document.title = t;
        }
      } finally {
        DomEnglishRewriter.#busy = false;
      }
    }
  }

  class ForceEnglishPage {
    static #started = false;
    static #active = false;

    static async run() {
      if (!FeatureGate.on()) return;

      if ((location.hostname || "").endsWith(".translate.goog")) {
        try {
          const host = location.hostname.replace(/\.translate\.goog$/i, "").replace(/-/g, ".");
          const params = new URLSearchParams(location.search);
          for (const k of [...params.keys()]) {
            if (k.startsWith("_x_tr_")) params.delete(k);
          }
          const q = params.toString();
          location.replace(
            `https://${host}${location.pathname}${q ? `?${q}` : ""}${location.hash || ""}`
          );
        } catch {
          // ignore
        }
        return;
      }

      if (!(await PageLanguageProbe.needsEnglish())) return;
      ForceEnglishPage.#active = true;
      await DomEnglishRewriter.rewrite(document.body || document.documentElement);
    }

    static start() {
      if (ForceEnglishPage.#started) return;
      ForceEnglishPage.#started = true;

      const schedule = () => {
        ForceEnglishPage.run().catch(() => {});
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", schedule, { once: true });
      } else {
        schedule();
      }
      window.addEventListener("load", schedule, { once: true });
      setTimeout(schedule, 400);
      setTimeout(schedule, 1200);
      setTimeout(schedule, 3000);
      setTimeout(schedule, 6000);

      try {
        let t = 0;
        new MutationObserver(() => {
          if (!FeatureGate.on()) return;
          window.clearTimeout(t);
          t = window.setTimeout(() => {
            if (!ForceEnglishPage.#active) {
              ForceEnglishPage.run().catch(() => {});
            } else {
              DomEnglishRewriter.rewrite(document.body).catch(() => {});
            }
          }, 600);
        }).observe(document.documentElement, { childList: true, subtree: true });
      } catch {
        // ignore
      }
    }
  }

  ForceEnglishPage.start();
})();
