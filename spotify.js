(() => {
  "use strict";

  class SpotifyAdSelectorSet {
    // Narrow cosmetics only — broad [class*="Ad…"] / data-testid*="ad" hid player chrome.
    static CSS = `
[data-testid="ad-slot"],
[data-testid="nudge-ad"],
[data-testid="spotlight-ad"],
[data-testid="desktop-top-ad"],
[data-testid="video-ad"],
[data-testid="in-stream-ad"],
[data-testid="fullscreen-ad"],
[data-testid="ad-break"],
iframe[src*="spotify.com/ad"],
iframe[src*="doubleclick"],
aside[aria-label="Advertisement"],
div[aria-label="Advertisement"],
a[href*="adclick.g.doubleclick.net"],
#leaderboard-ad-element,
.ads-container {
  display: none !important;
  visibility: hidden !important;
  max-height: 0 !important;
  overflow: hidden !important;
  pointer-events: none !important;
  opacity: 0 !important;
}
`.trim();
  }

  class SpotifyStyleInjector {
    static #ID = "adblock-lite-spotify";

    inject() {
      if (document.getElementById(SpotifyStyleInjector.#ID)) return;
      const style = document.createElement("style");
      style.id = SpotifyStyleInjector.#ID;
      style.textContent = SpotifyAdSelectorSet.CSS;
      (document.documentElement || document.head || document.body).appendChild(style);
    }

    remove() {
      document.getElementById(SpotifyStyleInjector.#ID)?.remove();
    }
  }

  class ExtensionFlag {
    static set(active, spotifySkip) {
      document.documentElement?.setAttribute("data-adblock-lite", active ? "on" : "off");
      document.documentElement?.setAttribute(
        "data-adblock-lite-spotify",
        active && spotifySkip ? "on" : "off"
      );
    }
  }

  class SpotifyCosmeticController {
    constructor() {
      this._styles = new SpotifyStyleInjector();
    }

    async #policy() {
      const raw = await chrome.storage.local.get({
        enabled: true,
        features: { spotifySkip: true },
        pausedHosts: [],
      });
      const host = (location.hostname || "").replace(/^www\./, "").toLowerCase();
      const paused = Array.isArray(raw.pausedHosts) && raw.pausedHosts.includes(host);
      const spotifySkip = raw.features?.spotifySkip !== false;
      const active = raw.enabled !== false && !paused;
      return { active, spotifySkip };
    }

    async start() {
      const { active, spotifySkip } = await this.#policy();
      ExtensionFlag.set(active, spotifySkip);
      if (!active || !spotifySkip) {
        this._styles.remove();
        return;
      }
      this._styles.inject();
    }
  }

  const app = new SpotifyCosmeticController();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.enabled && !changes.features && !changes.pausedHosts) return;
    app.start();
  });

  if (document.documentElement) app.start();
  else document.addEventListener("DOMContentLoaded", () => app.start(), { once: true });
})();
