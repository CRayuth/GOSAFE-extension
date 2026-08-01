(() => {
  "use strict";

  /** Cosmetic hide list for YouTube chrome ads (not the player itself). */
  class YouTubeAdSelectorSet {
    static CSS = `
ytd-ad-slot-renderer,
ytm-ad-slot-renderer,
ad-slot-renderer,
ytd-display-ad-renderer,
ytd-action-companion-ad-renderer,
ytd-in-feed-ad-layout-renderer,
ytd-banner-promo-renderer,
ytd-statement-banner-renderer,
ytd-promoted-sparkles-web-renderer,
ytm-promoted-sparkles-web-renderer,
ytd-promoted-video-renderer,
ytm-promoted-video-renderer,
ytd-video-masthead-ad-v3-renderer,
ytd-video-masthead-ad-primary-video-renderer,
ytd-player-legacy-desktop-watch-ads-renderer,
ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
ytd-ads-engagement-panel-content-renderer,
yt-mealbar-promo-renderer,
ytm-companion-ad-renderer,
#masthead-ad,
#player-ads,
.ytp-ad-overlay-slot,
.ytp-ad-image-overlay,
.ytp-ad-text-overlay,
.ytp-ad-message-container,
.ytwAdBannerHost,
.ytwPanelAdHeaderImageLockupViewModelHost {
  display: none !important;
  visibility: hidden !important;
  max-height: 0 !important;
  overflow: hidden !important;
  margin: 0 !important;
  padding: 0 !important;
}
`.trim();
  }

  class YouTubeStyleInjector {
    static #ID = "adblock-lite-youtube";

    inject() {
      if (document.getElementById(YouTubeStyleInjector.#ID)) return;
      const style = document.createElement("style");
      style.id = YouTubeStyleInjector.#ID;
      style.textContent = YouTubeAdSelectorSet.CSS;
      (document.documentElement || document.head || document.body).appendChild(style);
    }

    remove() {
      document.getElementById(YouTubeStyleInjector.#ID)?.remove();
    }
  }

  class ExtensionFlag {
    static set(active, youtubeSkip) {
      document.documentElement?.setAttribute("data-adblock-lite", active ? "on" : "off");
      document.documentElement?.setAttribute(
        "data-adblock-lite-youtube",
        active && youtubeSkip ? "on" : "off"
      );
    }
  }

  class YouTubeCosmeticController {
    constructor() {
      this._styles = new YouTubeStyleInjector();
    }

    async #policy() {
      const raw = await chrome.storage.local.get({
        enabled: true,
        features: { youtubeSkip: true },
        pausedHosts: [],
      });
      const host = (location.hostname || "").replace(/^www\./, "").toLowerCase();
      const paused = Array.isArray(raw.pausedHosts) && raw.pausedHosts.includes(host);
      const youtubeSkip = raw.features?.youtubeSkip !== false;
      const active = raw.enabled !== false && !paused;
      return { active, youtubeSkip };
    }

    async start() {
      const { active, youtubeSkip } = await this.#policy();
      ExtensionFlag.set(active, youtubeSkip);
      if (!active || !youtubeSkip) {
        this._styles.remove();
        return;
      }
      this._styles.inject();
    }
  }

  const app = new YouTubeCosmeticController();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.enabled && !changes.features && !changes.pausedHosts) return;
    app.start();
  });

  if (document.documentElement) app.start();
  else document.addEventListener("DOMContentLoaded", () => app.start(), { once: true });
})();
