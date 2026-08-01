(() => {
  "use strict";

  /**
   * Reader mode — decluttered article view that keeps GOSAFE highlight marks.
   */
  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return false;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-gosafe-reader-mode") !== "off";
    }
  }

  class ReaderMode {
    static #ROOT = "gosafe-reader-mode";
    static #BTN = "gosafe-reader-fab";
    static #STYLE = "gosafe-reader-mode-css";
    static #open = false;

    static start() {
      if (window !== window.top) return;
      if (location.protocol !== "http:" && location.protocol !== "https:") return;
      if (/\.pdf(?:$|[?#])/i.test(location.pathname || location.href)) return;
      // Short-form video feeds — FAB + PiP logos clutter the UI.
      const host = (location.hostname || "").replace(/^www\./, "").toLowerCase();
      if (
        /(^|\.)(tiktok\.com|douyin\.com|instagram\.com|threads\.net|facebook\.com|fb\.com|snapchat\.com|likee\.video|kahoot\.it)$/i.test(
          host
        )
      ) {
        return;
      }
      if (/youtube\.com$/i.test(host) && /\/shorts\b/i.test(location.pathname || "")) return;
      ReaderMode.#injectCss();
      ReaderMode.#ensureFab();
      document.addEventListener(
        "keydown",
        (ev) => {
          if (ev.key === "Escape" && ReaderMode.#open) ReaderMode.close();
        },
        true
      );
    }

    static #injectCss() {
      if (document.getElementById(ReaderMode.#STYLE)) return;
      const style = document.createElement("style");
      style.id = ReaderMode.#STYLE;
      style.textContent = `
#${ReaderMode.#BTN} {
  position: fixed !important;
  z-index: 2147483645 !important;
  right: 16px !important;
  bottom: 16px !important;
  width: 48px !important;
  height: 48px !important;
  border: 0 !important;
  border-radius: 999px !important;
  background: #fff !important;
  color: #002870 !important;
  padding: 0 !important;
  cursor: pointer !important;
  box-shadow: 0 10px 28px rgba(0, 40, 112, 0.4) !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  overflow: hidden !important;
}
#${ReaderMode.#BTN} img {
  width: 36px !important;
  height: 36px !important;
  object-fit: contain !important;
  display: block !important;
  pointer-events: none !important;
}
#${ReaderMode.#BTN}:hover { filter: brightness(1.05); }
#${ReaderMode.#ROOT} {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483646 !important;
  display: none !important;
  background: #f4f7fc !important;
  color: #0a1f45 !important;
  overflow: auto !important;
  font-family: Georgia, "Times New Roman", serif !important;
}
#${ReaderMode.#ROOT}.is-open { display: block !important; }
#${ReaderMode.#ROOT} .grm-top {
  position: sticky !important;
  top: 0 !important;
  z-index: 2 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 12px !important;
  padding: 12px 18px !important;
  background: linear-gradient(135deg, #002870, #0058d0) !important;
  color: #f4f7fc !important;
  font-family: "Segoe UI", "Helvetica Neue", sans-serif !important;
}
#${ReaderMode.#ROOT} .grm-top strong { font-size: 14px !important; }
#${ReaderMode.#ROOT} .grm-top button {
  border: 0 !important;
  border-radius: 8px !important;
  background: #fff !important;
  color: #002870 !important;
  font: 700 12px/1 "Segoe UI", sans-serif !important;
  padding: 8px 12px !important;
  cursor: pointer !important;
}
#${ReaderMode.#ROOT} .grm-article {
  max-width: 720px !important;
  margin: 0 auto !important;
  padding: 28px 20px 64px !important;
  font-size: 1.15rem !important;
  line-height: 1.7 !important;
}
#${ReaderMode.#ROOT} .grm-article h1,
#${ReaderMode.#ROOT} .grm-article h2,
#${ReaderMode.#ROOT} .grm-article h3 {
  font-family: "Segoe UI", "Helvetica Neue", sans-serif !important;
  color: #002870 !important;
  line-height: 1.25 !important;
}
#${ReaderMode.#ROOT} .grm-article img,
#${ReaderMode.#ROOT} .grm-article video {
  max-width: 100% !important;
  height: auto !important;
  border-radius: 8px !important;
}
#${ReaderMode.#ROOT} .grm-article a { color: #0058d0 !important; }
#${ReaderMode.#ROOT} mark.gosafe-sel-hl {
  background: color-mix(in srgb, var(--ghl, #fde047) 72%, transparent) !important;
  color: inherit !important;
  border-radius: 2px !important;
  padding: 0 1px !important;
}
`.trim();
      (document.documentElement || document.head).appendChild(style);
    }

    static #ensureFab() {
      if (document.getElementById(ReaderMode.#BTN)) return;
      const btn = document.createElement("button");
      btn.id = ReaderMode.#BTN;
      btn.type = "button";
      btn.title = "GOSAFE Reader mode";
      const img = document.createElement("img");
      img.src = chrome.runtime.getURL("icons/icon48.png");
      img.alt = "GOSAFE";
      img.width = 36;
      img.height = 36;
      btn.appendChild(img);
      btn.addEventListener("click", () => {
        if (!FeatureGate.on()) return;
        if (ReaderMode.#open) ReaderMode.close();
        else ReaderMode.open();
      });
      (document.documentElement || document.body).appendChild(btn);

      const sync = () => {
        btn.style.display = FeatureGate.on() ? "" : "none";
      };
      sync();
      new MutationObserver(sync).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-gosafe-reader-mode", "data-adblock-lite"],
      });
    }

    /** @returns {HTMLElement | null} */
    static #pickSource() {
      const candidates = [
        document.querySelector("article"),
        document.querySelector("[role='main'] article"),
        document.querySelector("main"),
        document.querySelector("[role='main']"),
        document.querySelector(".post-content, .entry-content, .article-content, .story-body, #content"),
        document.body,
      ].filter((el) => el instanceof HTMLElement);
      let best = null;
      let bestScore = 0;
      for (const el of candidates) {
        const text = (el.innerText || "").trim();
        const score = text.length + el.querySelectorAll("p").length * 80;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return best;
    }

    /** @param {HTMLElement} root */
    static #scrub(root) {
      for (const bad of root.querySelectorAll(
        "script, style, iframe, noscript, form, nav, aside, footer, [role='navigation'], [role='complementary'], .ad, .ads, .advert, [class*='ad-' i], [id*='ad-' i], [class*='newsletter' i], [class*='subscribe' i], [class*='share' i], [class*='social' i], [class*='related' i], [class*='recommend' i], [class*='comment' i]"
      )) {
        // Keep GOSAFE marks even if nested oddly
        if (bad.querySelector?.("mark.gosafe-sel-hl")) continue;
        bad.remove();
      }
    }

    static open() {
      const source = ReaderMode.#pickSource();
      if (!source) return;

      let root = document.getElementById(ReaderMode.#ROOT);
      if (!(root instanceof HTMLElement)) {
        root = document.createElement("div");
        root.id = ReaderMode.#ROOT;
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-label", "Reader mode");
        (document.documentElement || document.body).appendChild(root);
      }

      const clone = /** @type {HTMLElement} */ (source.cloneNode(true));
      ReaderMode.#scrub(clone);

      // Re-apply highlight styles from live marks if clone lost CSS vars
      for (const mark of clone.querySelectorAll("mark.gosafe-sel-hl")) {
        if (!(mark instanceof HTMLElement)) continue;
        const id = mark.getAttribute("data-gosafe-hl-id");
        const live = id
          ? document.querySelector(`mark.gosafe-sel-hl[data-gosafe-hl-id="${CSS.escape(id)}"]`)
          : null;
        if (live instanceof HTMLElement) {
          const ghl = live.style.getPropertyValue("--ghl") || live.style.backgroundColor;
          if (ghl) mark.style.setProperty("--ghl", ghl);
          if (live.title) mark.title = live.title;
        }
      }

      const title =
        document.querySelector("h1")?.textContent?.trim() ||
        document.title ||
        "Reader";

      root.innerHTML = `
        <div class="grm-top">
          <strong><img src="${chrome.runtime.getURL("icons/icon48.png")}" width="22" height="22" alt="" style="vertical-align:middle;margin-right:8px;border-radius:4px;background:#fff;padding:1px" />GOSAFE Reader</strong>
          <button type="button" data-act="close">Exit</button>
        </div>
        <div class="grm-article">
          <h1>${ReaderMode.#esc(title)}</h1>
        </div>
      `;
      const article = root.querySelector(".grm-article");
      // Avoid duplicating page H1 if clone already starts with one
      const cloneH1 = clone.querySelector("h1");
      if (cloneH1 && article?.querySelector("h1")) {
        article.querySelector("h1")?.remove();
      }
      article?.appendChild(clone);
      root.querySelector('[data-act="close"]')?.addEventListener("click", () => ReaderMode.close());

      root.classList.add("is-open");
      ReaderMode.#open = true;
      document.documentElement.style.overflow = "hidden";
    }

    static close() {
      const root = document.getElementById(ReaderMode.#ROOT);
      if (root) {
        root.classList.remove("is-open");
        root.innerHTML = "";
      }
      ReaderMode.#open = false;
      document.documentElement.style.overflow = "";
    }

    static #esc(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  }

  ReaderMode.start();
})();
