(() => {
  "use strict";

  /**
   * MAIN-world Kahoot sniff — live /gameblock has no quizId in the URL.
   * Capture quizId / title / questionIndex from WebSocket + fetch, post to the page.
   */
  if (window.__gosafeKahootHook) return;
  window.__gosafeKahootHook = true;

  const HOST = /(^|\.)kahoot\.it$/i;
  if (!HOST.test(location.hostname || "")) return;

  /** @type {{ quizId?: string, quizTitle?: string, questionIndex?: number, pin?: string }} */
  const state = {};

  const UUID =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function publish() {
    try {
      window.dispatchEvent(
        new CustomEvent("gosafe-kahoot-meta", {
          detail: { ...state, t: Date.now() },
        })
      );
    } catch {
      // ignore
    }
  }

  function ingest(raw) {
    if (raw == null) return;
    let text = "";
    try {
      if (typeof raw === "string") text = raw;
      else if (typeof raw === "object") text = JSON.stringify(raw);
      else text = String(raw);
    } catch {
      return;
    }
    if (!text || text.length < 8 || text.length > 2_000_000) return;

    let changed = false;

    const idHints =
      /(?:quizId|kahootId|quiz_id|"uuid")\s*[":=]\s*"?(?:[0-9a-f-]{36})/gi;
    let m;
    while ((m = idHints.exec(text))) {
      const id = UUID.exec(m[0]);
      if (id && id[0] !== state.quizId) {
        state.quizId = id[0];
        changed = true;
      }
    }
    if (!state.quizId) {
      // Prefer UUIDs near kahoot/quiz wording
      const near = /(?:kahoot|quiz)[^]{0,80}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
        text
      );
      if (near && near[1] !== state.quizId) {
        state.quizId = near[1];
        changed = true;
      }
    }

    const title =
      /"quiz(?:Name|Title)"\s*:\s*"((?:\\.|[^"\\]){2,120})"/i.exec(text) ||
      /"kahootTitle"\s*:\s*"((?:\\.|[^"\\]){2,120})"/i.exec(text);
    if (title) {
      let t = title[1].replace(/\\"/g, '"').replace(/\\u([0-9a-f]{4})/gi, (_, h) =>
        String.fromCharCode(Number.parseInt(h, 16))
      );
      t = t.trim();
      if (t && t !== state.quizTitle) {
        state.quizTitle = t;
        changed = true;
      }
    }

    const qi =
      /"questionIndex"\s*:\s*(\d+)/i.exec(text) ||
      /"gameBlockIndex"\s*:\s*(\d+)/i.exec(text);
    if (qi) {
      const n = Number(qi[1]);
      if (Number.isInteger(n) && n !== state.questionIndex) {
        state.questionIndex = n;
        changed = true;
      }
    }

    const pin = /"gameid"\s*:\s*"?(\d{5,8})"?/i.exec(text) || /"pin"\s*:\s*"?(\d{5,8})"?/i.exec(text);
    if (pin && pin[1] !== state.pin) {
      state.pin = pin[1];
      changed = true;
    }

    if (changed) publish();
  }

  // --- WebSocket ---
  const NativeWS = window.WebSocket;
  if (typeof NativeWS === "function") {
    function WrappedWS(url, protocols) {
      const ws =
        protocols !== undefined
          ? new NativeWS(url, protocols)
          : new NativeWS(url);
      try {
        if (/kahoot|cometd|play/i.test(String(url || ""))) {
          ws.addEventListener("message", (ev) => ingest(ev.data));
          const origSend = ws.send;
          ws.send = function sendPatched(data) {
            try {
              ingest(data);
            } catch {
              // ignore
            }
            return origSend.apply(this, arguments);
          };
        }
      } catch {
        // ignore
      }
      return ws;
    }
    WrappedWS.prototype = NativeWS.prototype;
    WrappedWS.CONNECTING = NativeWS.CONNECTING;
    WrappedWS.OPEN = NativeWS.OPEN;
    WrappedWS.CLOSING = NativeWS.CLOSING;
    WrappedWS.CLOSED = NativeWS.CLOSED;
    try {
      window.WebSocket = WrappedWS;
    } catch {
      // ignore
    }
  }

  // --- fetch ---
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = async function gosafeFetch(...args) {
      const res = await nativeFetch.apply(this, args);
      try {
        const url = String(args[0]?.url || args[0] || "");
        if (/kahoot/i.test(url) && /json|kahoot|rest|session|reserve/i.test(url)) {
          const clone = res.clone();
          clone
            .text()
            .then((t) => ingest(t))
            .catch(() => {});
        }
        const um = UUID.exec(url);
        if (um && /\/kahoots\//i.test(url)) {
          state.quizId = um[0];
          publish();
        }
      } catch {
        // ignore
      }
      return res;
    };
  }

  // --- XHR ---
  try {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__gosafeUrl = String(url || "");
      return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        try {
          if (/kahoot/i.test(this.__gosafeUrl || "")) ingest(this.responseText);
        } catch {
          // ignore
        }
      });
      return send.apply(this, args);
    };
  } catch {
    // ignore
  }

  // Re-broadcast on demand
  window.addEventListener("gosafe-kahoot-meta-request", () => publish());
})();
