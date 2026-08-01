(() => {
  "use strict";

  // MAIN world — stop click-jack overlays, hijack popups, and surprise off-site jumps.

  class EventBus {
    static #lastKey = "";
    static #lastAt = 0;

    /**
     * Bridge MAIN → isolated content script → background activity log.
     * @param {{ kind: string, title: string, detail?: string }} entry
     */
    static emit(entry) {
      try {
        const key = `${entry.kind}|${entry.title}|${entry.detail || ""}`;
        const now = Date.now();
        if (key === EventBus.#lastKey && now - EventBus.#lastAt < 2500) return;
        EventBus.#lastKey = key;
        EventBus.#lastAt = now;
        const host = (location.hostname || "").replace(/^www\./, "");
        window.postMessage(
          {
            source: "adblock-lite",
            type: "log",
            entry: {
              kind: entry.kind,
              title: entry.title,
              detail: entry.detail || "",
              host,
              ts: now,
            },
          },
          "*"
        );
        if (entry.learn !== false) {
          window.postMessage(
            {
              source: "adblock-lite",
              type: "learn",
              entry: {
                kind: entry.kind || "dismiss",
                title: entry.title || "",
                detail: entry.detail || "",
                selector: entry.selector || "",
                host,
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

  class SiteContext {
    static hostname() {
      return (location.hostname || "").replace(/^www\./, "").toLowerCase();
    }

    static isYouTube() {
      const host = SiteContext.hostname();
      return (
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com"
      );
    }

    static isCanva() {
      const host = SiteContext.hostname();
      return (
        host === "canva.com" ||
        host.endsWith(".canva.com") ||
        host === "canva.site" ||
        host.endsWith(".canva.site") ||
        host === "canva.me" ||
        host.endsWith(".canva.me")
      );
    }

    /** Sports / illegal-stream mirrors that inject home/ad bounce scripts. */
    static isStreamSite() {
      const host = SiteContext.hostname();
      return /stream|sport|fight|nba|nfl|mlb|nhl|soccer|footy|kick|playoff|streameast|streamseast|totalsportek|sportsurge|buffstream|crackstream|weakstream/i.test(
        host
      );
    }

    static isPlayerChrome(el) {
      return Boolean(
        el?.closest?.(
          [
            "video",
            "audio",
            "iframe",
            "object",
            "embed",
            "#player",
            "#vplayer",
            "#watch",
            ".player",
            ".video-player",
            ".jwplayer",
            ".plyr",
            ".video-js",
            ".html5-video-player",
            ".artplayer",
            ".dplayer",
            ".mejs__container",
            "media-controller",
            "media-control-bar",
            "[class*='player']",
            "[id*='player']",
            "[class*='embed']",
            "[class*='vjs']",
            "[class*='volume']",
            "[class*='control-bar']",
            "[class*='controlbar']",
            "[class*='media-control']",
            "[class*='video-']",
            "[role='slider']",
          ].join(", ")
        )
      );
    }

    /** Rough eTLD+1: last two labels (good enough for hijack checks). */
    static registrableDomain(hostname) {
      const host = String(hostname || "")
        .replace(/^www\./, "")
        .toLowerCase();
      const parts = host.split(".").filter(Boolean);
      if (parts.length <= 2) return host;
      return parts.slice(-2).join(".");
    }

    static sameSite(url) {
      try {
        const target = new URL(url, location.href);
        if (target.protocol !== "http:" && target.protocol !== "https:") return true;
        return (
          SiteContext.registrableDomain(target.hostname) ===
          SiteContext.registrableDomain(location.hostname)
        );
      } catch {
        return true;
      }
    }
  }

  /** Known ad / affiliate / popunder destinations. */
  class HijackUrlMatcher {
    static #BAD =
      /s\.click\.aliexpress\.com|click\.aliexpress\.com|s\.click\.taobao\.com|1xlite-|1xbet|1xstavka|refpa\.top|refpaiwqns|mostbet\.com|melbet\.com|linebet\.com|betwinner\.com|trip\.com[^"'\s]*Allianceid=|trip\.com[^"'\s]*trip_sub1=|trip\.com[^"'\s]*[?&]SID=|popads\.net|propellerads|exoclick|juicyads|ouo\.io|adf\.ly|onclkds|onclicksuper|trafficjunky|clickadu|hilltopads|adsterra|adcash|popcash|popmyads|shorte\.st|bc\.vc|adfly|profitableratecpm|trafficstars|admaven|adspyglass|route\.cpm|redirect\.cpm|go\.redirectingat\.com|shrsl\.com|linksynergy|pjatr\.com|anrdoezrs\.net|dpbolvw\.net|tkqlhce\.com|jdoqocy\.com|kqzyfj\.com/i;

    static isBad(url) {
      return HijackUrlMatcher.#BAD.test(String(url || ""));
    }

    static isBlank(url) {
      const target = String(url ?? "");
      return !target || target === "about:blank" || target === "blank";
    }
  }

  class UrlHelper {
    static hrefOf(el) {
      if (!(el instanceof Element)) return "";
      return (
        el.getAttribute?.("href") ||
        el.getAttribute?.("data-href") ||
        el.getAttribute?.("data-url") ||
        el.getAttribute?.("data-link") ||
        ""
      );
    }

    static resolve(href) {
      try {
        return new URL(href, location.href).href;
      } catch {
        return href;
      }
    }
  }

  /**
   * Detects full-viewport (or large) transparent layers that steal clicks.
   * Algorithm: scan positioned elements; score by coverage × invisibility × z-index.
   */
  class OverlayDetector {
    static #ATTR = "data-adblock-lite-clickjack";

    /**
     * @param {Element} el
     * @returns {boolean}
     */
    static looksLikeClickjack(el) {
      if (!(el instanceof HTMLElement)) return false;
      if (el === document.documentElement || el === document.body) return false;
      if (SiteContext.isPlayerChrome(el)) return false;
      // Player shells / control layers often wrap the media element.
      if (el.querySelector?.("video, audio, iframe[src], input, [role='slider']")) {
        return false;
      }
      if (el.closest("video, audio, iframe, [role='dialog'], dialog, form, nav, header")) {
        // dialogs can be large; only flag if also invisible
      }

      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (style.pointerEvents === "none") return false;

      const position = style.position;
      if (position !== "fixed" && position !== "absolute" && position !== "sticky") return false;

      const rect = el.getBoundingClientRect();
      const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
      const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
      if (vw < 100 || vh < 100) return false;

      const coverX = Math.min(rect.width, vw) / vw;
      const coverY = Math.min(rect.height, vh) / vh;
      const coversMost = coverX >= 0.7 && coverY >= 0.45;
      const coversStrip = coverX >= 0.9 && coverY >= 0.25;
      if (!coversMost && !coversStrip) return false;

      const opacity = Number.parseFloat(style.opacity);
      const bg = style.backgroundColor || "";
      const transparentBg =
        bg === "transparent" ||
        bg === "rgba(0, 0, 0, 0)" ||
        /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)/i.test(bg);
      const nearlyInvisible = Number.isFinite(opacity) && opacity <= 0.15;
      const emptyish = (el.innerText || "").trim().length < 40;

      const z = Number.parseInt(style.zIndex, 10);
      const highZ = Number.isFinite(z) && z >= 1000;

      // Classic clickjack: huge invisible/near-invisible layer above content
      if ((nearlyInvisible || transparentBg) && (highZ || coversMost) && emptyish) return true;

      // Full-page off-site anchor wrapper
      if (el.tagName === "A" && coversMost) {
        const href = UrlHelper.hrefOf(el);
        if (href && !SiteContext.sameSite(UrlHelper.resolve(href))) return true;
        // Stream sites: huge same-site home/bounce anchors over the player
        if (SiteContext.isStreamSite() && href) {
          try {
            const next = new URL(UrlHelper.resolve(href));
            if (next.pathname === "/" || next.pathname === "") return true;
          } catch {
            // ignore
          }
        }
      }

      // Fixed layer with only an off-site link and little text
      if (coversMost && emptyish && highZ) {
        const link = el.tagName === "A" ? el : el.querySelector("a[href]");
        if (link) {
          const href = UrlHelper.hrefOf(link);
          if (href && !SiteContext.sameSite(UrlHelper.resolve(href))) return true;
          if (SiteContext.isStreamSite() && href) {
            try {
              const next = new URL(UrlHelper.resolve(href), location.href);
              if (next.pathname === "/" || next.pathname === "") return true;
            } catch {
              // ignore
            }
          }
        }
      }

      // Transparent / empty layer covering the player box on stream sites
      if (SiteContext.isStreamSite() && (nearlyInvisible || transparentBg) && emptyish) {
        const player = document.querySelector(
          "video, iframe[src*='embed'], iframe[src*='player'], #player, .jwplayer, .plyr, .video-js"
        );
        if (player instanceof Element) {
          const pr = player.getBoundingClientRect();
          if (pr.width > 80 && pr.height > 80) {
            const overlapX = Math.max(
              0,
              Math.min(rect.right, pr.right) - Math.max(rect.left, pr.left)
            );
            const overlapY = Math.max(
              0,
              Math.min(rect.bottom, pr.bottom) - Math.max(rect.top, pr.top)
            );
            if (overlapX / pr.width >= 0.6 && overlapY / pr.height >= 0.6) return true;
          }
        }
      }

      return false;
    }

    /** @returns {HTMLElement[]} */
    static findAll() {
      const candidates = document.querySelectorAll(
        "a, div, section, aside, span, iframe, [style*='fixed'], [style*='absolute']"
      );
      const hits = [];
      for (const el of candidates) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.hasAttribute(OverlayDetector.#ATTR)) continue;
        if (OverlayDetector.looksLikeClickjack(el)) hits.push(el);
      }
      return hits;
    }

    /** @param {HTMLElement} el */
    static neutralize(el) {
      el.setAttribute(OverlayDetector.#ATTR, "1");
      el.style.setProperty("pointer-events", "none", "important");
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      if (el.tagName === "A") {
        el.removeAttribute("href");
        el.removeAttribute("data-href");
        el.removeAttribute("data-url");
      }
      el.onclick = null;
      el.removeAttribute("onclick");
      EventBus.emit({
        kind: "hijack",
        title: "Neutralized click-jack overlay",
        detail: (el.tagName || "EL").toLowerCase(),
        selector: "[class*='overlay' i],[class*='popup' i],[class*='modal' i]",
      });
    }
  }

  class OverlayJanitor {
    constructor() {
      this._timer = 0;
      this._observer = null;
      this._scheduled = false;
    }

    start() {
      this.sweep();
      this._timer = window.setInterval(() => this.sweep(), 1500);
      this._observer = new MutationObserver(() => this.schedule());
      if (document.documentElement) {
        this._observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    }

    schedule() {
      if (this._scheduled) return;
      this._scheduled = true;
      setTimeout(() => {
        this._scheduled = false;
        this.sweep();
      }, 300);
    }

    sweep() {
      for (const el of OverlayDetector.findAll()) {
        OverlayDetector.neutralize(el);
      }
    }
  }

  /**
   * window.open policy:
   * - allow about:blank (players)
   * - block known ad networks
   * - block cross-site opens after an overlay click (hijack)
   * - block cross-site opens with no recent user gesture (popunders)
   * - allow cross-site opens from a real trusted click (share / OAuth)
   */
  class WindowOpenGuard {
    static #lastTrustedClickAt = 0;

    static install() {
      document.addEventListener(
        "click",
        (event) => {
          if (event.isTrusted) WindowOpenGuard.#lastTrustedClickAt = Date.now();
        },
        true
      );

      const originalOpen = window.open;
      window.open = function patchedOpen(url, ...rest) {
        try {
          if (!ClickPathGuard.enabled()) {
            return originalOpen.apply(this, [url, ...rest]);
          }
          if (HijackUrlMatcher.isBlank(url)) {
            return originalOpen.apply(this, [url, ...rest]);
          }
          const href = String(url);
          if (HijackUrlMatcher.isBad(href)) return null;

          if (!SiteContext.sameSite(href)) {
            const recentClick = Date.now() - WindowOpenGuard.#lastTrustedClickAt < 2000;
            if (!recentClick) return null;
            if (LocationHijackGuard.wasOverlayGesture()) return null;
          }
        } catch {
          // fall through
        }
        return originalOpen.apply(this, [url, ...rest]);
      };
    }
  }

  /**
   * Capture-phase click shield:
   * 1) block known bad destinations
   * 2) if top element at point is a clickjack overlay → neutralize + stop
   * 3) block off-site navigation from overlay / bait anchors under the cursor
   */
  class ClickPathGuard {
    static enabled() {
      const root = document.documentElement;
      if (!root) return true;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-adblock-lite-clickguard") !== "off";
    }

    static install() {
      const block = (event) => {
        if (!ClickPathGuard.enabled()) return;
        if (SiteContext.isPlayerChrome(event.target)) return;

        const x = event.clientX;
        const y = event.clientY;
        const topEl =
          Number.isFinite(x) && Number.isFinite(y)
            ? document.elementFromPoint(x, y)
            : event.target;

        if (topEl instanceof HTMLElement && OverlayDetector.looksLikeClickjack(topEl)) {
          OverlayDetector.neutralize(topEl);
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          return;
        }

        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        for (const node of path) {
          if (!(node instanceof Element)) continue;
          if (SiteContext.isPlayerChrome(node)) return;

          if (node instanceof HTMLElement && OverlayDetector.looksLikeClickjack(node)) {
            OverlayDetector.neutralize(node);
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
          }

          const href = UrlHelper.hrefOf(node);
          if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
          const absolute = UrlHelper.resolve(href);

          if (HijackUrlMatcher.isBad(absolute)) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
          }

          if (
            node instanceof HTMLElement &&
            !SiteContext.sameSite(absolute) &&
            OverlayDetector.looksLikeClickjack(node)
          ) {
            OverlayDetector.neutralize(node);
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
          }
        }
      };

      document.addEventListener("click", block, true);
      document.addEventListener("auxclick", block, true);
      document.addEventListener("mousedown", block, true);
    }
  }

  /**
   * Soft navigation freeze for stream pages.
   * Blocks scripted location.assign/replace/href jumps away from a deep URL
   * unless the user just clicked a real (non-overlay) anchor.
   */
  class SoftNavGuard {
    static #entryPath = location.pathname || "/";
    static #lastRealAnchorAt = 0;
    static #armed = false;

    static install() {
      SoftNavGuard.#armed = SiteContext.isStreamSite() && SoftNavGuard.#entryPath.length > 2;
      if (!SoftNavGuard.#armed) {
        // Still hook for cross-site / bad URLs via LocationHijackGuard
      }

      document.addEventListener(
        "click",
        (event) => {
          if (!event.isTrusted) return;
          const path = typeof event.composedPath === "function" ? event.composedPath() : [];
          for (const node of path) {
            if (!(node instanceof Element)) continue;
            if (SiteContext.isPlayerChrome(node)) return;
            if (node instanceof HTMLElement && OverlayDetector.looksLikeClickjack(node)) return;
            const href = UrlHelper.hrefOf(node);
            if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
            SoftNavGuard.#lastRealAnchorAt = Date.now();
            return;
          }
        },
        true
      );
    }

    static recentRealAnchor(ms = 2000) {
      return Date.now() - SoftNavGuard.#lastRealAnchorAt < ms;
    }

    /**
     * @param {string} url
     * @returns {boolean} true = block navigation
     */
    static shouldBlock(url) {
      if (!ClickPathGuard.enabled()) return false;
      try {
        const next = new URL(String(url), location.href);
        if (next.protocol !== "http:" && next.protocol !== "https:") return false;
        if (HijackUrlMatcher.isBad(next.href)) {
          EventBus.emit({
            kind: "hijack",
            title: "Blocked bad redirect",
            detail: next.hostname,
          });
          return true;
        }

        if (!SiteContext.sameSite(next.href)) {
          if (LocationHijackGuard.wasOverlayGesture()) {
            EventBus.emit({
              kind: "soft_nav",
              title: "Blocked overlay off-site jump",
              detail: next.hostname,
            });
            return true;
          }
          if (!SoftNavGuard.recentRealAnchor(2000)) {
            EventBus.emit({
              kind: "soft_nav",
              title: "Blocked surprise off-site navigation",
              detail: next.hostname,
            });
            return true;
          }
          return false;
        }

        if (!SoftNavGuard.#armed && !SiteContext.isStreamSite()) return false;
        if (SoftNavGuard.recentRealAnchor(2000)) return false;

        const cur = new URL(location.href);
        if (next.href.split("#")[0] === cur.href.split("#")[0]) return false;

        const nextDepth = next.pathname.split("/").filter(Boolean).length;
        const curDepth = cur.pathname.split("/").filter(Boolean).length;
        if (next.pathname === "/" || next.pathname === "") {
          EventBus.emit({
            kind: "soft_nav",
            title: "Blocked bounce to homepage",
            detail: cur.pathname,
          });
          return true;
        }
        if (curDepth >= 2 && nextDepth <= 1) {
          EventBus.emit({
            kind: "soft_nav",
            title: "Blocked shallow-path hijack",
            detail: `${cur.pathname} → ${next.pathname}`,
          });
          return true;
        }

        if (SiteContext.isStreamSite() && !SoftNavGuard.recentRealAnchor(2000)) {
          if (next.pathname !== cur.pathname) {
            EventBus.emit({
              kind: "soft_nav",
              title: "Blocked scripted in-site navigation",
              detail: next.pathname,
            });
            return true;
          }
        }
      } catch {
        // ignore
      }
      return false;
    }
  }

  /**
   * Soft-block location hijacks via assign/replace/href.
   */
  class LocationHijackGuard {
    static #lastGestureAt = 0;
    static #gestureWasOverlay = false;

    static wasOverlayGesture() {
      return (
        LocationHijackGuard.#gestureWasOverlay &&
        Date.now() - LocationHijackGuard.#lastGestureAt < 2000
      );
    }

    static install() {
      SoftNavGuard.install();

      document.addEventListener(
        "click",
        (event) => {
          LocationHijackGuard.#lastGestureAt = Date.now();
          const top = document.elementFromPoint(event.clientX, event.clientY);
          LocationHijackGuard.#gestureWasOverlay =
            top instanceof HTMLElement && OverlayDetector.looksLikeClickjack(top);
        },
        true
      );

      const wrap = (fnName) => {
        const original = location[fnName].bind(location);
        location[fnName] = function patched(url) {
          try {
            if (SoftNavGuard.shouldBlock(url)) return;
          } catch {
            // fall through
          }
          return original(url);
        };
      };

      try {
        wrap("assign");
        wrap("replace");
      } catch {
        // some browsers freeze location methods
      }

      // location.href = ... (common on stream mirrors)
      try {
        const desc =
          Object.getOwnPropertyDescriptor(Location.prototype, "href") ||
          Object.getOwnPropertyDescriptor(location, "href");
        if (desc?.set) {
          Object.defineProperty(location, "href", {
            configurable: true,
            enumerable: true,
            get: desc.get ? desc.get.bind(location) : () => String(location),
            set(value) {
              if (SoftNavGuard.shouldBlock(value)) return;
              desc.set.call(location, value);
            },
          });
        }
      } catch {
        // ignore locked location
      }
    }
  }

  class ClickGuardApp {
    start() {
      if (SiteContext.isYouTube() || SiteContext.isCanva()) return;
      LocationHijackGuard.install();
      WindowOpenGuard.install();
      ClickPathGuard.install();

      const janitor = new OverlayJanitor();
      const baseSweep = OverlayJanitor.prototype.sweep;
      janitor.sweep = function sweep() {
        if (!ClickPathGuard.enabled()) return;
        baseSweep.call(this);
      };
      janitor.start();
      // Stream sites inject overlays quickly — sweep more often.
      if (SiteContext.isStreamSite()) {
        window.setInterval(() => {
          if (ClickPathGuard.enabled()) janitor.sweep();
        }, 600);
      }
    }
  }

  new ClickGuardApp().start();
})();
