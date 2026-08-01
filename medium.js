(() => {
  "use strict";

  /** @enum {string} */
  const LockSignal = Object.freeze({
    PREVIEW_ONLY: "preview_only",
    LOCKED_FLAG: "locked_flag",
    MEMBERSHIP_CTA: "membership_cta",
    MEMBER_ONLY_PAYWALL: "member_only_paywall",
  });

  /** Immutable value object for the current Medium story URL. */
  class ArticleUrl {
    /** @param {string} href */
    constructor(href) {
      const clean = String(href || "").split("#")[0].split("?")[0];
      this.href = clean;
    }

    /** @returns {string} */
    toString() {
      return this.href;
    }
  }

  /** Result object for unlock attempts (success / failure). */
  class UnlockResult {
    /**
     * @param {boolean} ok
     * @param {{ title?: string, html?: string, mirrorUrl?: string, error?: string }} [payload]
     */
    constructor(ok, payload = {}) {
      this.ok = ok;
      this.title = payload.title || "";
      this.html = payload.html || "";
      this.mirrorUrl = payload.mirrorUrl || "";
      this.error = payload.error || "";
    }

    static success(title, html, mirrorUrl) {
      return new UnlockResult(true, { title, html, mirrorUrl });
    }

    static failure(error, mirrorUrl = "") {
      return new UnlockResult(false, { error, mirrorUrl });
    }
  }

  /** Parsed article content ready for the reader UI. */
  class ParsedArticle {
    /**
     * @param {string} title
     * @param {string} html
     * @param {number} textLength
     */
    constructor(title, html, textLength) {
      this.title = title;
      this.html = html;
      this.textLength = textLength;
    }

    /** @returns {boolean} */
    isReadable() {
      return this.textLength >= 500 && Boolean(this.html);
    }
  }

  /**
   * Strategy catalog: ordered mirror URL builders.
   * Failover walks this list linearly (O(n) attempts).
   */
  class MirrorCatalog {
    constructor() {
      /** @type {Array<(articleUrl: string) => string>} */
      this._builders = [
        (url) => `https://freedium-mirror.cfd/${url}`,
        (url) => `https://freedium-mirror.cfd/${url.replace(/^https?:\/\//i, "")}`,
      ];
    }

    /** @param {ArticleUrl} articleUrl @returns {string[]} */
    buildQueue(articleUrl) {
      const href = articleUrl.toString();
      const seen = new Set();
      const queue = [];
      for (const build of this._builders) {
        const mirror = build(href);
        if (!seen.has(mirror)) {
          seen.add(mirror);
          queue.push(mirror);
        }
      }
      return queue;
    }

    /** @param {ArticleUrl} articleUrl @returns {string} */
    primary(articleUrl) {
      return this.buildQueue(articleUrl)[0];
    }
  }

  /**
   * Detects Medium hard/soft locks using stacked predicates (short-circuit OR).
   */
  class LockDetector {
    constructor() {
      /** @type {Array<{ id: string, test: (ctx: { html: string, text: string }) => boolean }>} */
      this._rules = [
        {
          id: LockSignal.PREVIEW_ONLY,
          test: ({ html }) => /isLockedPreviewOnly"\s*:\s*true/.test(html),
        },
        {
          id: LockSignal.LOCKED_FLAG,
          test: ({ html }) =>
            /"isLocked"\s*:\s*true/.test(html) &&
            /LOCKED_POST_SOURCE|visibility"\s*:\s*"LOCKED"/.test(html),
        },
        {
          id: LockSignal.MEMBERSHIP_CTA,
          test: ({ text }) => text.includes("become a member to read this story"),
        },
        {
          id: LockSignal.MEMBER_ONLY_PAYWALL,
          test: ({ text }) =>
            text.includes("member-only story") && text.includes("behind our paywall"),
        },
      ];
    }

    /**
     * @param {Document} doc
     * @returns {{ locked: boolean, signals: string[] }}
     */
    evaluate(doc) {
      const html = doc.documentElement?.innerHTML || "";
      const text = (doc.body?.innerText || "").slice(0, 12_000).toLowerCase();
      const ctx = { html, text };
      const signals = [];

      for (const rule of this._rules) {
        if (rule.test(ctx)) signals.push(rule.id);
      }

      return { locked: signals.length > 0, signals };
    }
  }

  /** Parses / sanitizes mirror HTML into a ParsedArticle (tree walk + cleanup). */
  class ArticleHtmlParser {
    static #STRIP_SELECTORS = "script, style, iframe, nav, button";
    static #MIN_CHARS = 500;

    /**
     * @param {string} mirrorHtml
     * @param {string} mirrorUrl
     * @param {string} fallbackTitle
     * @returns {ParsedArticle | null}
     */
    parse(mirrorHtml, mirrorUrl, fallbackTitle) {
      const doc = new DOMParser().parseFromString(mirrorHtml, "text/html");
      const root = doc.querySelector("article") || doc.querySelector("main");
      if (!root) return null;

      this.#stripNoise(root);
      this.#absolutizeResources(root, mirrorUrl);

      const title = (root.querySelector("h1")?.textContent || fallbackTitle || "Article").trim();
      const textLength = (root.textContent || "").replace(/\s+/g, " ").trim().length;
      const article = new ParsedArticle(title, root.innerHTML, textLength);
      return article.isReadable() ? article : null;
    }

    /** @param {Element} root */
    #stripNoise(root) {
      root.querySelectorAll(ArticleHtmlParser.#STRIP_SELECTORS).forEach((el) => el.remove());
    }

    /**
     * BFS over element children to rewrite relative URLs.
     * @param {Element} root
     * @param {string} baseUrl
     */
    #absolutizeResources(root, baseUrl) {
      const queue = [root];
      while (queue.length) {
        const node = queue.shift();
        if (!(node instanceof Element)) continue;

        if (node instanceof HTMLImageElement && node.getAttribute("src")) {
          node.setAttribute("src", this.#toAbsolute(node.getAttribute("src"), baseUrl));
        }
        if (node instanceof HTMLAnchorElement) {
          const href = node.getAttribute("href");
          if (href && href.startsWith("/")) {
            node.setAttribute("href", this.#toAbsolute(href, baseUrl));
          }
        }

        for (const child of node.children) queue.push(child);
      }
    }

    /** @param {string} value @param {string} base @returns {string} */
    #toAbsolute(value, base) {
      try {
        return new URL(value, base).href;
      } catch {
        return value;
      }
    }
  }

  /** Debounces high-frequency DOM mutations (leading-edge coalesce). */
  class DebouncedScheduler {
    /**
     * @param {() => void} task
     * @param {number} delayMs
     */
    constructor(task, delayMs = 500) {
      this._task = task;
      this._delayMs = delayMs;
      this._pending = false;
      this._timer = 0;
    }

    schedule() {
      if (this._pending) return;
      this._pending = true;
      this._timer = window.setTimeout(() => {
        this._pending = false;
        this._task();
      }, this._delayMs);
    }

    cancel() {
      if (this._timer) window.clearTimeout(this._timer);
      this._pending = false;
      this._timer = 0;
    }
  }

  /** Injects / removes the Medium unlock stylesheet once. */
  class StyleSheetManager {
    static #ID = "adblock-lite-medium";
    static #BTN = "adblock-lite-medium-btn";
    static #OVERLAY = "adblock-lite-medium-reader";

    static get buttonId() {
      return StyleSheetManager.#BTN;
    }

    static get overlayId() {
      return StyleSheetManager.#OVERLAY;
    }

    inject() {
      let style = document.getElementById(StyleSheetManager.#ID);
      if (!style) {
        style = document.createElement("style");
        style.id = StyleSheetManager.#ID;
        (document.documentElement || document.head).appendChild(style);
      }
      style.textContent = StyleSheetManager.#css();
    }

    remove() {
      document.getElementById(StyleSheetManager.#ID)?.remove();
    }

    static #css() {
      const btn = StyleSheetManager.#BTN;
      const overlay = StyleSheetManager.#OVERLAY;
      return `
article p, article h2, article h3, article li, article blockquote,
section[data-field="body"] p, div[data-testid="storyContent"] p {
  opacity: 1 !important;
  filter: none !important;
  -webkit-mask-image: none !important;
  mask-image: none !important;
}
article [style*="opacity"],
section[data-field="body"] [style*="opacity"],
div[data-testid="storyContent"] [style*="opacity"] {
  opacity: 1 !important;
  filter: none !important;
}
#${btn} {
  position: fixed !important; right: 20px !important; bottom: 24px !important;
  z-index: 2147483646 !important; appearance: none !important; border: 0 !important;
  border-radius: 999px !important; padding: 12px 18px !important;
  font: 600 14px/1.2 Georgia, "Times New Roman", serif !important;
  color: #fff !important; background: #1a1a1a !important;
  box-shadow: 0 8px 24px rgba(0,0,0,.28) !important; cursor: pointer !important;
}
#${btn}:hover { background: #000 !important; }
#${btn}[disabled] { opacity: .7 !important; cursor: wait !important; }
#${overlay} {
  position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
  background: rgba(18, 18, 18, 0.55) !important; display: flex !important;
  justify-content: center !important; padding: 24px 12px !important; overflow: auto !important;
}
#${overlay} .abl-reader {
  width: min(760px, 100%) !important; margin: auto !important; background: #faf9f5 !important;
  color: #242424 !important; border-radius: 12px !important;
  box-shadow: 0 20px 60px rgba(0,0,0,.35) !important;
  max-height: calc(100vh - 48px) !important; overflow: auto !important; position: relative !important;
}
#${overlay} .abl-reader-bar {
  position: sticky !important; top: 0 !important; display: flex !important;
  justify-content: space-between !important; align-items: center !important; gap: 12px !important;
  padding: 12px 16px !important; background: #faf9f5 !important;
  border-bottom: 1px solid #e6e4dc !important; z-index: 2 !important;
}
#${overlay} .abl-reader-bar button {
  appearance: none !important; border: 0 !important; background: #1a1a1a !important;
  color: #fff !important; border-radius: 8px !important; padding: 8px 12px !important;
  cursor: pointer !important; font: 600 13px/1 system-ui, sans-serif !important;
}
#${overlay} .abl-reader-bar a {
  color: #1a1a1a !important; font: 600 13px/1.2 system-ui, sans-serif !important;
}
#${overlay} .abl-reader-body {
  padding: 28px 28px 48px !important;
  font: 400 18px/1.7 Georgia, "Times New Roman", serif !important;
}
#${overlay} .abl-reader-body h1 { font-size: 34px !important; line-height: 1.2 !important; margin: 0 0 12px !important; }
#${overlay} .abl-reader-body h2 { font-size: 26px !important; margin: 28px 0 12px !important; }
#${overlay} .abl-reader-body h3 { font-size: 22px !important; margin: 24px 0 10px !important; }
#${overlay} .abl-reader-body p, #${overlay} .abl-reader-body li { margin: 0 0 1em !important; }
#${overlay} .abl-reader-body img { max-width: 100% !important; height: auto !important; border-radius: 6px !important; }
#${overlay} .abl-reader-body nav,
#${overlay} .abl-reader-body button,
#${overlay} .abl-reader-body [aria-labelledby="toc-heading"] { display: none !important; }
#${overlay} .abl-status {
  padding: 40px 28px !important; font: 400 16px/1.5 system-ui, sans-serif !important; color: #444 !important;
}`;
    }
  }

  /** Floating CTA button view. */
  class UnlockButtonView {
    /**
     * @param {() => void} onClick
     */
    constructor(onClick) {
      this._onClick = onClick;
      this._el = null;
    }

    mount() {
      if (this._el || document.getElementById(StyleSheetManager.overlayId)) return;
      if (document.getElementById(StyleSheetManager.buttonId)) return;

      const btn = document.createElement("button");
      btn.id = StyleSheetManager.buttonId;
      btn.type = "button";
      btn.textContent = "Read full article";
      btn.addEventListener("click", this._onClick);
      document.documentElement.appendChild(btn);
      this._el = btn;
    }

    setLoading(loading) {
      if (!this._el) this._el = document.getElementById(StyleSheetManager.buttonId);
      if (!this._el) return;
      this._el.disabled = Boolean(loading);
      this._el.textContent = loading ? "Loading full article…" : "Read full article";
    }

    unmount() {
      this._el?.remove();
      document.getElementById(StyleSheetManager.buttonId)?.remove();
      this._el = null;
    }
  }

  /** Full-article reader overlay view. */
  class ReaderOverlayView {
    /**
     * @param {() => void} onClose
     */
    constructor(onClose) {
      this._onClose = onClose;
      this._root = null;
      this._onKey = (event) => {
        if (event.key === "Escape") this.close();
      };
    }

    /**
     * @param {UnlockResult} result
     */
    open(result) {
      this.close();
      const root = document.createElement("div");
      root.id = StyleSheetManager.overlayId;

      const mirrorLink = result.mirrorUrl
        ? `<a href="${this.#escapeAttr(result.mirrorUrl)}" target="_blank" rel="noopener noreferrer">Open mirror</a>`
        : "";

      const body = result.ok
        ? `<div class="abl-reader-body"><h1>${this.#escapeHtml(result.title)}</h1>${result.html}</div>`
        : `<div class="abl-status">${result.error}</div>`;

      root.innerHTML = `
        <div class="abl-reader" role="dialog" aria-modal="true" aria-label="Full article">
          <div class="abl-reader-bar">
            <strong>Full article</strong>
            <div style="display:flex;gap:8px;align-items:center">
              ${mirrorLink}
              <button type="button" data-abl-close>Close</button>
            </div>
          </div>
          ${body}
        </div>`;

      root.addEventListener("click", (event) => {
        const target = event.target;
        if (target === root || (target instanceof HTMLElement && target.dataset.ablClose !== undefined)) {
          this.close();
        }
      });

      document.documentElement.appendChild(root);
      document.addEventListener("keydown", this._onKey);
      this._root = root;
    }

    close() {
      if (!this._root) {
        document.getElementById(StyleSheetManager.overlayId)?.remove();
        return;
      }
      document.removeEventListener("keydown", this._onKey);
      this._root.remove();
      this._root = null;
      this._onClose();
    }

    unmount() {
      document.removeEventListener("keydown", this._onKey);
      this._root?.remove();
      document.getElementById(StyleSheetManager.overlayId)?.remove();
      this._root = null;
    }

    /** @param {string} value */
    #escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    /** @param {string} value */
    #escapeAttr(value) {
      return this.#escapeHtml(value).replaceAll("'", "&#39;");
    }
  }

  /** Fetches mirror HTML through the extension background service worker. */
  class UnlockGateway {
    /**
     * @param {MirrorCatalog} mirrors
     * @param {ArticleHtmlParser} parser
     */
    constructor(mirrors, parser) {
      this._mirrors = mirrors;
      this._parser = parser;
    }

    /**
     * @param {ArticleUrl} articleUrl
     * @returns {Promise<UnlockResult>}
     */
    async unlock(articleUrl) {
      const primary = this._mirrors.primary(articleUrl);
      try {
        const response = await chrome.runtime.sendMessage({
          type: "fetchMediumUnlock",
          url: articleUrl.toString(),
        });

        if (!response?.ok || !response.html) {
          return UnlockResult.failure(
            `Could not load full text here. <a href="${primary}" target="_blank" rel="noopener noreferrer">Open mirror instead</a>.`,
            primary
          );
        }

        const mirrorUrl = response.mirrorUrl || primary;
        const parsed = this._parser.parse(response.html, mirrorUrl, document.title);
        if (!parsed) {
          return UnlockResult.failure(
            `Mirror returned an unexpected page. <a href="${mirrorUrl}" target="_blank" rel="noopener noreferrer">Open mirror</a>.`,
            mirrorUrl
          );
        }

        return UnlockResult.success(parsed.title, parsed.html, mirrorUrl);
      } catch {
        return UnlockResult.failure(
          `Unlock failed. <a href="${primary}" target="_blank" rel="noopener noreferrer">Open mirror</a>.`,
          primary
        );
      }
    }
  }

  /**
   * Application controller: wires detection → unlock → UI.
   * State machine: idle → detecting → unlocking → reading.
   */
  class MediumUnlockController {
    constructor() {
      this._styles = new StyleSheetManager();
      this._detector = new LockDetector();
      this._mirrors = new MirrorCatalog();
      this._parser = new ArticleHtmlParser();
      this._gateway = new UnlockGateway(this._mirrors, this._parser);
      this._button = new UnlockButtonView(() => this.unlock());
      this._overlay = new ReaderOverlayView(() => this._button.mount());
      this._scheduler = new DebouncedScheduler(() => this.tick(), 500);
      this._observer = null;
      this._autoUnlockTried = false;
      this._busy = false;
    }

    async start() {
      const raw = await chrome.storage.local.get({
        enabled: true,
        features: { mediumUnlock: true },
        pausedHosts: [],
      });
      const host = (location.hostname || "").replace(/^www\./, "").toLowerCase();
      const paused = Array.isArray(raw.pausedHosts) && raw.pausedHosts.includes(host);
      const mediumOn = raw.features?.mediumUnlock !== false;
      if (raw.enabled === false || paused || !mediumOn) return;

      this.tick();
      this._observer = new MutationObserver(() => this._scheduler.schedule());
      if (document.documentElement) {
        this._observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    }

    stop() {
      this._scheduler.cancel();
      this._observer?.disconnect();
      this._observer = null;
      this._styles.remove();
      this._button.unmount();
      this._overlay.unmount();
      this._autoUnlockTried = false;
      this._busy = false;
    }

    tick() {
      this._observer?.disconnect();
      try {
        this._styles.inject();
        const { locked } = this._detector.evaluate(document);
        if (!locked) return;

        this._button.mount();
        if (!this._autoUnlockTried) {
          this._autoUnlockTried = true;
          window.setTimeout(() => this.unlock(), 600);
        }
      } finally {
        if (this._observer && document.documentElement) {
          this._observer.observe(document.documentElement, { childList: true, subtree: true });
        }
      }
    }

    async unlock() {
      if (this._busy) return;
      this._busy = true;
      this._button.setLoading(true);

      try {
        const articleUrl = new ArticleUrl(location.href);
        const result = await this._gateway.unlock(articleUrl);
        this._button.unmount();
        this._overlay.open(result);
      } finally {
        this._busy = false;
        this._button.setLoading(false);
      }
    }
  }

  const app = new MediumUnlockController();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.enabled && !changes.features && !changes.pausedHosts) return;
    if (changes.enabled?.newValue === false) app.stop();
    else {
      app.stop();
      app.start();
    }
  });

  if (document.documentElement) app.start();
  else document.addEventListener("DOMContentLoaded", () => app.start(), { once: true });
})();
