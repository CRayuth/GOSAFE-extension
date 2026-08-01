(() => {
  "use strict";

  // MAIN world — Spotify ads share the music <audio>. Skip only on strong ad
  // signals + short clips, so false positives cannot end real songs.

  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return true;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-adblock-lite-spotify") !== "off";
    }
  }

  class SpotifyAdDetector {
    /** Ads are almost always ≤ ~90s; real tracks are longer. */
    static MAX_AD_SEC = 90;

    /** @param {string} text */
    static parseClock(text) {
      const m = String(text || "")
        .trim()
        .match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
      if (!m) return NaN;
      const hours = m[1] ? Number(m[1]) : 0;
      const mins = Number(m[2]);
      const secs = Number(m[3]);
      if (![hours, mins, secs].every(Number.isFinite)) return NaN;
      return hours * 3600 + mins * 60 + secs;
    }

    /** Duration shown in the playback bar (fallback when media.duration is Infinity). */
    static uiDurationSec() {
      const el =
        document.querySelector('[data-testid="playback-duration"]') ||
        document.querySelector('[data-testid="playback-progressbar"] [data-testid="playback-duration"]');
      if (!el) return NaN;
      return SpotifyAdDetector.parseClock(el.textContent || el.getAttribute("aria-valuemax") || "");
    }

    static isPlaying() {
      const btn = document.querySelector('[data-testid="control-button-playpause"]');
      const label = (btn?.getAttribute("aria-label") || "").toLowerCase();
      return label.includes("pause");
    }

    /**
     * Strong signals only. Blank now-playing + short duration matches free-tier ads
     * that never paint "Advertisement" in the title.
     */
    static isPlayingAd() {
      if (!FeatureGate.on()) return false;

      const title = (document.title || "").trim();
      if (/^advertisement\b/i.test(title)) return true;
      if (/\bspotify\s*[–-]\s*advertisement\b/i.test(title)) return true;

      const nowPlaying = document.querySelector('[data-testid="now-playing-widget"]');
      if (nowPlaying) {
        if (
          nowPlaying.querySelector(
            '[aria-label="Advertisement"], [aria-label*="Advertisement" i], a[href*="/ad/"], a[href*="spotify.com/ad/"]'
          )
        ) {
          return true;
        }

        const text = (nowPlaying.innerText || nowPlaying.textContent || "").trim();
        if (/^advertisement$/i.test(text)) return true;
        if (/your music will continue after the break/i.test(text)) return true;
        if (/\d+\s*s\s*left in the break/i.test(text)) return true;
        if (/advertisement\s*[•·]\s*\d+\s*of\s*\d+/i.test(text)) return true;

        const trackLink = nowPlaying.querySelector(
          'a[href*="/track/"], a[href*="/episode/"], a[href*="/show/"], a[href*="/album/"]'
        );
        const titleEl = nowPlaying.querySelector(
          '[data-testid="context-item-info-title"], [data-testid="context-item-info"] a'
        );
        const titleText = (titleEl?.textContent || "").trim();
        const blankMeta = !trackLink && (!titleText || titleText.length < 2);
        const uiDur = SpotifyAdDetector.uiDurationSec();
        if (
          blankMeta &&
          SpotifyAdDetector.isPlaying() &&
          Number.isFinite(uiDur) &&
          uiDur > 0 &&
          uiDur <= SpotifyAdDetector.MAX_AD_SEC
        ) {
          return true;
        }
      }

      const body = (document.body?.innerText || "").slice(0, 4000);
      if (/your music will continue after the break/i.test(body)) return true;
      if (/\d+\s*s\s*left in the break/i.test(body)) return true;

      return false;
    }
  }

  class MediaRegistry {
    static #set = new WeakSet();
    static #list = [];

    static install() {
      const remember = (media) => {
        if (!(media instanceof HTMLMediaElement)) return;
        if (MediaRegistry.#set.has(media)) return;
        MediaRegistry.#set.add(media);
        MediaRegistry.#list.push(new WeakRef(media));
      };

      const proto = HTMLMediaElement.prototype;
      for (const method of ["play", "load"]) {
        const original = proto[method];
        if (typeof original !== "function") continue;
        proto[method] = function patched(...args) {
          remember(this);
          return original.apply(this, args);
        };
      }

      const scan = () => {
        for (const el of document.querySelectorAll("audio, video")) remember(el);
      };
      scan();
      new MutationObserver(scan).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    static all() {
      const live = [];
      const next = [];
      for (const ref of MediaRegistry.#list) {
        const el = ref.deref?.() ?? null;
        if (!el) continue;
        next.push(ref);
        live.push(el);
      }
      MediaRegistry.#list = next;
      for (const el of document.querySelectorAll("audio, video")) {
        if (!live.includes(el)) live.push(el);
      }
      return live;
    }
  }

  /**
   * Mute + finish the ad clip. Seek only when duration is known and short.
   * Speed-up is a fallback when MSE reports Infinity duration.
   */
  class MediaController {
    static #adMode = false;
    static #skipped = false;

    static #muteOne(media) {
      try {
        if (media.dataset.ablSpotifyAd !== "1") {
          media.dataset.ablPrevMuted = media.muted ? "1" : "0";
          media.dataset.ablPrevVolume = String(media.volume);
          media.dataset.ablPrevRate = String(media.playbackRate || 1);
          media.dataset.ablSpotifyAd = "1";
        }
        media.muted = true;
        media.volume = 0;
      } catch {
        // ignore
      }
    }

    /** @returns {boolean} */
    static #seekOne(media) {
      try {
        const d = media.duration;
        if (!Number.isFinite(d) || d <= 0 || d > SpotifyAdDetector.MAX_AD_SEC) return false;
        if (media.currentTime >= d - 0.35) return true;
        media.currentTime = Math.max(0, d - 0.05);
        return true;
      } catch {
        return false;
      }
    }

    static #speedOne(media) {
      try {
        if (!Number.isFinite(media.duration) || media.duration > SpotifyAdDetector.MAX_AD_SEC) {
          media.playbackRate = 16;
        }
      } catch {
        // ignore
      }
    }

    static #clickNext() {
      const next = document.querySelector('[data-testid="control-button-skip-forward"]');
      if (!(next instanceof HTMLElement)) return false;
      if (next.hasAttribute("disabled") || next.getAttribute("aria-disabled") === "true") {
        return false;
      }
      try {
        next.click();
        return true;
      } catch {
        return false;
      }
    }

    static enterAdMode() {
      MediaController.#adMode = true;
      for (const media of MediaRegistry.all()) {
        MediaController.#muteOne(media);
      }

      if (MediaController.#skipped) return;

      let sought = false;
      for (const media of MediaRegistry.all()) {
        if (media.paused && media.readyState < 2) continue;
        if (MediaController.#seekOne(media)) sought = true;
      }

      if (sought) {
        MediaController.#skipped = true;
        return;
      }

      // MSE ads often expose Infinity duration — finish via rate, then Next if enabled.
      for (const media of MediaRegistry.all()) {
        MediaController.#speedOne(media);
      }
      if (MediaController.#clickNext()) {
        MediaController.#skipped = true;
      }
    }

    static leaveAdMode() {
      if (!MediaController.#adMode) return;
      MediaController.#adMode = false;
      MediaController.#skipped = false;
      for (const media of MediaRegistry.all()) {
        try {
          if (media.dataset.ablSpotifyAd !== "1") continue;
          media.muted = media.dataset.ablPrevMuted === "1";
          const prevVol = Number.parseFloat(media.dataset.ablPrevVolume || "1");
          media.volume = Number.isFinite(prevVol) && prevVol > 0 ? Math.min(prevVol, 1) : 1;
          const prevRate = Number.parseFloat(media.dataset.ablPrevRate || "1");
          media.playbackRate = Number.isFinite(prevRate) && prevRate > 0 ? prevRate : 1;
          delete media.dataset.ablSpotifyAd;
          delete media.dataset.ablPrevMuted;
          delete media.dataset.ablPrevVolume;
          delete media.dataset.ablPrevRate;
        } catch {
          // ignore
        }
      }
    }
  }

  class BreakUiHider {
    static hide() {
      if (!document.body) return;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      const hide = [];
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (!(el instanceof HTMLElement)) continue;
        if (el.closest("#adblock-lite-spotify")) continue;
        const text = (el.innerText || "").trim();
        if (!text || text.length > 120) continue;
        if (
          /^your music will continue after the break$/i.test(text) ||
          /^\d+\s*s\s*left in the break$/i.test(text) ||
          /^advertisement(\s*[•·]\s*\d+\s*of\s*\d+)?$/i.test(text)
        ) {
          const card =
            el.closest('[role="dialog"], [data-testid="fullscreen-ad"], [data-testid="ad-break"]') ||
            el.parentElement;
          if (card instanceof HTMLElement && card !== document.body) hide.push(card);
        }
      }
      for (const el of hide) {
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");
      }
    }
  }

  class SpotifyAdSkipController {
    constructor() {
      this._inAd = false;
    }

    tick() {
      if (!FeatureGate.on()) {
        if (this._inAd) {
          MediaController.leaveAdMode();
          this._inAd = false;
        }
        return;
      }

      const ad = SpotifyAdDetector.isPlayingAd();
      if (!ad) {
        if (this._inAd) {
          MediaController.leaveAdMode();
          this._inAd = false;
        }
        return;
      }

      this._inAd = true;
      MediaController.enterAdMode();
      BreakUiHider.hide();
    }
  }

  class SpotifyPageApp {
    static #scheduled = false;

    constructor() {
      this._skipper = new SpotifyAdSkipController();
    }

    start() {
      MediaRegistry.install();
      const run = () => this._skipper.tick();
      setInterval(run, 350);
      document.addEventListener("visibilitychange", run);
      new MutationObserver(() => {
        if (SpotifyPageApp.#scheduled) return;
        SpotifyPageApp.#scheduled = true;
        requestAnimationFrame(() => {
          SpotifyPageApp.#scheduled = false;
          run();
        });
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      run();
    }
  }

  new SpotifyPageApp().start();
})();
