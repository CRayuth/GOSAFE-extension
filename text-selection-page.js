(() => {
  "use strict";

  /**
   * Text selection toolkit — highlight, translate, notes, and QCM answer (NVIDIA).
   */
  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return false;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-gosafe-text-selection") !== "off";
    }
  }

  const LANGS = Object.freeze([
    { code: "auto", label: "Detect language", flag: "🌐" },
    { code: "en", label: "English", flag: "🇬🇧" },
    { code: "km", label: "Khmer", flag: "🇰🇭" },
    { code: "zh-CN", label: "Chinese", flag: "🇨🇳" },
    { code: "ja", label: "Japanese", flag: "🇯🇵" },
    { code: "ko", label: "Korean", flag: "🇰🇷" },
    { code: "th", label: "Thai", flag: "🇹🇭" },
    { code: "vi", label: "Vietnamese", flag: "🇻🇳" },
    { code: "fr", label: "French", flag: "🇫🇷" },
    { code: "es", label: "Spanish", flag: "🇪🇸" },
    { code: "de", label: "German", flag: "🇩🇪" },
    { code: "pt", label: "Portuguese", flag: "🇵🇹" },
    { code: "ru", label: "Russian", flag: "🇷🇺" },
    { code: "ar", label: "Arabic", flag: "🇸🇦" },
    { code: "hi", label: "Hindi", flag: "🇮🇳" },
    { code: "id", label: "Indonesian", flag: "🇮🇩" },
  ]);

  /** @param {{ code: string, label: string, flag?: string }} lang */
  function langOptionLabel(lang) {
    return `${lang.flag ? `${lang.flag} ` : ""}${lang.label}`;
  }

  const COLORS = Object.freeze([
    { id: "yellow", value: "#fde047" },
    { id: "green", value: "#86efac" },
    { id: "sky", value: "#7dd3fc" },
    { id: "peach", value: "#fdba74" },
    { id: "rose", value: "#fda4af" },
    { id: "lilac", value: "#c4b5fd" },
  ]);

  class PageKey {
    static current() {
      try {
        const u = new URL(location.href);
        u.hash = "";
        return u.href;
      } catch {
        return location.href.split("#")[0];
      }
    }
  }

  class HighlightStore {
    static #KEY = "selectionHighlights";
    static #PREF = "selectionLangPrefs";

    static async loadForPage() {
      const page = PageKey.current();
      const raw = await chrome.storage.local.get({ [HighlightStore.#KEY]: {} });
      const map =
        raw[HighlightStore.#KEY] && typeof raw[HighlightStore.#KEY] === "object"
          ? raw[HighlightStore.#KEY]
          : {};
      const list = Array.isArray(map[page]) ? map[page] : [];
      return list.filter((h) => h && h.id && h.text);
    }

    /** @param {object[]} list */
    static async saveForPage(list) {
      const page = PageKey.current();
      const raw = await chrome.storage.local.get({ [HighlightStore.#KEY]: {} });
      const map = { ...(raw[HighlightStore.#KEY] || {}) };
      map[page] = list.slice(0, 200);
      const keys = Object.keys(map);
      if (keys.length > 80) {
        for (const k of keys.slice(0, keys.length - 80)) delete map[k];
      }
      await chrome.storage.local.set({ [HighlightStore.#KEY]: map });
    }

    static async prefs() {
      const raw = await chrome.storage.local.get({
        [HighlightStore.#PREF]: { from: "auto", to: "en", color: COLORS[0].value },
      });
      const p = raw[HighlightStore.#PREF] || {};
      return {
        from: String(p.from || "auto"),
        to: String(p.to || "en"),
        color: String(p.color || COLORS[0].value),
      };
    }

    /** @param {{ from?: string, to?: string, color?: string }} patch */
    static async setPrefs(patch) {
      const cur = await HighlightStore.prefs();
      await chrome.storage.local.set({
        [HighlightStore.#PREF]: {
          from: String(patch.from ?? cur.from),
          to: String(patch.to ?? cur.to),
          color: String(patch.color ?? cur.color),
        },
      });
    }
  }

  class Translator {
    /**
     * @param {string} text
     * @param {string} from
     * @param {string} to
     */
    static async translate(text, from, to) {
      try {
        if (!chrome?.runtime?.id) {
          return {
            ok: false,
            text: "",
            detected: from,
            segments: [],
            error: "Refresh this page — extension was reloaded",
          };
        }
        const res = await chrome.runtime.sendMessage({
          type: "translateSelection",
          text,
          from,
          to,
        });
        if (!res || res.ok === false) {
          return {
            ok: false,
            text: "",
            detected: from,
            segments: [],
            error: res?.error || "failed",
          };
        }
        const segments = Array.isArray(res.segments)
          ? res.segments
              .map((s) => ({
                src: String(s?.src || ""),
                dst: String(s?.dst || ""),
              }))
              .filter((s) => s.src || s.dst)
          : [];
        return {
          ok: true,
          text: String(res.text || ""),
          detected: String(res.detected || from),
          segments:
            segments.length > 0
              ? segments
              : [{ src: text, dst: String(res.text || "") }],
        };
      } catch (err) {
        const msg = String(err?.message || err);
        return {
          ok: false,
          text: "",
          detected: from,
          segments: [],
          error: /invalidated/i.test(msg)
            ? "Refresh this page — extension was reloaded"
            : msg,
        };
      }
    }
  }

  class DomHighlight {
    static #CLS = "gosafe-sel-hl";
    static #ATTR = "data-gosafe-hl-id";

    /** @param {string} id */
    static find(id) {
      return document.querySelector(
        `mark.${DomHighlight.#CLS}[${DomHighlight.#ATTR}="${CSS.escape(id)}"]`
      );
    }

    /** @param {Range} range @param {object} item */
    static wrap(range, item) {
      try {
        if (range.collapsed) return null;
        const mark = DomHighlight.#makeMark(item);
        range.surroundContents(mark);
        return mark;
      } catch {
        return DomHighlight.applyByText(item);
      }
    }

    /** @param {object} item */
    static #makeMark(item) {
      const mark = document.createElement("mark");
      mark.className = DomHighlight.#CLS;
      mark.setAttribute(DomHighlight.#ATTR, item.id);
      mark.style.setProperty("--ghl", item.color || COLORS[0].value);
      mark.style.cursor = "pointer";
      if (item.note) mark.title = item.note;
      return mark;
    }

    /** @param {object} item */
    static applyByText(item) {
      if (DomHighlight.find(item.id)) return DomHighlight.find(item.id);
      const needle = String(item.text || "").trim();
      if (!needle || needle.length < 2) return null;

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      /** @type {Text | null} */
      let node = /** @type {Text | null} */ (walker.nextNode());
      while (node) {
        if (node.parentElement?.closest?.(`#${SelectionUI.ROOT_ID}, .${DomHighlight.#CLS}`)) {
          node = /** @type {Text | null} */ (walker.nextNode());
          continue;
        }
        const idx = node.data.indexOf(needle);
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + needle.length);
          try {
            const mark = DomHighlight.#makeMark(item);
            range.surroundContents(mark);
            return mark;
          } catch {
            // keep looking
          }
        }
        node = /** @type {Text | null} */ (walker.nextNode());
      }
      return null;
    }

    /** @param {string} id */
    static unwrap(id) {
      const mark = DomHighlight.find(id);
      if (!mark) return;
      const parent = mark.parentNode;
      while (mark.firstChild) parent?.insertBefore(mark.firstChild, mark);
      mark.remove();
      parent?.normalize?.();
    }

    /** @param {object} item */
    static update(item) {
      const mark = DomHighlight.find(item.id);
      if (!mark) return;
      mark.style.setProperty("--ghl", item.color || COLORS[0].value);
      mark.title = item.note || "";
    }
  }

  class SelectionUI {
    static ROOT_ID = "gosafe-text-selection";
    static #STYLE_ID = "gosafe-text-selection-css";

    static #injectCss() {
      let style = document.getElementById(SelectionUI.#STYLE_ID);
      if (!(style instanceof HTMLStyleElement)) {
        style = document.createElement("style");
        style.id = SelectionUI.#STYLE_ID;
        (document.documentElement || document.head).appendChild(style);
      }
      style.textContent = `
#${SelectionUI.ROOT_ID} {
  --gts-bg: #002870;
  --gts-bg2: #0058d0;
  --gts-ink: #f4f7fc;
  --gts-muted: #c8d8f0;
  --gts-line: rgba(255,255,255,0.18);
  --gts-accent: #8eb6f0;
  --gts-panel: #0a1f45;
  position: fixed !important;
  z-index: 2147483646 !important;
  display: none !important;
  flex-direction: column !important;
  align-items: stretch !important;
  gap: 6px !important;
  max-width: min(360px, calc(100vw - 16px)) !important;
  font-family: "Segoe UI", "Helvetica Neue", sans-serif !important;
  font-size: 12.5px !important;
  line-height: 1.35 !important;
  pointer-events: auto !important;
  filter: drop-shadow(0 10px 28px rgba(0, 40, 112, 0.35));
}
#${SelectionUI.ROOT_ID}.is-open { display: flex !important; }
#${SelectionUI.ROOT_ID} * { box-sizing: border-box !important; }
#${SelectionUI.ROOT_ID} .gts-bar {
  display: flex !important;
  align-items: center !important;
  gap: 2px !important;
  padding: 5px 6px !important;
  border-radius: 999px !important;
  background: linear-gradient(135deg, var(--gts-bg) 0%, var(--gts-bg2) 100%) !important;
  color: var(--gts-ink) !important;
  border: 1px solid var(--gts-line) !important;
}
#${SelectionUI.ROOT_ID} .gts-swatch {
  width: 18px !important;
  height: 18px !important;
  margin: 0 2px !important;
  border-radius: 999px !important;
  border: 2px solid transparent !important;
  background: var(--sw) !important;
  cursor: pointer !important;
  padding: 0 !important;
  flex: 0 0 auto !important;
}
#${SelectionUI.ROOT_ID} .gts-swatch:hover { transform: scale(1.12); }
#${SelectionUI.ROOT_ID} .gts-swatch.is-on {
  border-color: #fff !important;
  box-shadow: 0 0 0 1px rgba(0, 40, 112, 0.45) !important;
}
#${SelectionUI.ROOT_ID} .gts-sep {
  width: 1px !important;
  height: 16px !important;
  margin: 0 4px !important;
  background: var(--gts-line) !important;
  flex: 0 0 auto !important;
}
#${SelectionUI.ROOT_ID} .gts-icon {
  appearance: none !important;
  border: 0 !important;
  background: transparent !important;
  color: var(--gts-ink) !important;
  width: 30px !important;
  height: 28px !important;
  border-radius: 999px !important;
  cursor: pointer !important;
  font: inherit !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  padding: 0 !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
}
#${SelectionUI.ROOT_ID} .gts-icon:hover {
  background: rgba(255,255,255,0.16) !important;
}
#${SelectionUI.ROOT_ID} .gts-icon.is-on {
  background: rgba(255,255,255,0.22) !important;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.35) !important;
}
#${SelectionUI.ROOT_ID} .gts-icon.danger:hover { background: rgba(198, 40, 40, 0.35) !important; }
#${SelectionUI.ROOT_ID} .gts-sheet {
  display: none !important;
  padding: 10px 12px !important;
  border-radius: 14px !important;
  background: linear-gradient(160deg, var(--gts-panel) 0%, var(--gts-bg) 100%) !important;
  color: var(--gts-ink) !important;
  border: 1px solid var(--gts-line) !important;
  min-width: 260px !important;
}
#${SelectionUI.ROOT_ID} .gts-sheet.is-show { display: block !important; }
#${SelectionUI.ROOT_ID} .gts-lang {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  margin-bottom: 8px !important;
}
#${SelectionUI.ROOT_ID} select {
  flex: 1 !important;
  min-width: 0 !important;
  border: 1px solid var(--gts-line) !important;
  border-radius: 8px !important;
  background: rgba(0, 88, 208, 0.35) !important;
  color: var(--gts-ink) !important;
  padding: 6px 8px !important;
  font: inherit !important;
  font-size: 12px !important;
  outline: none !important;
}
#${SelectionUI.ROOT_ID} .gts-swap {
  flex: 0 0 auto !important;
  width: 30px !important;
  height: 30px !important;
  border: 0 !important;
  border-radius: 999px !important;
  background: transparent !important;
  color: var(--gts-ink) !important;
  cursor: pointer !important;
  font-size: 14px !important;
  font-weight: 600 !important;
  padding: 0 !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
}
#${SelectionUI.ROOT_ID} .gts-swap:hover {
  background: rgba(255,255,255,0.16) !important;
}
#${SelectionUI.ROOT_ID} .gts-out {
  margin: 0 0 8px !important;
  min-height: 36px !important;
  max-height: 120px !important;
  overflow: auto !important;
  padding: 8px 10px !important;
  border-radius: 10px !important;
  background: rgba(0, 40, 112, 0.55) !important;
  color: var(--gts-muted) !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  resize: vertical !important;
}
#${SelectionUI.ROOT_ID}.is-expanded {
  max-width: min(520px, calc(100vw - 16px)) !important;
}
#${SelectionUI.ROOT_ID}.is-expanded .gts-out {
  max-height: min(62vh, 520px) !important;
  min-height: 200px !important;
}
#${SelectionUI.ROOT_ID}.is-expanded .gts-sheet {
  min-width: 300px !important;
}
#${SelectionUI.ROOT_ID} .gts-out.ready { color: var(--gts-ink) !important; }
#${SelectionUI.ROOT_ID} .gts-out-label {
  display: block !important;
  margin: 0 0 4px !important;
  color: var(--gts-muted) !important;
  font-size: 10px !important;
  font-weight: 700 !important;
  letter-spacing: 0.04em !important;
  text-transform: uppercase !important;
}
#${SelectionUI.ROOT_ID} .gts-qcm-answer {
  margin: 0 !important;
  font: 800 15px/1.35 "Segoe UI", sans-serif !important;
  color: #002870 !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
}
#${SelectionUI.ROOT_ID} .gts-qcm-reason {
  margin: 6px 0 0 !important;
  font: 500 11px/1.35 "Segoe UI", sans-serif !important;
  color: rgba(10, 31, 68, 0.7) !important;
}
#${SelectionUI.ROOT_ID} .gts-seg {
  border-radius: 3px !important;
  cursor: pointer !important;
  transition: background 0.12s ease !important;
}
#${SelectionUI.ROOT_ID} .gts-seg:hover {
  background: rgba(142, 182, 240, 0.28) !important;
}
#${SelectionUI.ROOT_ID} .gts-seg.is-on {
  background: rgba(253, 224, 71, 0.55) !important;
  color: #fff !important;
  box-shadow: 0 0 0 1px rgba(253, 224, 71, 0.7) !important;
}
#${SelectionUI.ROOT_ID} .gts-meta {
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
  gap: 8px !important;
  margin-top: 8px !important;
  color: var(--gts-muted) !important;
  font-size: 11px !important;
}
#${SelectionUI.ROOT_ID} .gts-meta span { flex: 1 !important; min-width: 0 !important; }
#${SelectionUI.ROOT_ID} .gts-meta button {
  border: 0 !important;
  background: transparent !important;
  color: #b8d4ff !important;
  font: inherit !important;
  font-weight: 600 !important;
  cursor: pointer !important;
  padding: 0 !important;
  flex: 0 0 auto !important;
}
#${SelectionUI.ROOT_ID} .gts-note-row {
  display: flex !important;
  gap: 6px !important;
}
#${SelectionUI.ROOT_ID} input[type="text"] {
  flex: 1 !important;
  min-width: 0 !important;
  border: 1px solid var(--gts-line) !important;
  border-radius: 8px !important;
  background: rgba(0, 40, 112, 0.55) !important;
  color: var(--gts-ink) !important;
  padding: 8px 10px !important;
  font: inherit !important;
  outline: none !important;
}
#${SelectionUI.ROOT_ID} .gts-save {
  border: 0 !important;
  border-radius: 8px !important;
  background: #0058d0 !important;
  color: #fff !important;
  font: inherit !important;
  font-weight: 700 !important;
  padding: 0 12px !important;
  cursor: pointer !important;
}
mark.gosafe-sel-hl {
  background: color-mix(in srgb, var(--ghl, #fde047) 72%, transparent) !important;
  color: inherit !important;
  border-radius: 2px !important;
  padding: 0 1px !important;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  cursor: pointer !important;
}
`.trim();
    }

    /** @returns {HTMLElement} */
    static root() {
      SelectionUI.#injectCss();
      let el = document.getElementById(SelectionUI.ROOT_ID);
      if (!(el instanceof HTMLElement)) {
        el = document.createElement("div");
        el.id = SelectionUI.ROOT_ID;
        el.setAttribute("role", "toolbar");
        el.setAttribute("aria-label", "Selection tools");
        (document.documentElement || document.body).appendChild(el);
        el.addEventListener("mousedown", (ev) => ev.stopPropagation());
        el.addEventListener("mouseup", (ev) => ev.stopPropagation());
      }
      return el;
    }

    static hide() {
      const el = document.getElementById(SelectionUI.ROOT_ID);
      if (el) {
        el.classList.remove("is-open", "is-expanded");
        el.innerHTML = "";
      }
    }

    /**
     * @param {DOMRect} anchor
     * @param {HTMLElement} card
     */
    static place(anchor, card) {
      const pad = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      card.classList.add("is-open");
      const rect = card.getBoundingClientRect();
      let left = anchor.left + anchor.width / 2 - rect.width / 2;
      let top = anchor.top - rect.height - 10;
      if (top < pad) top = anchor.bottom + 10;
      if (left < pad) left = pad;
      if (left + rect.width > vw - pad) left = Math.max(pad, vw - rect.width - pad);
      if (top + rect.height > vh - pad) top = Math.max(pad, vh - rect.height - pad);
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    }

    static #esc(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    /**
     * @param {{
     *   mode: "create" | "edit",
     *   color: string,
     *   note: string,
     *   from: string,
     *   to: string,
     *   panel: "" | "translate" | "note" | "qcm",
     *   translated: string,
     *   original: string,
     *   segments: { src: string, dst: string }[],
     *   activeSeg: number,
     *   expanded: boolean,
     *   translating: boolean,
     *   qcmAnswer: string,
     *   qcmReason: string,
     *   qcmBusy: boolean,
     *   anchor: DOMRect,
     * }} state
     * @param {object} handlers
     */
    static render(state, handlers) {
      const card = SelectionUI.root();
      card.classList.toggle("is-expanded", Boolean(state.expanded));
      const isEdit = state.mode === "edit";
      const swatches = COLORS.map(
        (c) =>
          `<button type="button" class="gts-swatch ${
            c.value === state.color ? "is-on" : ""
          }" data-color="${c.value}" style="--sw:${c.value}" title="Highlight ${c.id}" aria-label="${c.id}"></button>`
      ).join("");

      const langOpts = (selected, allowAuto) =>
        LANGS.filter((l) => allowAuto || l.code !== "auto")
          .map(
            (l) =>
              `<option value="${l.code}" ${l.code === selected ? "selected" : ""}>${langOptionLabel(
                l
              )}</option>`
          )
          .join("");

      const segs = Array.isArray(state.segments) ? state.segments : [];
      const ready = Boolean(state.translated) && !state.translating && segs.length > 0;

      const renderDstSegs = () => {
        if (state.translating) return SelectionUI.#esc("Translating…");
        if (!ready) {
          return SelectionUI.#esc(
            state.translated || "Pick languages — translation starts automatically"
          );
        }
        return segs
          .map((s, i) => {
            const text = s.dst;
            if (!text) return "";
            return `<span class="gts-seg ${
              i === state.activeSeg ? "is-on" : ""
            }" data-seg="${i}">${SelectionUI.#esc(text)}</span>`;
          })
          .join("");
      };

      const qcmBody = () => {
        if (state.qcmBusy) return `<p class="gts-qcm-answer">${SelectionUI.#esc("Asking NVIDIA…")}</p>`;
        if (state.qcmAnswer) {
          return `
            <span class="gts-out-label">Answer</span>
            <p class="gts-qcm-answer">${SelectionUI.#esc(state.qcmAnswer)}</p>
            ${
              state.qcmReason
                ? `<p class="gts-qcm-reason">${SelectionUI.#esc(state.qcmReason)}</p>`
                : ""
            }
          `;
        }
        return `<p class="gts-qcm-answer">${SelectionUI.#esc(
          "Select the question + options, then tap QCM"
        )}</p>`;
      };

      card.innerHTML = `
        <div class="gts-bar">
          ${swatches}
          <span class="gts-sep"></span>
          <button type="button" class="gts-icon ${
            state.panel === "translate" ? "is-on" : ""
          }" data-act="translate" title="Translate">文A</button>
          <button type="button" class="gts-icon ${
            state.panel === "qcm" ? "is-on" : ""
          }" data-act="qcm" title="Answer QCM (NVIDIA)">QCM</button>
          <button type="button" class="gts-icon ${
            state.panel === "note" ? "is-on" : ""
          }" data-act="note" title="Keyword note">✎</button>
          ${
            isEdit
              ? `<button type="button" class="gts-icon danger" data-act="delete" title="Delete highlight">✕</button>`
              : ""
          }
        </div>
        <div class="gts-sheet ${state.panel === "translate" ? "is-show" : ""}" data-sheet="translate">
          <div class="gts-lang">
            <select data-role="from" aria-label="From">${langOpts(state.from, true)}</select>
            <button type="button" class="gts-icon gts-swap" data-act="swap" title="Switch languages">⇄</button>
            <select data-role="to" aria-label="To">${langOpts(state.to, false)}</select>
          </div>
          <p class="gts-out ${ready || (state.translated && !state.translating) ? "ready" : ""}" data-role="out">${renderDstSegs()}</p>
          <div class="gts-meta">
            <span data-role="hint">${
              ready
                ? state.activeSeg >= 0
                  ? "Matched on page"
                  : "Click or select a phrase to find it on the page"
                : state.translated
                  ? "Google Translate"
                  : ""
            }</span>
            <button type="button" data-act="expand">${state.expanded ? "Collapse" : "Expand"}</button>
            <button type="button" data-act="copy" ${state.translated ? "" : "hidden"}>Copy</button>
          </div>
        </div>
        <div class="gts-sheet ${state.panel === "qcm" ? "is-show" : ""}" data-sheet="qcm">
          <div class="gts-out ready" data-role="qcm-out">${qcmBody()}</div>
          <div class="gts-meta">
            <span>${state.qcmBusy ? "NVIDIA…" : state.qcmAnswer ? "NVIDIA Quiz Assist" : ""}</span>
            <button type="button" data-act="qcm-again" ${state.qcmBusy ? "disabled" : ""}>Ask again</button>
            <button type="button" data-act="copy-qcm" ${state.qcmAnswer && !state.qcmBusy ? "" : "hidden"}>Copy</button>
          </div>
        </div>
        <div class="gts-sheet ${state.panel === "note" ? "is-show" : ""}" data-sheet="note">
          <div class="gts-note-row">
            <input type="text" data-role="note" maxlength="120" placeholder="Keyword note…" value="${SelectionUI.#esc(
              state.note
            )}" />
            <button type="button" class="gts-save" data-act="save-note">${isEdit ? "Save" : "Add"}</button>
          </div>
        </div>
      `;

      card.querySelectorAll(".gts-swatch").forEach((btn) => {
        btn.addEventListener("click", () => {
          handlers.onColor(btn.getAttribute("data-color") || COLORS[0].value);
        });
      });
      card.querySelector('[data-act="translate"]')?.addEventListener("click", () => {
        handlers.onTogglePanel("translate");
      });
      card.querySelector('[data-act="qcm"]')?.addEventListener("click", () => {
        handlers.onTogglePanel("qcm");
      });
      card.querySelector('[data-act="note"]')?.addEventListener("click", () => {
        handlers.onTogglePanel("note");
      });
      card.querySelector('[data-act="delete"]')?.addEventListener("click", () => {
        handlers.onDelete?.();
      });
      card.querySelector('[data-act="swap"]')?.addEventListener("click", () => {
        handlers.onSwap();
      });
      card.querySelector('[data-act="copy"]')?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(state.translated || "");
          const btn = card.querySelector('[data-act="copy"]');
          if (btn) btn.textContent = "Copied";
        } catch {
          // ignore
        }
      });
      card.querySelector('[data-act="copy-qcm"]')?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(state.qcmAnswer || "");
          const btn = card.querySelector('[data-act="copy-qcm"]');
          if (btn) btn.textContent = "Copied";
        } catch {
          // ignore
        }
      });
      card.querySelector('[data-act="qcm-again"]')?.addEventListener("click", () => {
        handlers.onQcmAgain?.();
      });
      card.querySelector('[data-act="expand"]')?.addEventListener("click", () => {
        handlers.onExpand?.();
      });
      card.querySelector('[data-act="save-note"]')?.addEventListener("click", () => {
        const input = /** @type {HTMLInputElement | null} */ (card.querySelector('[data-role="note"]'));
        handlers.onSaveNote(input?.value.trim() || "");
      });
      const noteInput = /** @type {HTMLInputElement | null} */ (card.querySelector('[data-role="note"]'));
      noteInput?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          handlers.onSaveNote(noteInput.value.trim());
        }
      });
      const fromEl = /** @type {HTMLSelectElement | null} */ (card.querySelector('[data-role="from"]'));
      const toEl = /** @type {HTMLSelectElement | null} */ (card.querySelector('[data-role="to"]'));
      fromEl?.addEventListener("change", () => handlers.onLang(fromEl.value, toEl?.value || state.to));
      toEl?.addEventListener("change", () => handlers.onLang(fromEl?.value || state.from, toEl.value));

      card.querySelectorAll(".gts-seg").forEach((el) => {
        el.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const idx = Number(el.getAttribute("data-seg"));
          if (Number.isFinite(idx)) handlers.onSeg?.(idx);
        });
      });

      const bindMatchSelect = (role) => {
        const box = card.querySelector(`[data-role="${role}"]`);
        if (!box) return;
        box.addEventListener("mouseup", (ev) => {
          ev.stopPropagation();
          window.setTimeout(() => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !box.contains(sel.anchorNode)) return;
            const picked = String(sel.toString() || "").trim();
            if (picked.length < 1) return;
            handlers.onMatchText?.(picked, "dst");
          }, 0);
        });
      };
      bindMatchSelect("out");

      SelectionUI.place(state.anchor, card);
      if (state.panel === "note") {
        noteInput?.focus();
        noteInput?.select();
      }
      // Reposition after sheet opens (height changed)
      requestAnimationFrame(() => SelectionUI.place(state.anchor, card));
    }
  }

  class SelectionController {
    /** @type {object[]} */
    static #items = [];
    /** @type {Range | null} */
    static #savedRange = null;
    /** @type {string} */
    static #draftText = "";
    /** @type {string} */
    static #color = COLORS[0].value;
    /** @type {string} */
    static #from = "auto";
    /** @type {string} */
    static #to = "en";
    /** @type {string} */
    static #translated = "";
    /** @type {{ src: string, dst: string }[]} */
    static #segments = [];
    /** @type {number} */
    static #activeSeg = -1;
    static #expanded = false;
    /** @type {string} */
    static #note = "";
    /** @type {"" | "translate" | "note" | "qcm"} */
    static #panel = "";
    /** @type {string | null} */
    static #editingId = null;
    /** @type {DOMRect | null} */
    static #anchor = null;
    static #open = false;
    static #ignoreCloseUntil = 0;
    static #translating = false;
    static #translateToken = 0;
    static #qcmBusy = false;
    static #qcmToken = 0;
    /** @type {string} */
    static #qcmAnswer = "";
    /** @type {string} */
    static #qcmReason = "";

    static async start() {
      if (window !== window.top) return;
      if (location.protocol !== "http:" && location.protocol !== "https:") return;

      const prefs = await HighlightStore.prefs();
      SelectionController.#from = prefs.from;
      SelectionController.#to = prefs.to === "auto" ? "en" : prefs.to;
      SelectionController.#color =
        COLORS.some((c) => c.value === prefs.color) ? prefs.color : COLORS[0].value;

      SelectionController.#items = await HighlightStore.loadForPage();
      for (const item of SelectionController.#items) {
        DomHighlight.applyByText(item);
      }

      document.addEventListener("mouseup", (ev) => SelectionController.onMouseUp(ev), true);
      document.addEventListener(
        "click",
        (ev) => {
          if (Date.now() < SelectionController.#ignoreCloseUntil) return;
          const t = ev.target;
          if (!(t instanceof Element)) return;
          const mark = t.closest?.("mark.gosafe-sel-hl");
          if (mark instanceof HTMLElement) {
            ev.preventDefault();
            ev.stopPropagation();
            SelectionController.openEdit(mark);
            return;
          }
          if (t.closest?.(`#${SelectionUI.ROOT_ID}`)) return;
          if (SelectionController.#open) SelectionController.close();
        },
        true
      );
      document.addEventListener(
        "keydown",
        (ev) => {
          if (ev.key === "Escape") SelectionController.close();
        },
        true
      );
      window.addEventListener(
        "scroll",
        (ev) => {
          if (!SelectionController.#open) return;
          const t = ev.target;
          if (t instanceof Node && SelectionUI.root().contains(t)) return;
          SelectionController.close();
        },
        true
      );
    }

    /** @param {MouseEvent} ev */
    static onMouseUp(ev) {
      if (!FeatureGate.on()) return;
      if (ev.button !== 0) return;
      const t = ev.target;
      if (t instanceof Element && t.closest(`#${SelectionUI.ROOT_ID}`)) return;
      if (t instanceof Element && t.closest("mark.gosafe-sel-hl")) return;

      window.setTimeout(() => {
        if (!FeatureGate.on()) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount < 1) return;
        const text = String(sel.toString() || "")
          .replace(/\r/g, "")
          .replace(/[^\S\n]+/g, " ")
          .replace(/ *\n */g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        if (text.length < 2 || text.length > 4000) return;
        const range = sel.getRangeAt(0).cloneRange();
        const common = range.commonAncestorContainer;
        const el =
          common.nodeType === Node.ELEMENT_NODE
            ? /** @type {Element} */ (common)
            : common.parentElement;
        if (el?.closest?.(`#${SelectionUI.ROOT_ID}`)) return;

        SelectionController.#savedRange = range;
        SelectionController.#draftText = text;
        SelectionController.#editingId = null;
        SelectionController.#translated = "";
        SelectionController.#segments = [];
        SelectionController.#activeSeg = -1;
        SelectionController.#note = "";
        SelectionController.#panel = "";
        SelectionController.#qcmAnswer = "";
        SelectionController.#qcmReason = "";
        SelectionController.#qcmBusy = false;
        SelectionController.#anchor = range.getBoundingClientRect();
        SelectionController.open();
      }, 10);
    }

    static open() {
      SelectionController.#open = true;
      SelectionController.#ignoreCloseUntil = Date.now() + 350;
      SelectionController.#paint();
    }

    /** @param {HTMLElement} mark */
    static openEdit(mark) {
      const id = mark.getAttribute("data-gosafe-hl-id");
      const item = SelectionController.#items.find((h) => h.id === id);
      if (!item) return;
      SelectionController.#editingId = item.id;
      SelectionController.#draftText = item.text;
      SelectionController.#color = item.color || COLORS[0].value;
      SelectionController.#note = item.note || "";
      SelectionController.#translated = "";
      SelectionController.#segments = [];
      SelectionController.#activeSeg = -1;
      SelectionController.#panel = item.note ? "note" : "";
      SelectionController.#qcmAnswer = "";
      SelectionController.#qcmReason = "";
      SelectionController.#qcmBusy = false;
      SelectionController.#savedRange = null;
      SelectionController.#anchor = mark.getBoundingClientRect();
      SelectionController.open();
    }

    static #paint() {
      if (!SelectionController.#anchor) return;
      const mode = SelectionController.#editingId ? "edit" : "create";
      SelectionUI.render(
        {
          mode,
          color: SelectionController.#color,
          note: SelectionController.#note,
          from: SelectionController.#from,
          to: SelectionController.#to,
          panel: SelectionController.#panel,
          translated: SelectionController.#translated,
          original: SelectionController.#draftText,
          segments: SelectionController.#segments,
          activeSeg: SelectionController.#activeSeg,
          expanded: SelectionController.#expanded,
          translating: SelectionController.#translating,
          qcmAnswer: SelectionController.#qcmAnswer,
          qcmReason: SelectionController.#qcmReason,
          qcmBusy: SelectionController.#qcmBusy,
          anchor: SelectionController.#anchor,
        },
        {
          onColor: (color) => {
            SelectionController.#color = color;
            HighlightStore.setPrefs({ color }).catch(() => {});
            if (SelectionController.#editingId) {
              SelectionController.updateItem(SelectionController.#editingId, { color });
              SelectionController.#paint();
            } else {
              SelectionController.createItem(SelectionController.#note, color);
              SelectionController.close();
            }
          },
          onExpand: () => {
            SelectionController.#expanded = !SelectionController.#expanded;
            SelectionController.#paint();
          },
          onTogglePanel: (name) => {
            SelectionController.#panel =
              SelectionController.#panel === name ? "" : /** @type {any} */ (name);
            SelectionController.#paint();
            if (SelectionController.#panel === "translate") {
              SelectionController.runTranslate();
            }
            if (SelectionController.#panel === "qcm") {
              SelectionController.runQcm();
            }
          },
          onQcmAgain: () => {
            SelectionController.#qcmAnswer = "";
            SelectionController.#qcmReason = "";
            SelectionController.runQcm();
          },
          onSeg: (idx) => {
            SelectionController.#activeSeg = idx;
            SelectionController.#paint();
            SelectionController.#flashOriginalOnPage(idx);
          },
          onMatchText: (picked, side) => {
            const idx = SelectionController.#findSeg(picked, side);
            if (idx < 0) return;
            SelectionController.#activeSeg = idx;
            SelectionController.#paint();
            SelectionController.#flashOriginalOnPage(idx);
          },
          onSwap: () => {
            const from = SelectionController.#from;
            const to = SelectionController.#to;
            if (from === "auto") {
              SelectionController.#from = to;
              SelectionController.#to = "en";
            } else {
              SelectionController.#from = to;
              SelectionController.#to = from;
            }
            HighlightStore.setPrefs({
              from: SelectionController.#from,
              to: SelectionController.#to,
            }).catch(() => {});
            SelectionController.#translated = "";
            SelectionController.#segments = [];
            SelectionController.#activeSeg = -1;
            SelectionController.#paint();
            SelectionController.runTranslate();
          },
          onLang: (from, to) => {
            SelectionController.#from = from;
            SelectionController.#to = to;
            HighlightStore.setPrefs({ from, to }).catch(() => {});
            SelectionController.#translated = "";
            SelectionController.#segments = [];
            SelectionController.#activeSeg = -1;
            SelectionController.#paint();
            SelectionController.runTranslate();
          },
          onSaveNote: (note) => {
            SelectionController.#note = note;
            if (SelectionController.#editingId) {
              SelectionController.updateItem(SelectionController.#editingId, {
                note,
                color: SelectionController.#color,
              });
            } else {
              SelectionController.createItem(note, SelectionController.#color);
            }
            SelectionController.close();
          },
          onDelete: () => {
            if (SelectionController.#editingId) {
              SelectionController.deleteItem(SelectionController.#editingId);
            }
            SelectionController.close();
          },
        }
      );
    }

    static async runTranslate() {
      const token = ++SelectionController.#translateToken;
      SelectionController.#translating = true;
      SelectionController.#activeSeg = -1;
      SelectionController.#segments = [];
      SelectionController.#paint();
      const res = await Translator.translate(
        SelectionController.#draftText,
        SelectionController.#from,
        SelectionController.#to
      );
      if (token !== SelectionController.#translateToken) return;
      SelectionController.#translating = false;
      if (res.ok && res.text) {
        SelectionController.#translated = res.text;
        SelectionController.#segments = Array.isArray(res.segments) ? res.segments : [];
        if (SelectionController.#from === "auto" && res.detected && res.detected !== "auto") {
          const code = res.detected.startsWith("zh") ? "zh-CN" : res.detected;
          if (LANGS.some((l) => l.code === code)) {
            SelectionController.#from = code;
          }
        }
      } else {
        SelectionController.#translated = res.error || "Translation failed";
        SelectionController.#segments = [];
      }
      SelectionController.#paint();
    }

    static async runQcm() {
      const text = String(SelectionController.#draftText || "").trim();
      if (text.length < 8) {
        SelectionController.#qcmAnswer = "Select more text (question + options)";
        SelectionController.#qcmReason = "";
        SelectionController.#qcmBusy = false;
        SelectionController.#paint();
        return;
      }
      const token = ++SelectionController.#qcmToken;
      SelectionController.#qcmBusy = true;
      SelectionController.#paint();

      /** @type {object} */
      let res;
      try {
        res = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(
              {
                type: "aiAnswerQuiz",
                source: "selection",
                text,
                host: location.hostname || "",
              },
              (response) => {
                const err = chrome.runtime.lastError;
                if (err) {
                  resolve({
                    ok: false,
                    error: "channel_closed",
                    detail: String(err.message || err).slice(0, 120),
                  });
                  return;
                }
                resolve(response && typeof response === "object" ? response : { ok: false, error: "no_response" });
              }
            );
          } catch (err) {
            resolve({ ok: false, error: String(err?.message || err || "send_failed") });
          }
        });
      } catch (err) {
        res = { ok: false, error: String(err?.message || err || "failed") };
      }

      if (token !== SelectionController.#qcmToken) return;
      SelectionController.#qcmBusy = false;
      if (res?.ok) {
        const answers = Array.isArray(res.answers) ? res.answers.filter(Boolean) : [];
        SelectionController.#qcmAnswer =
          answers.length > 1 ? answers.join(" · ") : String(res.answer || answers[0] || "").trim();
        const conf = res.confidence ? ` (${res.confidence})` : "";
        SelectionController.#qcmReason = String(res.reason || "").trim()
          ? `${String(res.reason).trim()}${conf}`
          : conf
            ? `Confidence${conf}`
            : "";
      } else {
        const err = String(res?.error || "failed");
        if (err === "missing_api_key" || err === "ai_disabled") {
          SelectionController.#qcmAnswer = "Add NVIDIA API key in Options";
        } else if (err === "disabled") {
          SelectionController.#qcmAnswer = "Enable Text selection / Quiz Assist in the popup";
        } else {
          SelectionController.#qcmAnswer = `Could not answer (${err})`;
        }
        SelectionController.#qcmReason = String(res?.detail || "").slice(0, 160);
      }
      SelectionController.#paint();
    }

    /**
     * @param {string} picked
     * @param {"src" | "dst"} side
     */
    static #findSeg(picked, side) {
      const needle = String(picked || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!needle) return -1;
      const segs = SelectionController.#segments;
      let best = -1;
      let bestScore = 0;
      for (let i = 0; i < segs.length; i += 1) {
        const hay = String(side === "src" ? segs[i].src : segs[i].dst)
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!hay) continue;
        if (hay === needle || hay.includes(needle) || needle.includes(hay)) {
          const score = Math.min(hay.length, needle.length);
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
      }
      return best;
    }

    /** Briefly select the matching original phrase on the page. */
    static #flashOriginalOnPage(idx) {
      const seg = SelectionController.#segments[idx];
      if (!seg?.src) return;
      const needle = seg.src.trim();
      if (needle.length < 2) return;

      // Prefer the live selection range if it still contains this chunk.
      try {
        if (SelectionController.#savedRange) {
          const holder = document.createElement("div");
          holder.appendChild(SelectionController.#savedRange.cloneContents());
          if (holder.textContent?.includes(needle)) {
            // Keep panel match — page selection may already cover it.
          }
        }
      } catch {
        // ignore
      }

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      /** @type {Text | null} */
      let node = /** @type {Text | null} */ (walker.nextNode());
      while (node) {
        if (node.parentElement?.closest?.(`#${SelectionUI.ROOT_ID}`)) {
          node = /** @type {Text | null} */ (walker.nextNode());
          continue;
        }
        const idxIn = node.data.indexOf(needle);
        if (idxIn >= 0) {
          const range = document.createRange();
          range.setStart(node, idxIn);
          range.setEnd(node, idxIn + needle.length);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          try {
            node.parentElement?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
          } catch {
            // ignore
          }
          return;
        }
        node = /** @type {Text | null} */ (walker.nextNode());
      }
    }

    /** @param {string} note @param {string} color */
    static createItem(note, color) {
      const id = `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const item = {
        id,
        text: SelectionController.#draftText,
        color,
        note: String(note || "").slice(0, 120),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      let mark = null;
      if (SelectionController.#savedRange) {
        mark = DomHighlight.wrap(SelectionController.#savedRange, item);
      }
      if (!mark) DomHighlight.applyByText(item);
      SelectionController.#items.push(item);
      HighlightStore.saveForPage(SelectionController.#items).catch(() => {});
      window.getSelection()?.removeAllRanges();
    }

    /**
     * @param {string} id
     * @param {{ note?: string, color?: string }} patch
     */
    static updateItem(id, patch) {
      const item = SelectionController.#items.find((h) => h.id === id);
      if (!item) return;
      if (patch.note !== undefined) item.note = String(patch.note).slice(0, 120);
      if (patch.color !== undefined) item.color = patch.color;
      item.updatedAt = Date.now();
      DomHighlight.update(item);
      HighlightStore.saveForPage(SelectionController.#items).catch(() => {});
    }

    /** @param {string} id */
    static deleteItem(id) {
      DomHighlight.unwrap(id);
      SelectionController.#items = SelectionController.#items.filter((h) => h.id !== id);
      HighlightStore.saveForPage(SelectionController.#items).catch(() => {});
    }

    static close() {
      SelectionController.#open = false;
      SelectionController.#editingId = null;
      SelectionController.#savedRange = null;
      SelectionController.#panel = "";
      SelectionController.#segments = [];
      SelectionController.#activeSeg = -1;
      SelectionController.#expanded = false;
      SelectionController.#translating = false;
      SelectionController.#translateToken += 1;
      SelectionUI.hide();
    }
  }

  /**
   * Chrome's built-in PDF viewer blocks extensions from reading selection.
   * Offer paste-to-translate on PDF tabs instead.
   */
  class PdfAssist {
    static #TIP_ID = "gosafe-pdf-assist";

    static isPdfPage() {
      try {
        if (document.contentType === "application/pdf") return true;
      } catch {
        // ignore
      }
      const href = String(location.href || "");
      const path = String(location.pathname || "");
      if (/\.pdf(?:$|[?#])/i.test(path) || /\.pdf(?:$|[?#])/i.test(href)) return true;
      if (document.querySelector?.('embed[type="application/pdf"], object[type="application/pdf"]')) {
        return true;
      }
      return false;
    }

    static start() {
      if (!PdfAssist.isPdfPage()) return;
      if (!FeatureGate.on()) return;
      PdfAssist.#inject();
    }

    static #inject() {
      SelectionUI.root(); // ensure brand CSS vars exist via inject
      if (document.getElementById(PdfAssist.#TIP_ID)) return;

      const tip = document.createElement("div");
      tip.id = PdfAssist.#TIP_ID;
      tip.innerHTML = `
        <div class="gts-pdf-bar">
          <img class="gts-pdf-logo" src="${chrome.runtime.getURL("icons/icon48.png")}" width="28" height="28" alt="GOSAFE" />
          <span>Chrome PDF viewer blocks selection tools. Copy text, then paste here to translate.</span>
          <button type="button" data-act="open">Paste &amp; translate</button>
          <button type="button" class="gts-pdf-x" data-act="dismiss" title="Dismiss">×</button>
        </div>
        <div class="gts-pdf-panel" hidden>
          <textarea rows="4" placeholder="Paste copied PDF text here…"></textarea>
          <div class="gts-pdf-actions">
            <select data-role="to">
              ${LANGS.filter((l) => l.code !== "auto")
                .map(
                  (l) =>
                    `<option value="${l.code}" ${l.code === "km" ? "selected" : ""}>${langOptionLabel(
                      l
                    )}</option>`
                )
                .join("")}
            </select>
            <button type="button" data-act="go">Translate</button>
          </div>
          <p class="gts-pdf-out" data-role="out"></p>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
#${PdfAssist.#TIP_ID} {
  position: fixed !important;
  z-index: 2147483646 !important;
  left: 12px !important;
  right: 12px !important;
  bottom: 12px !important;
  max-width: 520px !important;
  margin: 0 auto !important;
  font-family: "Segoe UI", "Helvetica Neue", sans-serif !important;
  font-size: 12.5px !important;
  color: #f4f7fc !important;
  filter: drop-shadow(0 10px 28px rgba(0, 40, 112, 0.4));
}
#${PdfAssist.#TIP_ID} .gts-pdf-bar {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  flex-wrap: wrap !important;
  padding: 10px 12px !important;
  border-radius: 12px !important;
  background: linear-gradient(135deg, #002870 0%, #0058d0 100%) !important;
  border: 1px solid rgba(255,255,255,0.18) !important;
}
#${PdfAssist.#TIP_ID} .gts-pdf-logo {
  width: 28px !important;
  height: 28px !important;
  border-radius: 6px !important;
  flex: 0 0 auto !important;
  object-fit: contain !important;
  background: #fff !important;
  padding: 2px !important;
  box-sizing: border-box !important;
}
#${PdfAssist.#TIP_ID} span { flex: 1 1 180px !important; color: #c8d8f0 !important; line-height: 1.35 !important; }
#${PdfAssist.#TIP_ID} button {
  border: 0 !important;
  border-radius: 8px !important;
  background: #fff !important;
  color: #002870 !important;
  font: inherit !important;
  font-weight: 700 !important;
  padding: 7px 10px !important;
  cursor: pointer !important;
}
#${PdfAssist.#TIP_ID} .gts-pdf-x {
  background: transparent !important;
  color: #fff !important;
  font-size: 18px !important;
  padding: 0 6px !important;
}
#${PdfAssist.#TIP_ID} .gts-pdf-panel {
  margin-top: 8px !important;
  padding: 10px !important;
  border-radius: 12px !important;
  background: #0a1f45 !important;
  border: 1px solid rgba(255,255,255,0.18) !important;
}
#${PdfAssist.#TIP_ID} textarea, #${PdfAssist.#TIP_ID} select {
  width: 100% !important;
  box-sizing: border-box !important;
  border: 1px solid rgba(255,255,255,0.18) !important;
  border-radius: 8px !important;
  background: rgba(0, 40, 112, 0.55) !important;
  color: #f4f7fc !important;
  padding: 8px !important;
  font: inherit !important;
  margin: 0 0 8px !important;
}
#${PdfAssist.#TIP_ID} .gts-pdf-actions {
  display: flex !important;
  gap: 8px !important;
  margin-bottom: 8px !important;
}
#${PdfAssist.#TIP_ID} .gts-pdf-actions select { margin: 0 !important; flex: 1 !important; }
#${PdfAssist.#TIP_ID} .gts-pdf-out {
  margin: 0 !important;
  min-height: 28px !important;
  max-height: 160px !important;
  overflow: auto !important;
  white-space: pre-wrap !important;
  color: #c8d8f0 !important;
}
#${PdfAssist.#TIP_ID} .gts-pdf-out.ready { color: #f4f7fc !important; }
`.trim();
      (document.documentElement || document.head).appendChild(style);
      (document.documentElement || document.body).appendChild(tip);

      const panel = /** @type {HTMLElement} */ (tip.querySelector(".gts-pdf-panel"));
      const area = /** @type {HTMLTextAreaElement} */ (tip.querySelector("textarea"));
      const toEl = /** @type {HTMLSelectElement} */ (tip.querySelector('[data-role="to"]'));
      const out = /** @type {HTMLElement} */ (tip.querySelector('[data-role="out"]'));

      tip.querySelector('[data-act="dismiss"]')?.addEventListener("click", () => tip.remove());
      tip.querySelector('[data-act="open"]')?.addEventListener("click", async () => {
        panel.hidden = false;
        try {
          const clip = await navigator.clipboard.readText();
          if (clip?.trim()) area.value = clip.trim().slice(0, 4500);
        } catch {
          // user can paste manually
        }
        area.focus();
      });
      tip.querySelector('[data-act="go"]')?.addEventListener("click", async () => {
        const text = area.value.trim();
        if (text.length < 2) {
          out.textContent = "Paste some text first.";
          out.classList.remove("ready");
          return;
        }
        out.textContent = "Translating…";
        out.classList.remove("ready");
        const prefs = await HighlightStore.prefs();
        const res = await Translator.translate(text, "auto", toEl.value || prefs.to || "en");
        if (res.ok && res.text) {
          out.textContent = res.text;
          out.classList.add("ready");
        } else {
          out.textContent = res.error || "Translation failed";
          out.classList.remove("ready");
        }
      });
    }
  }

  SelectionController.start()
    .then(() => PdfAssist.start())
    .catch(() => {
      try {
        PdfAssist.start();
      } catch {
        // ignore
      }
    });
})();
