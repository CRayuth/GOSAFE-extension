(() => {
  "use strict";

  /**
   * Hover link preview — pages, PDFs, office docs, images, media.
   * Metadata fetched in the service worker (bypasses page CSP).
   */
  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return false;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-gosafe-link-preview") !== "off";
    }
  }

  /** Classify a URL into a preview strategy. */
  class LinkKind {
    static #IMG = /\.(avif|bmp|gif|jpe?g|png|svg|webp|ico)(?:$|[?#])/i;
    static #PDF = /\.pdf(?:$|[?#])/i;
    static #DOC =
      /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv)(?:$|[?#])/i;
    static #MEDIA = /\.(mp4|webm|ogg|mp3|wav|m4a|mov)(?:$|[?#])/i;
    static #BAD = /^(javascript|data|blob|vbscript|file|chrome|chrome-extension):/i;

    /**
     * @param {string} href
     * @returns {{ ok: boolean, href: string, kind: string, host: string } | null}
     */
    static parse(href) {
      const raw = String(href || "").trim();
      if (!raw || raw.startsWith("#") || LinkKind.#BAD.test(raw)) return null;
      let u;
      try {
        u = new URL(raw, location.href);
      } catch {
        return null;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (u.href.split("#")[0] === location.href.split("#")[0]) return null;

      const path = u.pathname || "";
      let kind = "page";
      if (LinkKind.#PDF.test(path) || LinkKind.#PDF.test(u.href)) kind = "pdf";
      else if (LinkKind.#IMG.test(path)) kind = "image";
      else if (LinkKind.#DOC.test(path)) kind = "doc";
      else if (LinkKind.#MEDIA.test(path)) kind = "media";

      return { ok: true, href: u.href, kind, host: u.hostname.replace(/^www\./, "") };
    }
  }

  class PreviewCache {
    constructor(cap = 40) {
      this._cap = cap;
      /** @type {Map<string, object>} */
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

  class PreviewApi {
    static #cache = new PreviewCache(48);

    /**
     * @param {string} href
     * @param {string} kind
     */
    static async fetchMeta(href, kind) {
      const key = `${kind}|${href}`;
      const hit = PreviewApi.#cache.get(key);
      if (hit) return hit;

      const res = await chrome.runtime.sendMessage({
        type: "previewLink",
        url: href,
        kind,
      });
      if (!res?.ok) {
        const fallback = {
          ok: false,
          url: href,
          kind,
          title: href,
          description: res?.error || "Preview unavailable",
          image: "",
          contentType: "",
        };
        return fallback;
      }
      PreviewApi.#cache.set(key, res);
      return res;
    }
  }

  /** Floating preview peek — light, compact, content-first. */
  class PreviewCard {
    static #ROOT_ID = "gosafe-link-preview";
    static #STYLE_ID = "gosafe-link-preview-css";

    static #injectCss() {
      if (document.getElementById(PreviewCard.#STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = PreviewCard.#STYLE_ID;
      style.textContent = `
#${PreviewCard.#ROOT_ID} {
  --glp-bg: #fbfaf7;
  --glp-ink: #1c1917;
  --glp-muted: #78716c;
  --glp-line: #e7e5e4;
  --glp-accent: #0f766e;
  position: fixed !important;
  z-index: 2147483646 !important;
  width: min(360px, calc(100vw - 20px)) !important;
  max-height: min(420px, calc(100vh - 20px)) !important;
  overflow: hidden !important;
  border-radius: 10px !important;
  background: var(--glp-bg) !important;
  color: var(--glp-ink) !important;
  box-shadow: 0 12px 40px rgba(28, 25, 23, 0.18), 0 0 0 1px var(--glp-line) !important;
  font-family: "Segoe UI", "Helvetica Neue", sans-serif !important;
  font-size: 13px !important;
  line-height: 1.45 !important;
  pointer-events: auto !important;
  display: none !important;
}
#${PreviewCard.#ROOT_ID}.is-open {
  display: flex !important;
  flex-direction: column !important;
}
#${PreviewCard.#ROOT_ID} .glp-top {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 10px 12px 0 !important;
  min-width: 0 !important;
}
#${PreviewCard.#ROOT_ID} .glp-favicon {
  width: 16px !important;
  height: 16px !important;
  border-radius: 3px !important;
  flex: 0 0 auto !important;
  background: #fff !important;
  object-fit: contain !important;
}
#${PreviewCard.#ROOT_ID} .glp-host {
  margin: 0 !important;
  color: var(--glp-muted) !important;
  font-size: 12px !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}
#${PreviewCard.#ROOT_ID} .glp-kind {
  margin-left: auto !important;
  color: var(--glp-muted) !important;
  font-size: 11px !important;
  letter-spacing: 0.02em !important;
  flex: 0 0 auto !important;
}
#${PreviewCard.#ROOT_ID} .glp-body {
  padding: 8px 12px 10px !important;
  min-width: 0 !important;
}
#${PreviewCard.#ROOT_ID} .glp-title {
  margin: 0 !important;
  font-family: Georgia, "Times New Roman", serif !important;
  font-size: 16px !important;
  font-weight: 600 !important;
  line-height: 1.3 !important;
  color: var(--glp-ink) !important;
  display: -webkit-box !important;
  -webkit-line-clamp: 2 !important;
  -webkit-box-orient: vertical !important;
  overflow: hidden !important;
}
#${PreviewCard.#ROOT_ID} .glp-desc {
  margin: 6px 0 0 !important;
  color: var(--glp-muted) !important;
  font-size: 12.5px !important;
  display: -webkit-box !important;
  -webkit-line-clamp: 3 !important;
  -webkit-box-orient: vertical !important;
  overflow: hidden !important;
}
#${PreviewCard.#ROOT_ID} .glp-row {
  display: grid !important;
  grid-template-columns: 72px 1fr !important;
  gap: 10px !important;
  align-items: start !important;
}
#${PreviewCard.#ROOT_ID} .glp-thumb {
  width: 72px !important;
  height: 72px !important;
  border-radius: 6px !important;
  object-fit: cover !important;
  background: #f5f5f4 !important;
  border: 1px solid var(--glp-line) !important;
}
#${PreviewCard.#ROOT_ID} .glp-stage {
  margin: 0 12px 10px !important;
  border-radius: 8px !important;
  overflow: hidden !important;
  border: 1px solid var(--glp-line) !important;
  background: #f5f5f4 !important;
  min-height: 0 !important;
}
#${PreviewCard.#ROOT_ID} .glp-stage iframe,
#${PreviewCard.#ROOT_ID} .glp-stage img,
#${PreviewCard.#ROOT_ID} .glp-stage video {
  display: block !important;
  width: 100% !important;
  height: 220px !important;
  border: 0 !important;
  background: #fff !important;
  object-fit: contain !important;
  pointer-events: auto !important;
}
#${PreviewCard.#ROOT_ID} .glp-stage.is-doc iframe,
#${PreviewCard.#ROOT_ID} .glp-stage.is-pdf iframe,
#${PreviewCard.#ROOT_ID} .glp-stage.is-live iframe {
  height: 280px !important;
  /* Native iframe scrolling — no CSS scale (scale breaks wheel hit-testing). */
  transform: none !important;
  position: relative !important;
  inset: auto !important;
  pointer-events: auto !important;
  touch-action: pan-y !important;
}
#${PreviewCard.#ROOT_ID} .glp-stage.is-live,
#${PreviewCard.#ROOT_ID} .glp-stage.is-pdf,
#${PreviewCard.#ROOT_ID} .glp-stage.is-doc {
  height: auto !important;
  overflow: hidden !important;
}
#${PreviewCard.#ROOT_ID} .glp-loading {
  padding: 18px 12px !important;
  color: var(--glp-muted) !important;
  text-align: center !important;
  font-size: 12px !important;
}
#${PreviewCard.#ROOT_ID} .glp-foot {
  display: flex !important;
  justify-content: flex-end !important;
  gap: 10px !important;
  padding: 0 12px 10px !important;
}
#${PreviewCard.#ROOT_ID} .glp-open {
  color: var(--glp-accent) !important;
  text-decoration: none !important;
  font-size: 12px !important;
  font-weight: 600 !important;
}
#${PreviewCard.#ROOT_ID} .glp-open:hover { text-decoration: underline !important; }
`.trim();
      (document.documentElement || document.head).appendChild(style);
    }

    /** @returns {HTMLElement} */
    static root() {
      PreviewCard.#injectCss();
      let el = document.getElementById(PreviewCard.#ROOT_ID);
      if (!(el instanceof HTMLElement)) {
        el = document.createElement("div");
        el.id = PreviewCard.#ROOT_ID;
        el.setAttribute("role", "dialog");
        el.setAttribute("aria-label", "Link preview");
        (document.documentElement || document.body).appendChild(el);

        el.addEventListener("mouseenter", () => LinkPreviewController.pin());
        el.addEventListener("mouseleave", () => LinkPreviewController.unpinSoon());
        el.addEventListener(
          "wheel",
          (event) => {
            // Keep page from scrolling away while user scrolls the preview iframe.
            event.stopPropagation();
          },
          { passive: true, capture: true }
        );
        // Focus iframe on enter so keyboard/trackpad scroll targets it.
        el.addEventListener(
          "mouseenter",
          () => {
            const frame = el.querySelector("iframe");
            try {
              frame?.focus?.({ preventScroll: true });
            } catch {
              // ignore
            }
          },
          true
        );
      }
      return el;
    }

    static hide() {
      const el = document.getElementById(PreviewCard.#ROOT_ID);
      if (el) {
        el.classList.remove("is-open");
        el.innerHTML = "";
      }
    }

    /**
     * @param {MouseEvent | { clientX: number, clientY: number }} ev
     * @param {HTMLElement} card
     */
    static place(ev, card) {
      const pad = 10;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Offset beside the cursor — never cover the link (that steals hover and auto-hides).
      const rect = card.getBoundingClientRect();
      let left = ev.clientX + 16;
      let top = ev.clientY + 16;
      if (left + rect.width > vw - pad) left = Math.max(pad, ev.clientX - rect.width - 16);
      if (top + rect.height > vh - pad) top = Math.max(pad, vh - rect.height - pad);
      if (left < pad) left = pad;
      if (top < pad) top = pad;
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    }

    /**
     * @param {object} meta
     * @param {{ href: string, kind: string, host: string }} target
     * @param {MouseEvent | { clientX: number, clientY: number }} ev
     */
    static render(meta, target, ev) {
      const card = PreviewCard.root();
      const title = String(meta.title || target.host || "Preview").slice(0, 140);
      const desc = String(meta.description || "").slice(0, 220);
      const kindLabel =
        target.kind === "pdf"
          ? "PDF"
          : target.kind === "doc"
            ? "Document"
            : target.kind === "image"
              ? "Image"
              : target.kind === "media"
                ? "Media"
                : "Page";
      const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
        target.host
      )}&sz=32`;
      const isLoading = title === "Loading…";

      let media = "";
      if (isLoading) {
        media = `<div class="glp-loading">Fetching preview…</div>`;
      } else if (target.kind === "image" || (meta.contentType || "").startsWith("image/")) {
        media = `<div class="glp-stage"><img src="${PreviewCard.#escAttr(
          target.href
        )}" alt="" loading="lazy" referrerpolicy="no-referrer" /></div>`;
      } else if (target.kind === "pdf" || (meta.contentType || "").includes("pdf")) {
        media = `<div class="glp-stage is-pdf"><iframe src="${PreviewCard.#escAttr(
          target.href
        )}#toolbar=0" title="PDF preview" scrolling="yes" tabindex="0"></iframe></div>`;
      } else if (target.kind === "doc") {
        const gview = `https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(target.href)}`;
        media = `<div class="glp-stage is-doc"><iframe src="${PreviewCard.#escAttr(
          gview
        )}" title="Document preview" scrolling="yes" tabindex="0"></iframe></div>`;
      } else if (target.kind === "media") {
        const isVideo = /\.(mp4|webm|ogg|mov)(?:$|[?#])/i.test(target.href);
        media = `<div class="glp-stage">${
          isVideo
            ? `<video src="${PreviewCard.#escAttr(target.href)}" controls muted playsinline></video>`
            : `<audio src="${PreviewCard.#escAttr(target.href)}" controls style="width:100%;padding:12px"></audio>`
        }</div>`;
      } else if (meta.frameOk) {
        media = `<div class="glp-stage is-live"><iframe sandbox="allow-scripts allow-same-origin allow-popups-to-escape-sandbox" src="${PreviewCard.#escAttr(
          target.href
        )}" title="Page preview" scrolling="yes" tabindex="0"></iframe></div>`;
      }

      const hasThumb = Boolean(meta.image) && target.kind === "page" && !meta.frameOk;
      const body = hasThumb
        ? `<div class="glp-body"><div class="glp-row">
            <img class="glp-thumb" src="${PreviewCard.#escAttr(meta.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
            <div>
              <p class="glp-title">${PreviewCard.#esc(title)}</p>
              ${desc ? `<p class="glp-desc">${PreviewCard.#esc(desc)}</p>` : ""}
            </div>
          </div></div>`
        : `<div class="glp-body">
            <p class="glp-title">${PreviewCard.#esc(title)}</p>
            ${desc && !media ? `<p class="glp-desc">${PreviewCard.#esc(desc)}</p>` : ""}
            ${desc && media && target.kind === "page" ? `<p class="glp-desc">${PreviewCard.#esc(desc)}</p>` : ""}
          </div>`;

      card.innerHTML = `
        <div class="glp-top">
          <img class="glp-favicon" src="${PreviewCard.#escAttr(favicon)}" alt="" width="16" height="16" />
          <p class="glp-host">${PreviewCard.#esc(target.host)}</p>
          <span class="glp-kind">${PreviewCard.#esc(kindLabel)}</span>
        </div>
        ${body}
        ${media}
        <div class="glp-foot">
          <a class="glp-open" href="${PreviewCard.#escAttr(
            target.href
          )}" target="_blank" rel="noopener noreferrer">Open link</a>
        </div>
      `;
      card.classList.add("is-open");
      PreviewCard.place(ev, card);
    }

    static #esc(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    static #escAttr(s) {
      return PreviewCard.#esc(s).replace(/'/g, "&#39;");
    }
  }

  class LinkPreviewController {
    static #timer = 0;
    static #hideTimer = 0;
    static #pinned = false;
    static #token = 0;
    static #lastHref = "";
    /** @type {HTMLAnchorElement | null} */
    static #activeAnchor = null;

    static pin() {
      LinkPreviewController.#pinned = true;
      window.clearTimeout(LinkPreviewController.#hideTimer);
    }

    static unpinSoon() {
      LinkPreviewController.#pinned = false;
      LinkPreviewController.scheduleHide();
    }

    static scheduleHide() {
      window.clearTimeout(LinkPreviewController.#hideTimer);
      LinkPreviewController.#hideTimer = window.setTimeout(() => {
        if (!LinkPreviewController.#pinned) {
          LinkPreviewController.#activeAnchor = null;
          PreviewCard.hide();
        }
      }, 280);
    }

    /**
     * @param {HTMLAnchorElement} a
     * @param {MouseEvent} ev
     */
    static async showFor(a, ev) {
      if (!FeatureGate.on()) return;
      const target = LinkKind.parse(a.href);
      if (!target) return;

      const token = ++LinkPreviewController.#token;
      LinkPreviewController.#lastHref = target.href;
      LinkPreviewController.#activeAnchor = a;

      const loadingEv = { clientX: ev.clientX, clientY: ev.clientY };
      PreviewCard.render(
        {
          kind: target.kind,
          title: "Loading…",
          description: target.href,
          image: "",
          contentType: "",
          frameOk: false,
        },
        target,
        loadingEv
      );

      let meta;
      try {
        meta = await PreviewApi.fetchMeta(target.href, target.kind);
      } catch {
        meta = {
          ok: false,
          kind: target.kind,
          title: target.host,
          description: "Preview failed",
          image: "",
          contentType: "",
          frameOk: false,
        };
      }
      if (token !== LinkPreviewController.#token) return;
      if (LinkPreviewController.#lastHref !== target.href) return;
      // User already left the link/card — don't flash a late result.
      if (!LinkPreviewController.#activeAnchor) return;
      PreviewCard.render({ ...meta, kind: target.kind }, target, loadingEv);
    }

    /** @param {MouseEvent} ev */
    static onOver(ev) {
      if (!FeatureGate.on()) return;
      const a = ev.target instanceof Element ? ev.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.closest?.(`#${PreviewCard.root().id}`)) return;

      window.clearTimeout(LinkPreviewController.#timer);
      window.clearTimeout(LinkPreviewController.#hideTimer);
      LinkPreviewController.#activeAnchor = a;
      const x = ev.clientX;
      const y = ev.clientY;
      LinkPreviewController.#timer = window.setTimeout(() => {
        const fake = { clientX: x, clientY: y };
        LinkPreviewController.showFor(a, /** @type {MouseEvent} */ (fake)).catch(() => {});
      }, 450);
    }

    /** @param {MouseEvent} ev */
    static onOut(ev) {
      const to = ev.relatedTarget;
      if (to instanceof Node && PreviewCard.root().contains(to)) return;
      if (
        to instanceof Node &&
        LinkPreviewController.#activeAnchor &&
        LinkPreviewController.#activeAnchor.contains(to)
      ) {
        return;
      }
      window.clearTimeout(LinkPreviewController.#timer);
      LinkPreviewController.unpinSoon();
    }

    static start() {
      if (window !== window.top) return;
      document.addEventListener("mouseover", (ev) => LinkPreviewController.onOver(ev), true);
      document.addEventListener("mouseout", (ev) => LinkPreviewController.onOut(ev), true);
      document.addEventListener(
        "keydown",
        (ev) => {
          if (ev.key === "Escape") PreviewCard.hide();
        },
        true
      );
      window.addEventListener(
        "scroll",
        (ev) => {
          const card = document.getElementById("gosafe-link-preview");
          const t = ev.target;
          if (
            card?.classList.contains("is-open") &&
            t instanceof Node &&
            (card === t || card.contains(t))
          ) {
            return;
          }
          PreviewCard.hide();
        },
        true
      );
    }
  }

  LinkPreviewController.start();
})();
