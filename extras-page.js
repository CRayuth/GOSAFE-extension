(() => {
  "use strict";

  // MAIN world — cookie decline, anti-adblock, autoplay, popup/tab under block.

  class Gate {
    static on(name) {
      const root = document.documentElement;
      if (!root) return true;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      if (root.getAttribute("data-adblock-lite-quiet") === "on" && name === "tips") {
        return false;
      }
      return root.getAttribute(`data-adblock-lite-${name}`) !== "off";
    }
  }

  class EventBus {
    static #lastKey = "";
    static #lastAt = 0;

    static emit(entry) {
      if (!Gate.on("tips") && entry?.kind === "system") return;
      try {
        const key = `${entry.kind}|${entry.title}`;
        const now = Date.now();
        if (key === EventBus.#lastKey && now - EventBus.#lastAt < 4000) return;
        EventBus.#lastKey = key;
        EventBus.#lastAt = now;
        window.postMessage(
          {
            source: "adblock-lite",
            type: "log",
            entry: {
              kind: entry.kind,
              title: entry.title,
              detail: entry.detail || "",
              host: (location.hostname || "").replace(/^www\./, ""),
              ts: now,
            },
          },
          "*"
        );
        if (Gate.on("adaptive") && entry?.learn !== false) {
          window.postMessage(
            {
              source: "adblock-lite",
              type: "learn",
              entry: {
                kind: entry.kind || "dismiss",
                title: entry.title || "",
                detail: entry.detail || "",
                selector: entry.selector || "",
                host: (location.hostname || "").replace(/^www\./, ""),
              },
            },
            "*"
          );
        }
      } catch {
        // ignore
      }
    }
  }

  class CookieConsentGuard {
    static #RE =
      /^(reject|decline|deny|refuse|disagree|reject all|decline all|only necessary|necessary only|essential only|save without|continue without|reject non|opt.?out|nein|ablehnen|refuser|rechazar|rifiuta)/i;

    static #TEXT =
      /reject all|decline all|only (use )?necessary|necessary cookies only|essential only|refuse|disagree|do not sell|opt out|reject non-essential|reject optional/i;

    static tick() {
      if (!Gate.on("cookie")) return;
      const buttons = document.querySelectorAll(
        "button, [role='button'], a, input[type='button'], input[type='submit']"
      );
      for (const el of buttons) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.dataset.ablCookieTried === "1") continue;
        const label = (
          el.getAttribute("aria-label") ||
          el.innerText ||
          el.value ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        if (!label || label.length > 60) continue;
        if (!CookieConsentGuard.#RE.test(label) && !CookieConsentGuard.#TEXT.test(label)) {
          continue;
        }
        el.dataset.ablCookieTried = "1";
        try {
          el.click();
          EventBus.emit({
            kind: "system",
            title: "Declined cookie banner",
            detail: label.slice(0, 60),
            selector: "[class*='cookie' i],[id*='cookie' i],[class*='consent' i]",
          });
          break;
        } catch {
          // ignore
        }
      }
    }
  }

  class AntiAdblockGuard {
    static #STYLE_ID = "adblock-lite-antiadblock";

    static #SELECTORS = [
      "[class*='adblock-modal' i]",
      "[class*='adblock_modal' i]",
      "[class*='adblock-detected' i]",
      "[class*='adb-enabled' i]",
      "[class*='please-disable-adblock' i]",
      "[id*='adblock-modal' i]",
      "[id*='adblock_detected' i]",
      "[class*='disable-adblock' i]",
      "[class*='adblocker-detected' i]",
      "[data-nosnippet][class*='adblock' i]",
    ];

    static injectCss() {
      if (document.getElementById(AntiAdblockGuard.#STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = AntiAdblockGuard.#STYLE_ID;
      style.textContent = `${AntiAdblockGuard.#SELECTORS.join(",")}{display:none!important;visibility:hidden!important;pointer-events:none!important;}`;
      (document.documentElement || document.head).appendChild(style);
    }

    static softenDetection() {
      try {
        const bait = document.createElement("div");
        bait.className = "adsbox ad-banner adsbygoogle pub_300x250";
        bait.id = "adblock-lite-bait";
        Object.assign(bait.style, {
          height: "1px",
          width: "1px",
          position: "absolute",
          left: "-9999px",
          top: "-9999px",
        });
        (document.documentElement || document.body)?.appendChild(bait);
      } catch {
        // ignore
      }
    }

    static tick() {
      if (!Gate.on("antiadblock")) return;
      AntiAdblockGuard.injectCss();
      const kill = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (!(el instanceof HTMLElement)) continue;
        const text = (el.innerText || "").trim();
        if (!text || text.length > 220) continue;
        if (
          /please disable (your )?ad.?block|adblock(er)? (detected|found)|turn off your ad.?block|whitelist this site|allow ads on this/i.test(
            text
          )
        ) {
          const card =
            el.closest("[role='dialog'], .modal, .popup, [class*='modal' i], [class*='overlay' i]") ||
            el;
          if (card instanceof HTMLElement && card !== document.body) kill.push(card);
        }
      }
      for (const el of kill) {
        el.style.setProperty("display", "none", "important");
        EventBus.emit({
          kind: "system",
          title: "Hid anti-adblock wall",
          detail: (el.className || el.id || "modal").toString().slice(0, 80),
          selector: "[class*='adblock' i],[class*='adblocker' i]",
        });
      }
      try {
        // Avoid fighting player pages that manage their own overflow/scroll.
        if (!/\/(title|watch|movie|embed|player)\b/i.test(location.pathname || "")) {
          document.documentElement.style.removeProperty("overflow");
          document.body?.style.removeProperty("overflow");
        }
      } catch {
        // ignore
      }
    }
  }

  class AutoplayGuard {
    static #patched = false;
    static #gestureUntil = 0;

    static #PLAYER_UI =
      "video, audio, iframe, .plyr, .jwplayer, .video-js, .artplayer, .dplayer, [class*='player'], [id*='player'], [class*='vjs'], [class*='volume'], [class*='control'], media-controller, [role='slider'], input[type='range']";

    static #hadGesture() {
      return Date.now() <= AutoplayGuard.#gestureUntil;
    }

    static #markUserMedia(root) {
      const scope = root instanceof Element ? root : document;
      for (const media of scope.querySelectorAll?.("video, audio") || []) {
        media.dataset.ablUserPlay = "1";
        delete media.dataset.ablForcePause;
      }
      // Also mark page-level media when interacting with any player chrome.
      for (const media of document.querySelectorAll("video, audio")) {
        media.dataset.ablUserPlay = "1";
        delete media.dataset.ablForcePause;
      }
    }

    static install() {
      if (AutoplayGuard.#patched) return;
      AutoplayGuard.#patched = true;
      const proto = HTMLMediaElement.prototype;
      const origPlay = proto.play;
      if (typeof origPlay !== "function") return;
      proto.play = function patchedPlay(...args) {
        if (Gate.on("autoplay") && this instanceof HTMLMediaElement) {
          if (this.dataset.ablUserPlay === "1" || AutoplayGuard.#hadGesture()) {
            this.dataset.ablUserPlay = "1";
            delete this.dataset.ablForcePause;
            return origPlay.apply(this, args);
          }
          // Only block true autoplay (attribute / prior forced pause) — never unmuted playback alone.
          const looksAuto =
            this.autoplay ||
            this.hasAttribute("autoplay") ||
            this.dataset.ablForcePause === "1";
          if (looksAuto) {
            try {
              this.pause();
              this.muted = true;
              this.dataset.ablForcePause = "1";
            } catch {
              // ignore
            }
            return Promise.resolve();
          }
        }
        return origPlay.apply(this, args);
      };

      const markGesture = (event) => {
        AutoplayGuard.#gestureUntil = Date.now() + 5000;
        const t = event.target;
        if (!(t instanceof Element)) return;
        if (t.closest(AutoplayGuard.#PLAYER_UI) || t.closest("button, [role='button']")) {
          AutoplayGuard.#markUserMedia(t.closest(AutoplayGuard.#PLAYER_UI) || document);
        }
        const media = t.closest?.("video, audio");
        if (media) {
          media.dataset.ablUserPlay = "1";
          delete media.dataset.ablForcePause;
        }
      };
      for (const type of ["pointerdown", "keydown", "touchstart"]) {
        document.addEventListener(type, markGesture, true);
      }
    }

    static tick() {
      if (!Gate.on("autoplay")) return;
      // Only elements still marked autoplay — do not pause normal unmuted players.
      for (const media of document.querySelectorAll("video[autoplay], audio[autoplay]")) {
        if (!(media instanceof HTMLMediaElement)) continue;
        if (media.dataset.ablUserPlay === "1") continue;
        if (media.paused) continue;
        try {
          media.pause();
          media.muted = true;
          media.dataset.ablForcePause = "1";
        } catch {
          // ignore
        }
      }
    }
  }

  class PopupTabGuard {
    static #patched = false;

    static install() {
      if (PopupTabGuard.#patched) return;
      PopupTabGuard.#patched = true;
      const origOpen = window.open;
      window.open = function guardedOpen(url, name, specs) {
        if (Gate.on("popup")) {
          const href = String(url || "");
          // Block empty/nameless popunders and known junk targets.
          if (!href || href === "about:blank" || /doubleclick|popads|popcash|propeller/i.test(href)) {
            EventBus.emit({
              kind: "hijack",
              title: "Blocked popup / tab-under",
              detail: href.slice(0, 120),
            });
            return null;
          }
          // Without a recent user gesture, treat as hostile.
          if (!PopupTabGuard.#hadGesture()) {
            EventBus.emit({
              kind: "hijack",
              title: "Blocked background popup",
              detail: href.slice(0, 120),
            });
            return null;
          }
        }
        return origOpen.call(window, url, name, specs);
      };
      for (const type of ["pointerdown", "keydown", "touchstart"]) {
        document.addEventListener(type, () => PopupTabGuard.#markGesture(), true);
      }
    }

    static #gestureUntil = 0;
    static #markGesture() {
      PopupTabGuard.#gestureUntil = Date.now() + 2500;
    }
    static #hadGesture() {
      return Date.now() <= PopupTabGuard.#gestureUntil;
    }
  }

  class ExtrasApp {
    static #scheduled = false;

    start() {
      PopupTabGuard.install();
      AutoplayGuard.install();
      if (Gate.on("antiadblock")) AntiAdblockGuard.softenDetection();

      const run = () => {
        CookieConsentGuard.tick();
        AntiAdblockGuard.tick();
        AutoplayGuard.tick();
      };
      setInterval(run, 1200);
      document.addEventListener("DOMContentLoaded", run, { once: true });
      new MutationObserver(() => {
        if (ExtrasApp.#scheduled) return;
        ExtrasApp.#scheduled = true;
        requestAnimationFrame(() => {
          ExtrasApp.#scheduled = false;
          run();
        });
      }).observe(document.documentElement, { childList: true, subtree: true });
      run();
    }
  }

  new ExtrasApp().start();
})();
