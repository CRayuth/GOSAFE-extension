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

    /** Gmail / Workspace — MAIN-world patches cause Gmail error #2014. */
    static isGoogleApp() {
      const host = SiteContext.hostname();
      if (host === "gmail.com" || host.endsWith(".gmail.com")) return true;
      if (host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")) {
        return true;
      }
      if (!(host === "google.com" || host.endsWith(".google.com"))) return false;
      return /^(mail|accounts|docs|drive|calendar|meet|chat|contacts|photos|sheets|slides|classroom|keep|script|sites|admin|myaccount|workspace|ogs|hangouts|inbox|tasks|news|play)\./i.test(
        host
      );
    }

    /** Facebook / Messenger / Instagram — overlays + scriptlets corrupt buttons. */
    static isMetaApp() {
      const host = SiteContext.hostname();
      return (
        host === "facebook.com" ||
        host.endsWith(".facebook.com") ||
        host === "fb.com" ||
        host.endsWith(".fb.com") ||
        host === "messenger.com" ||
        host.endsWith(".messenger.com") ||
        host === "instagram.com" ||
        host.endsWith(".instagram.com") ||
        host === "meta.com" ||
        host.endsWith(".meta.com") ||
        host === "threads.net" ||
        host.endsWith(".threads.net") ||
        host === "whatsapp.com" ||
        host.endsWith(".whatsapp.com")
      );
    }

    /** NVIDIA portals — heavy SPA UI. */
    static isNvidiaApp() {
      const host = SiteContext.hostname();
      return (
        host === "nvidia.com" ||
        host.endsWith(".nvidia.com") ||
        host === "nvidiagrid.net" ||
        host.endsWith(".nvidiagrid.net") ||
        host === "auth0.com" ||
        host.endsWith(".auth0.com")
      );
    }

    static isEducationLms() {
      const h = SiteContext.hostname();
      if (/\.edu(\.[a-z]{2})?$/i.test(h) || /\.ac\.[a-z]{2}$/i.test(h)) return true;
      if (
        /^(moodle|canvas|blackboard|brightspace|schoology|classroom|elearning|e-learning|lms)\./i.test(
          h
        )
      ) {
        return true;
      }
      return /moodle|elearning|instructure\.com|blackboard|brightspace|schoology/i.test(h);
    }

    static isSoftPageExempt() {
      return (
        SiteContext.isGoogleApp() ||
        SiteContext.isMetaApp() ||
        SiteContext.isNvidiaApp() ||
        SiteContext.isCanva() ||
        SiteContext.isEducationLms()
      );
    }

    /** Sites whose product UI uses large fixed overlays / dialogs. */
    static isDialogSensitive() {
      const host = SiteContext.hostname();
      return (
        host === "github.com" ||
        host.endsWith(".github.com") ||
        host === "gitlab.com" ||
        host.endsWith(".gitlab.com") ||
        host === "bitbucket.org" ||
        host.endsWith(".bitbucket.org") ||
        host === "notion.so" ||
        host.endsWith(".notion.so") ||
        host === "figma.com" ||
        host.endsWith(".figma.com") ||
        host === "linear.app" ||
        host.endsWith(".linear.app") ||
        host === "atlassian.net" ||
        host.endsWith(".atlassian.net")
      );
    }

    /** Sports / illegal-stream / movie mirrors that inject home/ad bounce scripts. */
    static isStreamSite() {
      const host = SiteContext.hostname();
      const path = (location.pathname || "").toLowerCase();
      if (
        /stream|sport|soccer|football|fight|nba|nfl|mlb|nhl|footy|kick|playoff|live|liveru|livetv|streameast|streamseast|totalsportek|sportsurge|buffstream|crackstream|weakstream|movie|film|khhd|anime|drama|series|rbtv|rbtvplus|superabbit|rbgoal/i.test(
          host
        )
      ) {
        return true;
      }
      return /\/(soccer|football|live|match|stream|watch|movie|episode|play)\b/i.test(path);
    }

    /** Third-party embed / HLS hosts — never treat as hijacks. */
    static isStreamEmbedHost(hostname) {
      const h = String(hostname || "").toLowerCase();
      return /(?:^|\.)(rpmvip\.com|filemoon\.|streamwish\.|streamtape\.|rabbitstream\.|megacloud\.|vidsrc\.|dood\.|mixdrop\.|mp4upload\.|voe\.sx|kwik\.|moviekhhd\.|khfullhd\.|khanime\.|bunnycdn\.|mediadelivery\.|cloudflarestream\.|jwplayer\.|jwpcdn\.|plyr\.io|googlevideo\.com|tcxru135mdqf\.ru|ta2mnt200stayr2\.cfd)/i.test(
        h
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

  /** Known ad / affiliate / popunder / play-button hijack destinations. */
  class HijackUrlMatcher {
    static #BAD =
      /s\.click\.aliexpress\.com|click\.aliexpress\.com|s\.click\.taobao\.com|1xlite-|1xbet|1xstavka|refpa\.top|refpaiwqns|mostbet\.com|melbet\.com|linebet\.com|betwinner\.com|trip\.com[^"'\s]*Allianceid=|trip\.com[^"'\s]*trip_sub1=|trip\.com[^"'\s]*[?&]SID=|popads\.net|propellerads|exoclick|juicyads|ouo\.io|adf\.ly|onclkds|onclicksuper|trafficjunky|clickadu|hilltopads|adsterra|adcash|popcash|popmyads|shorte\.st|bc\.vc|adfly|profitableratecpm|trafficstars|admaven|adspyglass|route\.cpm|redirect\.cpm|go\.redirectingat\.com|shrsl\.com|linksynergy|pjatr\.com|anrdoezrs\.net|dpbolvw\.net|tkqlhce\.com|jdoqocy\.com|kqzyfj\.com|spinreward\.|rewardspin\.|bk8top\.|free.?spin.?reward|claim.?your.?reward|lucky.?spin|zone_id=\d+.*conversions_tracking=|conversions_tracking=.*zone_id=/i;

    static isRewardScam(url) {
      const s = String(url || "");
      if (/spinreward\.|rewardspin\.|bk8top\.|spin-to-win|spintowin|freespin|claim-?reward|lucky.?spin|reward.?click/i.test(s)) {
        return true;
      }
      // Typical CPA popunder query shape used on pirate play buttons
      if (/[?&]conversions_tracking=/i.test(s) && /[?&]zone_id=/i.test(s)) return true;
      if (/\.(click|icu|cfd|sbs|buzz|top)(?:\/|$|\?)/i.test(s) && /spin|reward|bonus|gift|claim|prize/i.test(s)) {
        return true;
      }
      return false;
    }

    static isBad(url) {
      const s = String(url || "");
      return HijackUrlMatcher.#BAD.test(s) || HijackUrlMatcher.isRewardScam(s);
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
      // Movie sites disguise the real player as iframe.ads — never neutralize it.
      if (el.tagName === "IFRAME") {
        const name = (el.getAttribute("name") || "").toLowerCase();
        const cls = String(el.className || "").toLowerCase();
        const allow = (el.getAttribute("allow") || "").toLowerCase();
        const src = el.getAttribute("src") || el.src || "";
        if (name === "player" || name === "iframe_player") return false;
        if (/\b(player|embed|video)\b/.test(cls)) return false;
        if (allow.includes("autoplay") || allow.includes("fullscreen")) return false;
        try {
          if (src && SiteContext.isStreamEmbedHost(new URL(src, location.href).hostname)) {
            return false;
          }
        } catch {
          // ignore
        }
      }
      // Never touch real product dialogs / modal chrome (GitHub "See more", etc.)
      if (
        el.closest?.(
          "[role='dialog'], dialog, [aria-modal='true'], [data-portal], [id*='portal' i], [class*='Overlay' i], [class*='Popover' i], [class*='SelectMenu' i], #player, .player, [name='player']"
        )
      ) {
        return false;
      }
      if (SiteContext.isDialogSensitive()) return false;
      // Player shells / control layers often wrap the media element.
      if (el.querySelector?.("video, audio, iframe[src], input, [role='slider']")) {
        return false;
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
            try {
              const host = new URL(href, location.href).hostname;
              if (SiteContext.isStreamEmbedHost(host)) {
                return originalOpen.apply(this, [url, ...rest]);
              }
            } catch {
              // ignore
            }
            // Movie/stream watch pages: play-button hijacks open spin/CPA tabs
            if (SiteContext.isStreamSite()) return null;

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
        // Always allow player / embed destinations (iframe.location.href swaps).
        if (SiteContext.isStreamEmbedHost(next.hostname)) return false;
        if (HijackUrlMatcher.isBad(next.href)) {
          EventBus.emit({
            kind: "hijack",
            title: "Blocked bad redirect",
            detail: next.hostname,
          });
          return true;
        }

        if (!SiteContext.sameSite(next.href)) {
          // Watch pages: never navigate the top tab to ads/CPA on play
          if (SiteContext.isStreamSite()) {
            EventBus.emit({
              kind: "soft_nav",
              title: "Blocked play-button hijack",
              detail: next.hostname,
            });
            return true;
          }
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
      if (SiteContext.isYouTube() || SiteContext.isSoftPageExempt()) return;
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
