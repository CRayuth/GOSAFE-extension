(() => {
  "use strict";

  // MAIN world — real-time web attack signals → activity bridge

  class Gate {
    static on() {
      const root = document.documentElement;
      if (!root) return true;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-adblock-lite-secwatch") !== "off";
    }
  }

  class Bus {
    static #last = "";
    static #at = 0;

    static emit(entry) {
      if (!Gate.on()) return;
      try {
        const key = `${entry.title}|${entry.detail || ""}`;
        const now = Date.now();
        if (key === Bus.#last && now - Bus.#at < 5000) return;
        Bus.#last = key;
        Bus.#at = now;
        window.postMessage(
          {
            source: "adblock-lite",
            type: "securityAlert",
            entry: {
              kind: entry.kind || "attack",
              title: entry.title,
              detail: entry.detail || "",
              host: (location.hostname || "").replace(/^www\./, ""),
              ts: now,
            },
          },
          "*"
        );
      } catch {
        // ignore
      }
    }
  }

  class DriveByGuard {
    static install() {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
        DriveByGuard.#check(url);
        return origOpen.call(this, method, url, ...rest);
      };
      const origFetch = window.fetch;
      if (typeof origFetch === "function") {
        window.fetch = function patchedFetch(input, init) {
          const url = typeof input === "string" ? input : input?.url;
          DriveByGuard.#check(url);
          return origFetch.call(this, input, init);
        };
      }
    }

    static #check(url) {
      const href = String(url || "");
      if (/\.(exe|msi|dmg|apk|scr|bat|cmd|ps1)(?:$|[?#])/i.test(href)) {
        Bus.emit({
          kind: "attack",
          title: "GOSAFE blocked: Suspicious script execution",
          detail: "This script attempts to download an executable file.",
        });
      }
      if (/coinhive|cryptoloot|webmine|authedmine|jsecoin|miner\.js/i.test(href)) {
        Bus.emit({
          kind: "attack",
          title: "GOSAFE blocked: Cryptojacking attempt",
          detail: href.slice(0, 140),
        });
      }
    }
  }

  class FakeUpdateWatch {
    static tick() {
      if (!Gate.on()) return;
      const text = (document.body?.innerText || "").slice(0, 8000);
      if (
        /chrome is out of date|update (your )?browser (now|to continue)|download chrome\.exe|your flash player is out of date|install (this )?extension to (continue|watch)/i.test(
          text
        )
      ) {
        Bus.emit({
          kind: "attack",
          title: "GOSAFE blocked: Fake browser update",
          detail: "Page social-engineers a browser/extension install.",
        });
      }
    }
  }

  class ApiProbeWatch {
    static #fp = 0;

    static install() {
      const note = (name) => {
        if (!Gate.on()) return;
        ApiProbeWatch.#fp += 1;
        if (ApiProbeWatch.#fp <= 20) {
          window.postMessage(
            {
              source: "adblock-lite",
              type: "securityMetric",
              metric: "fingerprint",
              detail: name,
            },
            "*"
          );
        }
      };
      try {
        const canvas = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (...args) {
          note("canvas.toDataURL");
          return canvas.apply(this, args);
        };
      } catch {
        // ignore
      }
      try {
        const getParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (...args) {
          note("webgl.getParameter");
          return getParam.apply(this, args);
        };
      } catch {
        // ignore
      }
    }
  }

  DriveByGuard.install();
  ApiProbeWatch.install();
  const run = () => FakeUpdateWatch.tick();
  setInterval(run, 2500);
  document.addEventListener("DOMContentLoaded", run, { once: true });
})();
