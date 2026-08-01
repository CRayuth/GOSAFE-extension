(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Site classification (strategy predicates)
  // ---------------------------------------------------------------------------

  class SiteContext {
    static hostname() {
      return (location.hostname || "").replace(/^www\./, "").toLowerCase();
    }

    static isTopFrame() {
      try {
        return window === window.top;
      } catch {
        return false;
      }
    }

    static isYouTube() {
      const host = SiteContext.hostname();
      return (
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com"
      );
    }

    static isMedium() {
      const host = SiteContext.hostname();
      return host === "medium.com" || host.endsWith(".medium.com");
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

    /** Suffix array of domain labels for longest→shortest host matching. */
    static hostnameVariants(hostname = location.hostname) {
      const host = (hostname || "").replace(/^www\./, "").toLowerCase();
      if (!host) return [];
      const parts = host.split(".");
      const variants = [];
      for (let i = 0; i < parts.length - 1; i += 1) {
        variants.push(parts.slice(i).join("."));
      }
      return variants;
    }

    static isMediaSite() {
      const host = (location.hostname || "").toLowerCase();
      const path = (location.pathname || "").toLowerCase();
      if (
        /anime|stream|sport|movie|film|watch|series|episode|vid(eo)?|play|manga|hentai|drama|kino|mov\.|fullhd|jwplayer|jwpcdn|streameast|streamseast|totalsportek|sportsurge|flix|fmovies|soap2/i.test(
          host
        )
      ) {
        return true;
      }
      if (/\/(title|watch|movie|tv|embed|player|episode)\b/i.test(path)) {
        return true;
      }
      try {
        return Boolean(
          document.querySelector(
            "video, iframe[src*='embed'], iframe[src*='player'], iframe[src*='stream'], #player, .player, .video-player, .jwplayer, .plyr, .video-js, .jw-wrapper, #jwplayer, .artplayer"
          )
        );
      } catch {
        return false;
      }
    }

    /** Player iframe hosts — never inject annoyance CSS into the embed. */
    static isStreamEmbed() {
      const host = SiteContext.hostname();
      return (
        host.startsWith("stream.") ||
        host.endsWith(".jwpcdn.com") ||
        host === "jwpcdn.com" ||
        /^(filemoon|streamtape|streamwish|dood|rabbitstream|megacloud|vidsrc|kwik)\./i.test(host)
      );
    }

    static isPlayerChrome(el) {
      if (!(el instanceof Element)) return false;
      return Boolean(
        el.closest(
          "video, audio, iframe, object, embed, #player, #vplayer, #watch, .player, .video-player, .jwplayer, .plyr, .video-js, .html5-video-player, .artplayer, .dplayer, .mejs__container, media-controller, [class*='player'], [id*='player'], [class*='embed'], [class*='vjs'], [class*='volume'], [class*='control-bar'], [class*='controlbar'], [class*='media-control'], [class*='video-'], [role='slider']"
        )
      );
    }
  }

  class ProtectionPolicy {
    static DEFAULT_FEATURES = Object.freeze({
      cosmetics: true,
      clickGuard: true,
      youtubeSkip: true,
      spotifySkip: true,
      mediumUnlock: true,
      loginWallBypass: true,
      downloadGuard: true,
      httpsUpgrade: true,
      clipboardGuard: true,
      scriptlets: true,
      webrtcGuard: true,
      permissionGuard: true,
      randomUa: false,
      phishingGuard: true,
      fingerprintGuard: false,
      listAutoUpdate: true,
      cookieConsent: true,
      popupBlocker: true,
      antiAdblock: true,
      autoplayBlock: true,
      strictTracking: false,
      minerBlock: true,
      malwareWarn: true,
      quietMode: false,
      adaptiveLearn: true,
      trustScore: true,
      privacyMode: false,
      securityWatch: true,
      trackerLearn: true,
      privacySignals: true,
    });

    /**
     * @param {{ enabled?: boolean, features?: object, pausedHosts?: string[], siteRules?: object, protectionProfile?: string, tempAllows?: object, siteFeatureOverrides?: object }} raw
     */
    constructor(raw = {}) {
      this.enabled = raw.enabled !== false;
      this.pausedHosts = Array.isArray(raw.pausedHosts) ? raw.pausedHosts : [];
      this.siteRules = raw.siteRules && typeof raw.siteRules === "object" ? raw.siteRules : {};
      this.tempAllows = raw.tempAllows && typeof raw.tempAllows === "object" ? raw.tempAllows : {};
      this.siteFeatureOverrides =
        raw.siteFeatureOverrides && typeof raw.siteFeatureOverrides === "object"
          ? raw.siteFeatureOverrides
          : {};
      this.protectionProfile = ProtectionPolicy.sanitizeProfile(
        raw.protectionProfile,
        raw.features
      );
      const base = { ...ProtectionPolicy.DEFAULT_FEATURES, ...(raw.features || {}) };
      const host = SiteContext.hostname();
      const override = ProtectionPolicy.#overrideFor(host, this.siteFeatureOverrides);
      this.features = { ...base, ...override };
    }

    /** @param {string} host @param {Record<string, Record<string, boolean>>} map */
    static #overrideFor(host, map) {
      if (!host || !map) return {};
      const parts = host.split(".").filter(Boolean);
      for (let i = 0; i < parts.length - 1; i += 1) {
        const suffix = parts.slice(i).join(".");
        if (map[suffix] && typeof map[suffix] === "object") return map[suffix];
      }
      return map[host] && typeof map[host] === "object" ? map[host] : {};
    }

    /** @param {unknown} raw @param {object} [features] */
    static sanitizeProfile(raw, features) {
      const v = String(raw || "").toLowerCase();
      if (v === "speed" || v === "light" || v === "advanced") return v;
      if (features && features.speedMode === false) return "advanced";
      if (features && features.speedMode === true) return "speed";
      return "light";
    }

    static async load() {
      const raw = await chrome.storage.local.get({
        enabled: true,
        features: ProtectionPolicy.DEFAULT_FEATURES,
        pausedHosts: [],
        siteRules: {},
        protectionProfile: "light",
        tempAllows: {},
        siteFeatureOverrides: {},
      });
      return new ProtectionPolicy(raw);
    }

    isSitePaused() {
      const host = SiteContext.hostname();
      return this.pausedHosts.includes(host);
    }

    /** Temporary whitelist still active for this host. */
    isTempAllowed() {
      const host = SiteContext.hostname();
      const exp = Number(this.tempAllows[host]) || 0;
      return exp > Date.now();
    }

    /** Longest-suffix site rule: allow | block | default */
    siteMode() {
      if (this.isTempAllowed()) return "allow";
      const host = SiteContext.hostname();
      const parts = host.split(".").filter(Boolean);
      for (let i = 0; i < parts.length - 1; i += 1) {
        const suffix = parts.slice(i).join(".");
        const mode = this.siteRules[suffix];
        if (mode === "allow" || mode === "block") return mode;
      }
      return this.siteRules[host] === "allow" || this.siteRules[host] === "block"
        ? this.siteRules[host]
        : "default";
    }

    get active() {
      if (!this.enabled || this.isSitePaused()) return false;
      if (this.siteMode() === "allow") return false;
      return true;
    }

    /** User element hides still apply on Whitelist (explicit intent). */
    get customHidesActive() {
      return this.enabled && !this.isSitePaused();
    }

    /** Publish flags for MAIN-world scripts (clickguard / security-page / youtube-page). */
    publishDomFlags() {
      const root = document.documentElement;
      if (!root) return;
      const profile = this.protectionProfile || "light";
      const lightish = profile === "speed" || profile === "light";
      const on = (v) => (this.active && v ? "on" : "off");
      // Speed/Light skip expensive page spoofing (keeps network blocking).
      const uaOn = !lightish && this.features.randomUa;
      const fpOn = !lightish && this.features.fingerprintGuard;
      root.setAttribute("data-adblock-lite", this.active ? "on" : "off");
      root.setAttribute("data-adblock-lite-clickguard", on(this.features.clickGuard));
      root.setAttribute("data-adblock-lite-youtube", on(this.features.youtubeSkip));
      root.setAttribute(
        "data-adblock-lite-spotify",
        on(this.features.spotifySkip !== false)
      );
      root.setAttribute(
        "data-adblock-lite-loginwall",
        on(this.features.loginWallBypass !== false)
      );
      root.setAttribute("data-adblock-lite-clipboard", on(this.features.clipboardGuard));
      root.setAttribute("data-adblock-lite-scriptlets", on(this.features.scriptlets));
      root.setAttribute("data-adblock-lite-permissions", on(this.features.permissionGuard));
      root.setAttribute("data-adblock-lite-https", on(this.features.httpsUpgrade));
      root.setAttribute("data-adblock-lite-randomua", on(uaOn));
      root.setAttribute("data-adblock-lite-fingerprint", on(fpOn));
      root.setAttribute("data-adblock-lite-profile", profile);
      root.setAttribute("data-adblock-lite-cookie", on(this.features.cookieConsent !== false));
      root.setAttribute("data-adblock-lite-popup", on(this.features.popupBlocker !== false));
      root.setAttribute("data-adblock-lite-antiadblock", on(this.features.antiAdblock !== false));
      root.setAttribute("data-adblock-lite-autoplay", on(this.features.autoplayBlock !== false));
      root.setAttribute(
        "data-adblock-lite-quiet",
        this.active && this.features.quietMode ? "on" : "off"
      );
      root.setAttribute(
        "data-adblock-lite-tips",
        this.active && !this.features.quietMode ? "on" : "off"
      );
      root.setAttribute(
        "data-adblock-lite-adaptive",
        on(this.features.adaptiveLearn !== false)
      );
      root.setAttribute(
        "data-adblock-lite-secwatch",
        on(this.features.securityWatch !== false)
      );
    }

    /** Publish current UA string for MAIN-world JS spoofing. */
    async publishUa() {
      const root = document.documentElement;
      if (!root) return;
      const profile = this.protectionProfile || "light";
      if (!this.active || !this.features.randomUa || profile !== "advanced") {
        root.removeAttribute("data-adblock-lite-ua");
        return;
      }
      const { uaSettings } = await chrome.storage.local.get({ uaSettings: null });
      const ua = uaSettings?.current || "";
      if (ua) root.setAttribute("data-adblock-lite-ua", ua);
      else root.removeAttribute("data-adblock-lite-ua");
    }
  }

  /** Subtle HTTP warning when HTTPS upgrade could not secure the page. */
  class InsecurePageBanner {
    static #ID = "adblock-lite-insecure-banner";

    static maybeShow(policy) {
      if (!SiteContext.isTopFrame()) return;
      if (policy.features.quietMode) {
        InsecurePageBanner.remove();
        return;
      }
      if (!policy.active || !policy.features.httpsUpgrade) {
        InsecurePageBanner.remove();
        return;
      }
      if (location.protocol !== "http:") {
        InsecurePageBanner.remove();
        return;
      }
      if (document.getElementById(InsecurePageBanner.#ID)) return;

      const bar = document.createElement("div");
      bar.id = InsecurePageBanner.#ID;
      bar.setAttribute("role", "status");
      bar.textContent = "Not secure — this page is still on HTTP";
      bar.style.cssText = [
        "all:initial",
        "box-sizing:border-box",
        "position:fixed",
        "left:12px",
        "right:12px",
        "bottom:12px",
        "z-index:2147483646",
        "padding:10px 12px",
        "border-radius:8px",
        "background:#1a1a1a",
        "color:#f5f5f5",
        "font:500 12px/1.35 Roboto,Segoe UI,sans-serif",
        "box-shadow:0 8px 24px rgba(0,0,0,.28)",
        "pointer-events:none",
      ].join(";");
      (document.documentElement || document.body)?.appendChild(bar);
    }

    static remove() {
      document.getElementById(InsecurePageBanner.#ID)?.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // Selector catalogs (immutable data)
  // ---------------------------------------------------------------------------

  class SelectorCatalog {
    static FALLBACK = Object.freeze([
      "ins.adsbygoogle",
      ".adsbygoogle",
      ".adsbox",
      "#adsbox",
      ".ad-banner",
      ".adbanner",
      ".banner_ad",
      ".ad_banner",
      ".ad-placement",
      ".advertisement",
      ".ad-slot",
      ".pub_300x250",
      ".pub_300x250m",
      ".pub_728x90",
      ".text-ad",
      ".textAd",
      ".text_ad",
      // Flash / SWF placeholders (browsers show “no longer supported” boxes)
      'object[type*="shockwave-flash"]',
      'object[type*="x-shockwave-flash"]',
      'embed[type*="shockwave-flash"]',
      'embed[src*=".swf"]',
      'object[data*=".swf"]',
      'img[src*="/banners/"]',
      'img[src*="ads_banner"]',
      'img[src*="banner_ad"]',
      'img[src*="/ads/"]',
      "[id*='google_ads']",
      "[id*='googlead']",
      "[class*='google-ad']",
      "[class*='GoogleActiveView']",
      "[class*='adsbygoogle']",
      "[data-ad-slot]",
      "[data-ad-unit]",
      "[data-google-query-id]",
      "iframe[src*='doubleclick.net']",
      "iframe[src*='googlesyndication.com']",
      "iframe[src*='googletagservices.com']",
      "iframe[src*='amazon-adsystem.com']",
      "iframe[src*='adnxs.com']",
      "iframe[id*='google_ads']",
    ]);

    /** Host-specific cosmetics for adblock test pages / known banner wrappers. */
    static HOST_EXTRA = Object.freeze({
      "adblock-tester.com": [
        ".includeWrapper",
        ".include:has(object)",
        ".include:has(embed)",
        '.include:has(img[src*="banner"])',
        '.include:has(img[src*="/banners/"])',
        'object[data*="/banners/"]',
        'embed[src*="/banners/"]',
        'img[src*="/banners/"]',
      ],
      "d3ward.github.io": [
        ".ad-box",
        ".ads",
        "#ad-container",
      ],
    });

    static ANNOYANCE = Object.freeze([
      "#onetrust-banner-sdk",
      "#onetrust-consent-sdk",
      "#onetrust-pc-sdk",
      ".onetrust-pc-dark-filter",
      "#ot-sdk-btn-floating",
      ".ot-sdk-container",
      "#cookie-law-info-bar",
      "#cookie-law-info-again",
      ".cli-modal-backdrop",
      "#CybotCookiebotDialog",
      "#CybotCookiebotDialogBodyUnderlay",
      ".CybotCookiebotDialogActive",
      "#qc-cmp2-container",
      ".qc-cmp2-container",
      "#qc-cmp2-ui",
      ".fc-consent-root",
      ".fc-dialog-container",
      "#sp_message_container_1007248",
      "[id^='sp_message_container']",
      ".message-container[class*='sp_']",
      "#didomi-host",
      ".didomi-popup-container",
      ".didomi-notice",
      "#didomi-notice",
      ".cookiefirst-root",
      "#cookiefirst-root",
      ".cc-window",
      ".cc-banner",
      ".osano-cm-window",
      ".osano-cm-dialog",
      "#osano-cm-consent",
      ".cky-consent-container",
      ".cky-overlay",
      ".cky-modal",
      "#cookieConsent",
      "#cookie-consent",
      "#cookie_consent",
      "#cookieBanner",
      "#cookie-banner",
      "#cookie_banner",
      "#CookieBanner",
      "#cookieNotice",
      "#cookie-notice",
      "#gdpr-banner",
      "#gdpr-consent",
      "#gdprBanner",
      "#consent-banner",
      "#consent_banner",
      ".cookie-banner",
      ".cookie-consent",
      ".cookie-notice",
      ".cookie-popup",
      ".cookie-modal",
      ".cookieConsent",
      ".cookieBar",
      ".cookie-bar",
      ".cookies-banner",
      ".cookies-eu-banner",
      ".eu-cookie-banner",
      ".gdpr-banner",
      ".gdpr-consent",
      ".gdpr-popup",
      ".consent-banner",
      ".consent-modal",
      ".consent-popup",
      "[aria-label*='cookie' i][role='dialog']",
      "[aria-label*='consent' i][role='dialog']",
      "[class*='cookie-consent' i]",
      "[class*='cookieConsent' i]",
      "[class*='CookieConsent' i]",
      "[class*='cookie-banner' i]",
      "[class*='cookieBanner' i]",
      "[class*='cookies-banner' i]",
      "[id*='cookie-consent' i]",
      "[id*='cookieConsent' i]",
      "[id*='cookie-banner' i]",
      "[id*='Cookiebot' i]",
      "div[data-testid*='cookie' i]",
      "div[data-testid*='consent' i]",
      ".paywall",
      "#paywall",
      ".piano-paywall",
      "#piano-paywall",
      ".tp-modal",
      ".tp-backdrop",
      ".tp-iframe-wrapper",
      ".ev-open-modal",
      ".evolution-paywall",
      ".regwall",
      ".subscribe-wall",
      ".subscription-wall",
      "[class*='subscribe-modal' i]",
      "[class*='subscription-modal' i]",
      "[class*='premium-wall' i]",
      "#onesignal-slidedown-container",
      "#onesignal-bell-container",
      ".onesignal-slidedown-container",
      ".onesignal-bell-launcher",
      "[id*='onesignal' i]",
      ".push-notification",
      ".pushNotification",
      "[class*='push-notif' i]",
      "[class*='pushNotification' i]",
      "[class*='notification-modal' i]",
      "[class*='newsletter-popup' i]",
      "[class*='newsletter-modal' i]",
      "[class*='email-popup' i]",
      "[id*='newsletter-popup' i]",
      "[id*='newsletterPopup' i]",
      "[aria-label*='notification' i][role='dialog']",
      "[aria-label*='newsletter' i][role='dialog']",
      "[aria-label*='subscribe' i][role='dialog']",
    ]);

    static ANNOYANCE_HINT =
      /cookie|consent|gdpr|ccpa|onetrust|cookiebot|didomi|osano|quantcast|onesignal|push.?notif|newsletter[-_ ]?(popup|modal|banner)|subscribe[-_ ]?(modal|popup|wall)|email[-_ ]?(modal|popup)|#paywall$|\.paywall$|piano-paywall|regwall/i;

    /** Filter list selectors that look like cookie/paywall/push UI. */
    static filterAnnoyances(selectors) {
      return (selectors || []).filter((sel) => SelectorCatalog.ANNOYANCE_HINT.test(sel));
    }

    /** Union + dedupe preserving insertion order. */
    static uniqueMerge(...lists) {
      const seen = new Set();
      const out = [];
      for (const list of lists) {
        for (const item of list || []) {
          if (seen.has(item)) continue;
          seen.add(item);
          out.push(item);
        }
      }
      return out;
    }
  }

  // ---------------------------------------------------------------------------
  // Custom element hide (user picker) + CSS selector builder
  // ---------------------------------------------------------------------------

  class CssSelectorBuilder {
    static MAX_DEPTH = 8;
    static MAX_LEN = 280;

    /** @param {string} value */
    static escapeIdent(value) {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(value);
      }
      return String(value).replace(/([^\w-])/g, "\\$1");
    }

    /** @param {string} selector @param {Element} el */
    static matches(selector, el) {
      try {
        if (!selector || !(el instanceof Element)) return false;
        if (el.matches?.(selector)) return true;
        const hit = document.querySelector(selector);
        return hit === el;
      } catch {
        return false;
      }
    }

    /** @param {string} selector @param {Element} el */
    static isUnique(selector, el) {
      try {
        const nodes = document.querySelectorAll(selector);
        return nodes.length === 1 && nodes[0] === el;
      } catch {
        return false;
      }
    }

    /**
     * Stable path using nth-of-type (survives class renames better than class-only).
     * @param {Element} el
     * @returns {string}
     */
    static path(el) {
      const parts = [];
      let node = el;
      let depth = 0;
      while (
        node &&
        node.nodeType === 1 &&
        node !== document.documentElement &&
        depth < CssSelectorBuilder.MAX_DEPTH
      ) {
        if (node === document.body) {
          parts.unshift("body");
          break;
        }
        const name = node.tagName.toLowerCase();
        const parent = node.parentElement;
        let part = name;
        if (parent) {
          const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
          const idx = Math.max(1, siblings.indexOf(node) + 1);
          part = `${name}:nth-of-type(${idx})`;
        }
        parts.unshift(part);
        node = parent;
        depth += 1;
      }
      const sel = parts.join(">");
      return sel.length <= CssSelectorBuilder.MAX_LEN
        ? sel
        : sel.slice(0, CssSelectorBuilder.MAX_LEN);
    }

    /**
     * @param {Element} el
     * @returns {string}
     */
    static from(el) {
      if (!(el instanceof Element) || el === document.documentElement || el === document.body) {
        return "";
      }

      /** @type {string[]} */
      const candidates = [];

      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test");
      if (testId && testId.length < 80) {
        const safe = String(testId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        candidates.push(`[data-testid="${safe}"]`);
        candidates.push(`${el.tagName.toLowerCase()}[data-testid="${safe}"]`);
      }

      const id = el.getAttribute("id");
      if (id && /^[A-Za-z][\w:-]*$/.test(id)) {
        candidates.push(`#${CssSelectorBuilder.escapeIdent(id)}`);
      }

      const tag = el.tagName.toLowerCase();
      const classAttr = el.getAttribute("class") || "";
      const classes = classAttr
        .split(/\s+/)
        .filter((c) => c && !/[:[\].#]/.test(c) && c.length < 48 && !/^[0-9]/.test(c))
        .slice(0, 2)
        .map((c) => `.${CssSelectorBuilder.escapeIdent(c)}`);
      if (classes.length) {
        candidates.push(`${tag}${classes.join("")}`);
      }

      candidates.push(CssSelectorBuilder.path(el));

      for (const sel of candidates) {
        if (!sel) continue;
        if (CssSelectorBuilder.isUnique(sel, el) && CssSelectorBuilder.matches(sel, el)) {
          return sel;
        }
      }

      // Last resort: path even if not unique — still hides matching nodes.
      const fallback = CssSelectorBuilder.path(el);
      return CssSelectorBuilder.matches(fallback, el) ? fallback : "";
    }
  }

  class ElementPicker {
    static ROOT_ID = "adblock-lite-picker-root";
    static INSTANT_STYLE_ID = "adblock-lite-picker-instant";

    /**
     * @param {(selector: string, el: Element) => Promise<boolean>} onPick
     */
    constructor(onPick) {
      /** @type {(selector: string, el: Element) => Promise<boolean>} */
      this._onPick = onPick;
      /** @type {HTMLElement | null} */
      this._root = null;
      /** @type {HTMLElement | null} */
      this._box = null;
      /** @type {HTMLElement | null} */
      this._tip = null;
      /** @type {Element | null} */
      this._hover = null;
      this._busy = false;
      this._onMove = (e) => this.#onMove(e);
      this._onPointer = (e) => this.#onPointer(e);
      this._onKey = (e) => this.#onKey(e);
    }

    get active() {
      return Boolean(this._root);
    }

    /** @param {Record<string, string>} styles */
    static #style(el, styles) {
      Object.assign(el.style, styles);
    }

    /** @param {string} tag @param {Record<string, string>} [styles] @param {string} [text] */
    static #el(tag, styles = {}, text = "") {
      const node = document.createElement(tag);
      ElementPicker.#style(node, styles);
      if (text) node.textContent = text;
      return node;
    }

    /** @param {string} text */
    #setTip(text) {
      if (!this._tip) return;
      // Keep caret as last child
      const caret = this._tip.querySelector("[data-abl-caret]");
      this._tip.childNodes.forEach((n) => {
        if (n !== caret) n.remove?.();
      });
      // Simpler: reset text and re-append caret
      const c = this._tip.querySelector("[data-abl-caret]");
      this._tip.textContent = text;
      if (c) this._tip.appendChild(c);
      else {
        const tipCaret = ElementPicker.#el("span", {
          position: "absolute",
          top: "-5px",
          left: "50%",
          width: "10px",
          height: "10px",
          transform: "translateX(-50%) rotate(45deg)",
          background: "#2a2a2a",
        });
        tipCaret.setAttribute("data-abl-caret", "1");
        this._tip.appendChild(tipCaret);
      }
    }

    start() {
      if (!SiteContext.isTopFrame() || this._root) return;
      this._busy = false;

      const root = ElementPicker.#el("div", {
        all: "initial",
        position: "fixed",
        inset: "0",
        zIndex: "2147483646",
        pointerEvents: "none",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      });
      root.id = ElementPicker.ROOT_ID;
      root.setAttribute("data-adblock-lite-picker", "1");

      const barWrap = ElementPicker.#el("div", {
        position: "fixed",
        top: "14px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "8px",
      });

      const bar = ElementPicker.#el("div", {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        padding: "6px 8px 6px 12px",
        borderRadius: "999px",
        background: "#0a0a0a",
        color: "#fff",
        boxShadow: "0 12px 40px rgba(0,0,0,.35)",
        border: "1px solid rgba(255,255,255,.08)",
        whiteSpace: "nowrap",
      });

      const brand = ElementPicker.#el("div", {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        paddingRight: "10px",
        marginRight: "4px",
        borderRight: "1px solid rgba(255,255,255,.14)",
      });
      const mark = ElementPicker.#el(
        "span",
        {
          width: "18px",
          height: "18px",
          borderRadius: "5px",
          background: "#fff",
          color: "#0a0a0a",
          display: "grid",
          placeItems: "center",
          fontSize: "11px",
          fontWeight: "800",
          lineHeight: "1",
        },
        "GS"
      );
      const brandText = ElementPicker.#el(
        "span",
        {
          fontSize: "13px",
          fontWeight: "700",
          letterSpacing: "-0.02em",
        },
        "GOSAFE adblock"
      );
      brand.append(mark, brandText);

      const actionHide = ElementPicker.#el("button", {
        all: "unset",
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        gap: "7px",
        padding: "8px 12px",
        borderRadius: "999px",
        cursor: "default",
        fontSize: "12.5px",
        fontWeight: "600",
        color: "#fff",
        background: "rgba(255,255,255,.1)",
      });
      actionHide.type = "button";
      const eye = ElementPicker.#el(
        "span",
        {
          fontSize: "13px",
          opacity: "0.9",
        },
        "◎"
      );
      actionHide.append(eye, document.createTextNode("Hide element"));

      const tip = ElementPicker.#el(
        "div",
        {
          position: "absolute",
          top: "calc(100% + 8px)",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "7px 10px",
          borderRadius: "8px",
          background: "#2a2a2a",
          color: "#fff",
          fontSize: "12px",
          fontWeight: "500",
          boxShadow: "0 8px 24px rgba(0,0,0,.28)",
          pointerEvents: "none",
          whiteSpace: "nowrap",
        },
        "Click an element on the page to hide it"
      );
      const tipCaret = ElementPicker.#el("span", {
        position: "absolute",
        top: "-5px",
        left: "50%",
        width: "10px",
        height: "10px",
        transform: "translateX(-50%) rotate(45deg)",
        background: "#2a2a2a",
      });
      tipCaret.setAttribute("data-abl-caret", "1");
      tip.appendChild(tipCaret);

      const actionWrap = ElementPicker.#el("div", {
        position: "relative",
        display: "inline-flex",
      });
      actionWrap.append(actionHide, tip);

      const divider = ElementPicker.#el("span", {
        width: "1px",
        height: "18px",
        margin: "0 6px",
        background: "rgba(255,255,255,.18)",
        flex: "0 0 auto",
      });

      const closeBtn = ElementPicker.#el(
        "button",
        {
          all: "unset",
          boxSizing: "border-box",
          width: "32px",
          height: "32px",
          display: "grid",
          placeItems: "center",
          borderRadius: "999px",
          cursor: "pointer",
          color: "rgba(255,255,255,.85)",
          fontSize: "16px",
          fontWeight: "500",
          lineHeight: "1",
        },
        "×"
      );
      closeBtn.type = "button";
      closeBtn.title = "Cancel (Esc)";
      closeBtn.setAttribute("aria-label", "Cancel element picker");
      closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.stop();
      });

      bar.append(brand, actionWrap, divider, closeBtn);
      barWrap.appendChild(bar);

      const box = ElementPicker.#el("div", {
        position: "fixed",
        border: "2px solid #0a0a0a",
        background: "rgba(10,10,10,.14)",
        borderRadius: "6px",
        pointerEvents: "none",
        display: "none",
        boxSizing: "border-box",
        boxShadow: "0 0 0 1px rgba(255,255,255,.35)",
      });

      root.append(box, barWrap);
      (document.documentElement || document.body).appendChild(root);
      this._root = root;
      this._box = box;
      this._tip = tip;

      document.addEventListener("pointermove", this._onMove, true);
      document.addEventListener("pointerdown", this._onPointer, true);
      document.addEventListener("click", this._onPointer, true);
      document.addEventListener("keydown", this._onKey, true);
      document.documentElement.style.cursor = "crosshair";
    }

    stop() {
      document.removeEventListener("pointermove", this._onMove, true);
      document.removeEventListener("pointerdown", this._onPointer, true);
      document.removeEventListener("click", this._onPointer, true);
      document.removeEventListener("keydown", this._onKey, true);
      document.documentElement.style.cursor = "";
      this._root?.remove();
      this._root = null;
      this._box = null;
      this._tip = null;
      this._hover = null;
      this._busy = false;
    }

    /** @param {PointerEvent | MouseEvent} event */
    #onMove(event) {
      const el = this.#targetFromPoint(event.clientX, event.clientY);
      this._hover = el;
      if (!el || !this._box) {
        if (this._box) this._box.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      Object.assign(this._box.style, {
        display: "block",
        top: `${Math.max(0, r.top)}px`,
        left: `${Math.max(0, r.left)}px`,
        width: `${Math.max(0, r.width)}px`,
        height: `${Math.max(0, r.height)}px`,
      });
    }

    /** @param {PointerEvent | MouseEvent} event */
    #onPointer(event) {
      if (this._busy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      if (
        event.target instanceof Element &&
        event.target.closest?.(`#${ElementPicker.ROOT_ID}`)
      ) {
        if (event.type === "click" || event.type === "pointerdown") {
          event.preventDefault();
          event.stopPropagation();
          if (event.target.closest?.('[aria-label="Cancel element picker"]')) {
            this.stop();
          }
        }
        return;
      }

      // Prefer pointerdown so site click handlers can't cancel the pick.
      if (event.type === "click") {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      const el = this._hover || this.#targetFromPoint(event.clientX, event.clientY);
      if (!el) {
        this.#setTip("Missed — hover a block, then click");
        return;
      }
      void this.#commit(el);
    }

    /** @param {Element} el */
    async #commit(el) {
      if (this._busy) return;
      this._busy = true;
      const selector = CssSelectorBuilder.from(el);
      if (!selector) {
        this._busy = false;
        this.#setTip("Couldn’t target that — try a parent box");
        return;
      }

      this.#setTip("Hiding…");
      try {
        // Instant visual hide (survives until CSS rule lands)
        el.setAttribute("data-abl-hidden", "1");
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");

        const ok = await this._onPick(selector, el);
        if (!ok) {
          el.removeAttribute("data-abl-hidden");
          el.style.removeProperty("display");
          el.style.removeProperty("visibility");
          this._busy = false;
          this.#setTip("Save failed — try again");
          return;
        }
        this.stop();
      } catch {
        this._busy = false;
        this.#setTip("Error — try again");
      }
    }

    /** @param {KeyboardEvent} event */
    #onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.stop();
      }
    }

    /**
     * @param {number} x
     * @param {number} y
     * @returns {Element | null}
     */
    #targetFromPoint(x, y) {
      const stack = document.elementsFromPoint(x, y);
      for (const node of stack) {
        if (!(node instanceof Element)) continue;
        if (node.closest?.(`#${ElementPicker.ROOT_ID}`)) continue;
        if (node === document.documentElement || node === document.body) continue;
        return node;
      }
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Style injection (chunked batches to stay under CSS size limits)
  // ---------------------------------------------------------------------------

  class StyleInjector {
    static BATCH = 400;
    static PREFIX = "adblock-lite-cosmetic";
    static USER_PREFIX = "adblock-lite-cosmetic-u";
    static ANNOYANCE_ID = "adblock-lite-annoyances";
    static OVERLAY_ID = "adblock-lite-overlay-guard";

    constructor() {
      /** @type {string[]} stack of injected style element ids */
      this._ids = [];
    }

    static hideRule(selectors) {
      if (!selectors.length) return "";
      return (
        `${selectors.join(",")},[data-abl-hidden="1"]` +
        "{display:none!important;visibility:hidden!important;pointer-events:none!important;height:0!important;max-height:0!important;overflow:hidden!important;}"
      );
    }

    inject(id, css) {
      if (!css) return;
      let style = document.getElementById(id);
      if (!style) {
        style = document.createElement("style");
        style.id = id;
        (document.documentElement || document.head || document.body).appendChild(style);
        if (!this._ids.includes(id)) this._ids.push(id);
      }
      style.textContent = css;
    }

    /** Chunk selectors into batches of BATCH (sliding window). */
    injectBatches(prefix, selectors) {
      let batchIndex = 0;
      for (let i = 0; i < selectors.length; i += StyleInjector.BATCH) {
        const chunk = selectors.slice(i, i + StyleInjector.BATCH);
        this.inject(`${prefix}-${batchIndex}`, StyleInjector.hideRule(chunk));
        batchIndex += 1;
      }
    }

    /** @param {string} prefix */
    clearPrefix(prefix) {
      const keep = [];
      for (const id of this._ids) {
        if (id === prefix || id.startsWith(`${prefix}-`)) {
          document.getElementById(id)?.remove();
        } else {
          keep.push(id);
        }
      }
      this._ids = keep;
    }

    clear() {
      for (const id of this._ids) document.getElementById(id)?.remove();
      this._ids.length = 0;
      document.getElementById(StyleInjector.OVERLAY_ID)?.remove();
      document.getElementById(StyleInjector.ANNOYANCE_ID)?.remove();
      document.getElementById(ElementPicker.INSTANT_STYLE_ID)?.remove();
    }
  }

  class ScrollUnlocker {
    static unlock() {
      try {
        // Don't fight media/player pages — removing body position breaks some players.
        if (SiteContext.isMediaSite()) return;
        const html = document.documentElement;
        const body = document.body;
        if (html) {
          html.style.removeProperty("overflow");
          html.classList.remove("no-scroll", "overflow-hidden", "cookie-open", "consent-open");
        }
        if (body) {
          body.style.removeProperty("overflow");
          body.style.removeProperty("position");
          body.classList.remove("no-scroll", "overflow-hidden", "modal-open", "cookie-open");
        }
      } catch {
        // ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cosmetics data repository (lazy singleton cache)
  // ---------------------------------------------------------------------------

  class CosmeticsRepository {
    constructor() {
      this._cache = null;
      this._loading = null;
    }

    async load() {
      if (this._cache) return this._cache;
      if (this._loading) return this._loading;

      this._loading = fetch(chrome.runtime.getURL("cosmetics-data.json"))
        .then((r) => r.json())
        .then((data) => {
          this._cache = data;
          return data;
        })
        .catch(() => {
          this._cache = { generic: [], specific: {} };
          return this._cache;
        });

      return this._loading;
    }

    /** Collect host-specific selectors via domain-suffix walk. */
    collectSpecific(data) {
      const specific = [];
      for (const host of SiteContext.hostnameVariants()) {
        const sels = data.specific?.[host];
        if (sels?.length) specific.push(...sels);
      }
      return SelectorCatalog.uniqueMerge(specific);
    }
  }

  // ---------------------------------------------------------------------------
  // Redirect / affiliate link guard
  // ---------------------------------------------------------------------------

  class RedirectPatternSet {
    static BAD =
      /s\.click\.aliexpress\.com|click\.aliexpress\.com|s\.click\.taobao\.com|1xlite-|1xbet|1xstavka|refpa\.top|refpaiwqns|mostbet\.com|melbet\.com|linebet\.com|betwinner\.com|trip\.com[^"'\s]*Allianceid=|trip\.com[^"'\s]*trip_sub1=|trip\.com[^"'\s]*[?&]SID=|popads\.net|propellerads|exoclick|juicyads|ouo\.io|adf\.ly|onclkds|onclicksuper|trafficjunky|clickadu|hilltopads|adsterra|adcash|popcash|popmyads|profitableratecpm|trafficstars|admaven|adspyglass|go\.redirectingat\.com|shrsl\.com/i;

    static isBad(href) {
      return RedirectPatternSet.BAD.test(href) || /Allianceid=|trip_sub1=/.test(href);
    }
  }

  class RedirectGuard {
    constructor(styles) {
      this._styles = styles;
      this._timer = 0;
      this._clickBound = false;
    }

    installClickGuard() {
      if (SiteContext.isYouTube() || this._clickBound) return;
      const blockIfBad = (event) => {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        for (const node of path) {
          if (!(node instanceof Element)) continue;
          if (SiteContext.isPlayerChrome(node)) continue;
          const href = node.getAttribute?.("href") || "";
          if (RedirectPatternSet.isBad(href)) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
          }
        }
      };
      document.addEventListener("click", blockIfBad, true);
      document.addEventListener("auxclick", blockIfBad, true);
      this._clickBound = true;
    }

    neutralizeDomLinks() {
      if (SiteContext.isYouTube()) return;
      const badLinks = document.querySelectorAll(
        "a[href*='s.click.aliexpress'], a[href*='click.aliexpress'], a[href*='s.click.taobao'], a[href*='1xlite-'], a[href*='1xbet'], a[href*='refpa.top'], a[href*='Allianceid='], a[href*='trip_sub1=']"
      );
      for (const el of badLinks) {
        const href = el.getAttribute("href") || "";
        if (!RedirectPatternSet.isBad(href)) continue;
        if (SiteContext.isPlayerChrome(el)) continue;
        el.removeAttribute("href");
        el.style.setProperty("pointer-events", "none", "important");
        el.style.setProperty("display", "none", "important");
      }
      ScrollUnlocker.unlock();
    }

    injectCss() {
      if (document.getElementById(StyleInjector.OVERLAY_ID) || SiteContext.isYouTube()) return;
      this._styles.inject(
        StyleInjector.OVERLAY_ID,
        `
a[href*="s.click.aliexpress.com"],
a[href*="click.aliexpress.com"],
a[href*="s.click.taobao.com"],
a[href*="1xlite-"],
a[href*="1xbet."],
a[href*="refpa.top"],
a[href*="trip.com"][href*="Allianceid="],
a[href*="trip.com"][href*="trip_sub1="] {
  display: none !important;
  pointer-events: none !important;
}`
      );
    }

    startWatch() {
      if (SiteContext.isYouTube() || SiteContext.isStreamEmbed() || this._timer) return;
      this.neutralizeDomLinks();
      this.injectCss();
      this._timer = window.setInterval(() => {
        this.neutralizeDomLinks();
        this.neutralizeClickjackOverlays();
        ScrollUnlocker.unlock();
      }, 1500);
    }

    /** Isolated-world backup: hide large transparent off-site traps. */
    neutralizeClickjackOverlays() {
      if (SiteContext.isYouTube() || SiteContext.isStreamEmbed()) return;
      const nodes = document.querySelectorAll("a, div, section, aside");
      const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
      const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
      if (vw < 100 || vh < 100) return;

      for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;
        if (SiteContext.isPlayerChrome(el)) continue;
        const style = getComputedStyle(el);
        if (style.pointerEvents === "none" || style.display === "none") continue;
        if (style.position !== "fixed" && style.position !== "absolute") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width / vw < 0.7 || rect.height / vh < 0.45) continue;
        const opacity = Number.parseFloat(style.opacity);
        const invisible = opacity <= 0.15 || style.backgroundColor === "transparent";
        const href =
          el.getAttribute("href") ||
          el.querySelector?.("a[href]")?.getAttribute("href") ||
          "";
        const offsite =
          href &&
          (() => {
            try {
              const u = new URL(href, location.href);
              const a = u.hostname.replace(/^www\./, "").split(".").slice(-2).join(".");
              const b = location.hostname.replace(/^www\./, "").split(".").slice(-2).join(".");
              return a !== b;
            } catch {
              return false;
            }
          })();
        const emptyish = (el.innerText || "").trim().length < 40;
        if ((invisible && emptyish) || (offsite && emptyish && invisible)) {
          el.style.setProperty("pointer-events", "none", "important");
          el.style.setProperty("display", "none", "important");
        }
      }
    }

    stopWatch() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cosmetic / annoyance application strategies
  // ---------------------------------------------------------------------------

  class CosmeticEngine {
    /**
     * @param {StyleInjector} styles
     * @param {CosmeticsRepository} repo
     * @param {RedirectGuard} redirects
     * @param {() => "speed"|"light"|"advanced"} [getProfile]
     */
    constructor(styles, repo, redirects, getProfile = () => "light") {
      this._styles = styles;
      this._repo = repo;
      this._redirects = redirects;
      this._getProfile = getProfile;
      this._idleHandle = 0;
    }

    applyAnnoyances(extra = []) {
      const all = SelectorCatalog.uniqueMerge(SelectorCatalog.ANNOYANCE, extra);
      this._styles.inject(StyleInjector.ANNOYANCE_ID, StyleInjector.hideRule(all));
      ScrollUnlocker.unlock();
    }

    applyFallbacks() {
      const host = SiteContext.hostname();
      const hostExtra = SelectorCatalog.HOST_EXTRA[host] || [];
      // also match without www
      const bare = host.replace(/^www\./, "");
      const more = SelectorCatalog.HOST_EXTRA[bare] || [];
      const merged = SelectorCatalog.uniqueMerge(
        SelectorCatalog.FALLBACK,
        [...hostExtra, ...more]
      );
      this._styles.injectBatches(`${StyleInjector.PREFIX}-fb`, merged);
    }

    async applyCustom() {
      if (!SiteContext.isTopFrame()) return;
      try {
        const data = await chrome.storage.local.get({
          customCosmetics: {},
          adaptiveCosmetics: {},
        });
        const map = data.customCosmetics && typeof data.customCosmetics === "object"
          ? data.customCosmetics
          : {};
        const adaptive =
          data.adaptiveCosmetics && typeof data.adaptiveCosmetics === "object"
            ? data.adaptiveCosmetics
            : {};
        const host = SiteContext.hostname();
        const seen = new Set();
        /** @type {string[]} */
        const selectors = [];
        const parts = host.split(".").filter(Boolean);
        const keys = [];
        for (let i = 0; i < parts.length - 1; i += 1) {
          keys.push(parts.slice(i).join("."));
        }
        if (host && !keys.includes(host)) keys.push(host);
        for (const key of keys) {
          for (const list of [map[key], adaptive[key]]) {
            if (!Array.isArray(list)) continue;
            for (const sel of list) {
              const s = String(sel || "").trim();
              if (!s || seen.has(s)) continue;
              seen.add(s);
              selectors.push(s);
            }
          }
        }
        if (selectors.length) {
          this._styles.clearPrefix(StyleInjector.USER_PREFIX);
          this._styles.injectBatches(StyleInjector.USER_PREFIX, selectors);
        } else {
          this._styles.clearPrefix(StyleInjector.USER_PREFIX);
        }
      } catch {
        // ignore
      }
    }

    /** @param {string[]} generics */
    #scheduleGenerics(generics) {
      if (this._idleHandle && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(this._idleHandle);
      }
      const inject = () => {
        this._idleHandle = 0;
        if (!generics.length) return;
        this._styles.injectBatches(`${StyleInjector.PREFIX}-g`, generics);
      };
      if (typeof requestIdleCallback === "function") {
        this._idleHandle = requestIdleCallback(inject, { timeout: 2500 });
      } else {
        this._idleHandle = window.setTimeout(inject, 400);
      }
    }

    async apply() {
      this._styles.clear();
      if (this._idleHandle) {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(this._idleHandle);
        else clearTimeout(this._idleHandle);
        this._idleHandle = 0;
      }

      // Never touch JW/player embed documents
      if (SiteContext.isStreamEmbed()) return;

      const profile = this._getProfile();

      try {
        if (!SiteContext.isTopFrame()) {
          this.applyAnnoyances();
          this.applyFallbacks();
          return;
        }

        if (SiteContext.isYouTube()) {
          this.applyAnnoyances();
          this.applyFallbacks();
          return;
        }

        if (SiteContext.isMedium()) {
          this.applyFallbacks();
          return;
        }

        // Canva is a full web app — EasyList generics break the editor
        if (SiteContext.isCanva()) {
          this.applyFallbacks();
          return;
        }

        // Streaming sites: light fallbacks + clickjack sweep (no EasyList player killers)
        if (SiteContext.isMediaSite()) {
          this.applyFallbacks();
          this._redirects.installClickGuard();
          this._redirects.startWatch();
          return;
        }

        this.applyAnnoyances();
        this.applyFallbacks();
        this._redirects.injectCss();
        this._redirects.startWatch();

        const data = await this._repo.load();
        const annoyanceFromLists = SelectorCatalog.filterAnnoyances(data.generic);
        const specificAnnoyance = [];
        for (const host of SiteContext.hostnameVariants()) {
          specificAnnoyance.push(...SelectorCatalog.filterAnnoyances(data.specific?.[host] || []));
        }
        this.applyAnnoyances([...annoyanceFromLists, ...specificAnnoyance]);

        // Site-specific first (cheap). Generics depend on profile.
        const specific = this._repo.collectSpecific(data);
        if (specific.length) {
          this._styles.injectBatches(`${StyleInjector.PREFIX}-s`, specific);
        }

        const generics = data.generic?.length ? data.generic : SelectorCatalog.FALLBACK;
        if (profile === "speed") {
          // Skip large generic CSS for max speed.
        } else if (profile === "light") {
          this.#scheduleGenerics(generics);
        } else {
          this._styles.injectBatches(`${StyleInjector.PREFIX}-g`, generics);
        }

        ScrollUnlocker.unlock();
      } finally {
        await this.applyCustom();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Controller
  // ---------------------------------------------------------------------------

  class ContentController {
    constructor() {
      this._styles = new StyleInjector();
      this._repo = new CosmeticsRepository();
      this._redirects = new RedirectGuard(this._styles);
      this._cosmetics = new CosmeticEngine(
        this._styles,
        this._repo,
        this._redirects,
        () => this._policy.protectionProfile || "light"
      );
      this._policy = new ProtectionPolicy();
      this._picker = new ElementPicker((selector) => this.#persistHide(selector));
    }

    /**
     * @param {string} selector
     * @returns {Promise<boolean>}
     */
    async #persistHide(selector) {
      // Optimistic CSS (also covers [data-abl-hidden])
      this._styles.inject(
        ElementPicker.INSTANT_STYLE_ID,
        StyleInjector.hideRule([selector])
      );
      try {
        const host = SiteContext.hostname();
        const res = await chrome.runtime.sendMessage({
          type: "addCustomCosmetic",
          host,
          selector,
        });
        if (!res || res.ok === false) return false;
        if (this._policy?.features?.adaptiveLearn !== false) {
          chrome.runtime
            .sendMessage({
              type: "observeAdaptive",
              host,
              selector,
              kind: "hide",
              detail: "user_hide",
            })
            .catch(() => {});
        }
        await this._cosmetics.applyCustom();
        document.getElementById(ElementPicker.INSTANT_STYLE_ID)?.remove();
        return true;
      } catch {
        return false;
      }
    }

    startPicker() {
      if (!SiteContext.isTopFrame()) return { ok: false, reason: "frame" };
      this._picker.start();
      return { ok: true };
    }

    stopPicker() {
      this._picker.stop();
      return { ok: true };
    }

    async start() {
      this._policy = await ProtectionPolicy.load();
      this._policy.publishDomFlags();
      await this._policy.publishUa();
      InsecurePageBanner.maybeShow(this._policy);
      if (!this._policy.active) {
        if (this._policy.customHidesActive) {
          await this._cosmetics.applyCustom();
        }
        return;
      }
      if (!this._policy.features.cosmetics) {
        if (this._policy.features.clickGuard && !SiteContext.isCanva()) {
          this._redirects.installClickGuard();
        }
        if (this._policy.customHidesActive) {
          await this._cosmetics.applyCustom();
        }
        return;
      }

      if (
        !SiteContext.isMedium() &&
        !SiteContext.isCanva() &&
        !SiteContext.isStreamEmbed() &&
        !SiteContext.isMediaSite()
      ) {
        this._cosmetics.applyAnnoyances();
      }
      if (
        this._policy.features.clickGuard &&
        !SiteContext.isStreamEmbed() &&
        !SiteContext.isCanva()
      ) {
        this._redirects.installClickGuard();
      }
      await this._cosmetics.apply();
    }

    async enable() {
      await this.start();
    }

    stop() {
      this._picker.stop();
      this._styles.clear();
      this._redirects.stopWatch();
      InsecurePageBanner.remove();
      document.documentElement?.setAttribute("data-adblock-lite", "off");
      document.documentElement?.setAttribute("data-adblock-lite-clickguard", "off");
      document.documentElement?.setAttribute("data-adblock-lite-youtube", "off");
      document.documentElement?.setAttribute("data-adblock-lite-spotify", "off");
      document.documentElement?.setAttribute("data-adblock-lite-loginwall", "off");
      document.documentElement?.setAttribute("data-adblock-lite-clipboard", "off");
      document.documentElement?.setAttribute("data-adblock-lite-scriptlets", "off");
      document.documentElement?.setAttribute("data-adblock-lite-permissions", "off");
      document.documentElement?.setAttribute("data-adblock-lite-https", "off");
      document.documentElement?.setAttribute("data-adblock-lite-randomua", "off");
      document.documentElement?.setAttribute("data-adblock-lite-fingerprint", "off");
      document.documentElement?.removeAttribute("data-adblock-lite-ua");
    }
  }

  const app = new ContentController();

  // MAIN-world clickguard → activity log + adaptive learn bridge
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "adblock-lite") return;
    if (data.type === "log") {
      const entry = data.entry;
      if (!entry?.kind || !entry?.title) return;
      try {
        chrome.runtime.sendMessage({ type: "logActivity", entry });
      } catch {
        // ignore
      }
      return;
    }
    if (data.type === "learn") {
      const entry = data.entry || {};
      try {
        chrome.runtime.sendMessage({
          type: "observeAdaptive",
          host: entry.host || SiteContext.hostname(),
          selector: entry.selector || "",
          detail: entry.detail || entry.title || "",
          kind: entry.kind || "dismiss",
        });
      } catch {
        // ignore
      }
      return;
    }
    if (data.type === "securityAlert") {
      const entry = data.entry;
      if (!entry?.title) return;
      try {
        chrome.runtime.sendMessage({ type: "securityAlert", entry });
      } catch {
        // ignore
      }
      return;
    }
    if (data.type === "securityMetric") {
      try {
        chrome.runtime.sendMessage({
          type: "securityMetric",
          metric: data.metric,
          host: SiteContext.hostname(),
          detail: data.detail || "",
        });
      } catch {
        // ignore
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message?.type;
    if (type === "startElementPicker") {
      sendResponse(app.startPicker());
      return false;
    }
    if (type === "stopElementPicker") {
      sendResponse(app.stopPicker());
      return false;
    }
    if (type === "getPageTrustHints") {
      try {
        const pageHost = SiteContext.hostname();
        let thirdPartyScripts = 0;
        for (const s of document.querySelectorAll("script[src]")) {
          try {
            const h = new URL(s.src, location.href).hostname.replace(/^www\./, "");
            if (h && h !== pageHost && !h.endsWith(`.${pageHost}`)) thirdPartyScripts += 1;
          } catch {
            // ignore
          }
        }
        sendResponse({ thirdPartyScripts });
      } catch {
        sendResponse({ thirdPartyScripts: 0 });
      }
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      !changes.enabled &&
      !changes.features &&
      !changes.pausedHosts &&
      !changes.uaSettings &&
      !changes.siteRules &&
      !changes.customCosmetics &&
      !changes.protectionProfile &&
      !changes.tempAllows &&
      !changes.siteFeatureOverrides &&
      !changes.adaptiveCosmetics
    ) {
      return;
    }

    // Custom cosmetics only — soft re-apply without tearing down picker state unnecessarily
    if (
      (changes.customCosmetics || changes.adaptiveCosmetics) &&
      !changes.enabled &&
      !changes.features &&
      !changes.pausedHosts &&
      !changes.uaSettings &&
      !changes.siteRules &&
      !changes.protectionProfile &&
      !changes.tempAllows &&
      !changes.siteFeatureOverrides
    ) {
      ProtectionPolicy.load().then(async (policy) => {
        app._policy = policy;
        if (!policy.customHidesActive) return;
        // Only refresh user hides — avoid clearing the whole page mid-click.
        await app._cosmetics.applyCustom();
      });
      return;
    }

    ProtectionPolicy.load().then(async (policy) => {
      app._policy = policy;
      policy.publishDomFlags();
      await policy.publishUa();

      // Live HTTPS upgrade when protection/feature flips back on (no manual refresh).
      if (
        SiteContext.isTopFrame() &&
        policy.active &&
        policy.features.httpsUpgrade &&
        location.protocol === "http:"
      ) {
        const guardKey = "ablHttpsUpgradeTried";
        try {
          if (sessionStorage.getItem(guardKey) !== location.host) {
            sessionStorage.setItem(guardKey, location.host);
            location.replace(`https:${location.href.slice("http:".length)}`);
            return;
          }
        } catch {
          location.replace(`https:${location.href.slice("http:".length)}`);
          return;
        }
      }

      if (policy.active) {
        app.stop();
        await app.enable();
      } else {
        app.stop();
        if (policy.customHidesActive) {
          await app._cosmetics.applyCustom();
        }
      }
      InsecurePageBanner.maybeShow(policy);
    });
  });

  if (document.documentElement) app.start();
  else document.addEventListener("DOMContentLoaded", () => app.start(), { once: true });
})();
