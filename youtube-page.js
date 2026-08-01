(() => {
  "use strict";

  // MAIN world — strip ads from player API + skip/seek fallback while ad-showing.

  class PlayerApiMatcher {
    static RE = /\/youtubei\/v1\/(player|get_watch)(?:\?|$)/;

    static matches(url) {
      return PlayerApiMatcher.RE.test(String(url || ""));
    }
  }

  /**
   * DFS over player JSON:
   * - prune known ad renderer nodes from arrays
   * - empty/delete ad placement keys on objects
   * Depth-capped to avoid pathological graphs.
   */
  class AdPayloadCleaner {
    static #MAX_DEPTH = 20;
    static #AD_KEYS = /^(adPlacements|playerAds|adSlots|adBreakHeartbeatParams|adBreaks)$/i;
    static #AD_RENDERERS = new Set([
      "adPlacementRenderer",
      "playerAdRenderer",
      "adBreakServiceRenderer",
      "adSlotRenderer",
      "instreamVideoAdRenderer",
      "adBreakRenderer",
    ]);

    static clean(value, depth = 0) {
      if (!value || typeof value !== "object" || depth > AdPayloadCleaner.#MAX_DEPTH) {
        return value;
      }

      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i -= 1) {
          const item = value[i];
          if (!item || typeof item !== "object") continue;
          if (AdPayloadCleaner.#isAdNode(item)) {
            value.splice(i, 1);
            continue;
          }
          AdPayloadCleaner.clean(item, depth + 1);
        }
        return value;
      }

      for (const key of Object.keys(value)) {
        if (AdPayloadCleaner.#AD_KEYS.test(key)) {
          if (Array.isArray(value[key])) value[key] = [];
          else delete value[key];
          continue;
        }
        const child = value[key];
        if (child && typeof child === "object") {
          AdPayloadCleaner.clean(child, depth + 1);
        }
      }
      return value;
    }

    static #isAdNode(item) {
      for (const key of AdPayloadCleaner.#AD_RENDERERS) {
        if (item[key]) return true;
      }
      return false;
    }
  }

  class FetchInterceptor {
    static install() {
      const nativeFetch = window.fetch;
      if (typeof nativeFetch !== "function") return;

      window.fetch = async function patchedFetch(input) {
        const response = await nativeFetch.apply(this, arguments);
        try {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input?.url || "";
          if (!PlayerApiMatcher.matches(url)) return response;
          const data = await response.clone().json();
          AdPayloadCleaner.clean(data);
          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch {
          return response;
        }
      };
    }
  }

  class XhrInterceptor {
    static install() {
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function patchedOpen(_method, url) {
        this.__ablUrl = String(url || "");
        return open.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function patchedSend() {
        this.addEventListener(
          "load",
          function onLoad() {
            if (!PlayerApiMatcher.matches(this.__ablUrl || "")) return;
            try {
              const parsed = JSON.parse(this.responseText);
              AdPayloadCleaner.clean(parsed);
              const body = JSON.stringify(parsed);
              Object.defineProperty(this, "responseText", {
                configurable: true,
                get: () => body,
              });
              if (this.responseType === "" || this.responseType === "text") {
                Object.defineProperty(this, "response", {
                  configurable: true,
                  get: () => body,
                });
              }
            } catch {
              // ignore
            }
          },
          { once: true }
        );
        return send.apply(this, arguments);
      };
    }
  }

  class InitialPlayerResponseHook {
    static install() {
      try {
        if (window.ytInitialPlayerResponse) {
          AdPayloadCleaner.clean(window.ytInitialPlayerResponse);
        }
      } catch {
        // ignore
      }

      try {
        let current = window.ytInitialPlayerResponse;
        Object.defineProperty(window, "ytInitialPlayerResponse", {
          configurable: true,
          enumerable: true,
          get() {
            return current;
          },
          set(value) {
            current = AdPayloadCleaner.clean(value);
          },
        });
        if (current) AdPayloadCleaner.clean(current);
      } catch {
        // ignore
      }
    }
  }

  /** DOM helpers for the HTML5 player. */
  class YouTubePlayer {
    static get root() {
      return (
        document.querySelector("#movie_player") ||
        document.querySelector(".html5-video-player")
      );
    }

    static get video() {
      return (
        YouTubePlayer.root?.querySelector("video") ||
        document.querySelector("video.html5-main-video")
      );
    }

    static hasAd() {
      const player = YouTubePlayer.root;
      return Boolean(
        player &&
          (player.classList.contains("ad-showing") ||
            player.classList.contains("ad-interrupting"))
      );
    }
  }

  class SkipButtonFinder {
    static #SELECTORS = Object.freeze([
      ".ytp-skip-ad-button",
      ".ytp-ad-skip-button",
      ".ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button-container button",
      "button.ytp-skip-ad-button",
      "button.ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button-slot button",
      "button[id^='skip-button']",
      "button[aria-label*='Skip' i]",
    ]);

    /** Collect visible skip targets (filter by bounding box). */
    static findVisible() {
      const hits = [];
      for (const sel of SkipButtonFinder.#SELECTORS) {
        document.querySelectorAll(sel).forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width >= 1 && r.height >= 1) hits.push(el);
        });
      }
      document.querySelectorAll("#movie_player button").forEach((el) => {
        const label = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.toLowerCase();
        if (!label.includes("skip")) return;
        const r = el.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1) hits.push(el);
      });
      return hits;
    }
  }

  class ClickSynthesizer {
    static fire(el) {
      const target = el.closest?.("button, [role='button']") || el;
      const opts = { bubbles: true, cancelable: true, view: window, composed: true };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        try {
          target.dispatchEvent(new MouseEvent(type, opts));
        } catch {
          // ignore
        }
      }
      try {
        target.click();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Ad playback state machine:
   * idle → accelerating (muted/16x/seek) → idle (restore).
   */
  class AdSkipController {
    constructor() {
      this._inAd = false;
      this._savedMuted = null;
      this._savedRate = null;
      this._lastSkipAt = 0;
      this._seekedThisAd = false;
    }

    static enabled() {
      const root = document.documentElement;
      if (!root) return true;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-adblock-lite-youtube") !== "off";
    }

    tick() {
      if (!AdSkipController.enabled()) {
        this.restore();
        return;
      }
      if (!YouTubePlayer.hasAd()) {
        this.restore();
        return;
      }
      this.#clickSkip();
      this.#accelerateAndSeek();
    }

    #clickSkip() {
      const now = Date.now();
      if (now - this._lastSkipAt < 200) return;
      const targets = SkipButtonFinder.findVisible();
      if (!targets.length) return;
      for (const el of targets) ClickSynthesizer.fire(el);
      this._lastSkipAt = now;
    }

    #accelerateAndSeek() {
      if (!YouTubePlayer.hasAd()) return;
      const video = YouTubePlayer.video;
      if (!video) return;

      try {
        if (!this._inAd) {
          this._savedMuted = video.muted;
          this._savedRate = video.playbackRate || 1;
          this._inAd = true;
          this._seekedThisAd = false;
        }
        video.muted = true;
        video.playbackRate = 16;
        if (!YouTubePlayer.hasAd()) return;

        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) return;
        if (video.currentTime >= duration - 0.25) return;
        if (!this._seekedThisAd) {
          video.currentTime = duration;
          this._seekedThisAd = true;
        }
      } catch {
        // ignore
      }
    }

    restore() {
      const video = YouTubePlayer.video;
      try {
        if (video && this._inAd) {
          video.playbackRate =
            typeof this._savedRate === "number" && this._savedRate > 0 && this._savedRate <= 2
              ? this._savedRate
              : 1;
          if (typeof this._savedMuted === "boolean") video.muted = this._savedMuted;
        } else if (video && video.playbackRate > 2) {
          video.playbackRate = 1;
        }
      } catch {
        // ignore
      }
      this._inAd = false;
      this._seekedThisAd = false;
      this._savedMuted = null;
      this._savedRate = null;
    }
  }

  class YouTubePageApp {
    constructor() {
      this._skipper = new AdSkipController();
    }

    start() {
      FetchInterceptor.install();
      XhrInterceptor.install();
      InitialPlayerResponseHook.install();

      setInterval(() => this._skipper.tick(), 200);
      document.addEventListener("yt-navigate-finish", () => {
        InitialPlayerResponseHook.install();
        this._skipper.restore();
        this._skipper.tick();
      });
    }
  }

  new YouTubePageApp().start();
})();
