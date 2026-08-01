(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Data / domain helpers
  // ---------------------------------------------------------------------------

  const DEFAULT_FEATURES = Object.freeze({
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
    dnsDefense: true,
    forceEnglish: true,
    linkPreview: true,
    textSelection: true,
    videoPip: true,
    readerMode: true,
    quizAssist: true,
    fbAddFriend: true,
    pageInsights: true,
    aiAssistant: false,
  });

  /** @typedef {"speed" | "light" | "advanced"} ProtectionProfile */

  /**
   * @param {unknown} raw
   * @param {Record<string, boolean>} [features]
   * @returns {ProtectionProfile}
   */
  function sanitizeProfile(raw, features) {
    const v = String(raw || "").toLowerCase();
    if (v === "speed" || v === "light" || v === "advanced") return v;
    // Migrate legacy speedMode feature toggle
    if (features && features.speedMode === false) return "advanced";
    if (features && features.speedMode === true) return "speed";
    return "light";
  }

  try {
    importScripts(
      "ua-generator.js",
      "lib/ds.js",
      "lib/phishtrap-signals.js",
      "lib/phishing.js",
      "lib/site-rules.js",
      "lib/custom-cosmetics.js",
      "lib/adaptive-learn.js",
      "lib/tracker-learn.js",
      "lib/list-updater.js",
      "lib/activity-log.js",
      "lib/user-rules.js",
      "lib/dns-defense.js",
      "lib/ai-nvidia.js",
      "lib/page-insights.js"
    );
  } catch (err) {
    console.error("GOSAFE adblock failed to load modules", err);
  }

  /** Plain JSON-safe feature map (avoids frozen/proxy objects breaking storage.set). */
  function sanitizeFeatures(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = {};
    for (const key of Object.keys(DEFAULT_FEATURES)) {
      out[key] = src[key] !== undefined ? Boolean(src[key]) : DEFAULT_FEATURES[key];
    }
    // AI assistant is internal-only — never expose / enable via UI.
    out.aiAssistant = false;
    return out;
  }

  function sanitizePausedHosts(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((h) =>
        String(h || "")
          .replace(/^www\./, "")
          .toLowerCase()
      )
      .filter(Boolean)
      .slice(0, 500);
  }

  class ExtensionStateStore {
    async getEnabled() {
      const { enabled = true } = await chrome.storage.local.get({ enabled: true });
      return Boolean(enabled);
    }

    async getStatus() {
      const data = await chrome.storage.local.get([
        "enabled",
        "blockedCount",
        "features",
        "pausedHosts",
        "theme",
        "uaSettings",
        "protectionProfile",
      ]);
      const features = sanitizeFeatures(data.features);
      return {
        enabled: data.enabled !== false,
        blockedCount: Number(data.blockedCount) || 0,
        features,
        pausedHosts: sanitizePausedHosts(data.pausedHosts),
        theme: data.theme === "dark" ? "dark" : "light",
        protectionProfile: sanitizeProfile(data.protectionProfile, data.features),
        uaSettings: globalThis.UaGenerator
          ? globalThis.UaGenerator.sanitizeSettings(data.uaSettings)
          : data.uaSettings || {},
      };
    }

    /** Seed missing keys only — never rewrite the whole bag on every install. */
    async ensureDefaults() {
      const data = await chrome.storage.local.get([
        "enabled",
        "blockedCount",
        "features",
        "pausedHosts",
        "theme",
        "featuresExpanded",
        "protectionProfile",
        "uaSettings",
      ]);
      const patch = {};
      if (typeof data.enabled !== "boolean") patch.enabled = true;
      if (typeof data.blockedCount !== "number" || Number.isNaN(data.blockedCount)) {
        patch.blockedCount = 0;
      }
      const features = sanitizeFeatures(data.features);
      patch.features = features;
      if (!Array.isArray(data.pausedHosts)) patch.pausedHosts = [];
      if (data.theme !== "light" && data.theme !== "dark") patch.theme = "light";
      if (typeof data.featuresExpanded !== "boolean") patch.featuresExpanded = true;
      if (!data.uaSettings || typeof data.uaSettings !== "object") {
        patch.uaSettings = globalThis.UaGenerator
          ? globalThis.UaGenerator.sanitizeSettings(null)
          : {};
      }
      const profile = sanitizeProfile(data.protectionProfile, data.features);
      if (data.protectionProfile !== profile) patch.protectionProfile = profile;
      await chrome.storage.local.set(patch);
    }

    async setEnabled(enabled) {
      await chrome.storage.local.set({ enabled: Boolean(enabled) });
    }

    async setFeature(key, value) {
      if (!(key in DEFAULT_FEATURES)) return;
      const status = await this.getStatus();
      const features = sanitizeFeatures({ ...status.features, [key]: Boolean(value) });
      await chrome.storage.local.set({ features });
    }

    async setSitePaused(host, paused) {
      const clean = String(host || "")
        .replace(/^www\./, "")
        .toLowerCase();
      if (!clean) return;
      const status = await this.getStatus();
      const set = new Set(status.pausedHosts);
      if (paused) set.add(clean);
      else set.delete(clean);
      await chrome.storage.local.set({ pausedHosts: sanitizePausedHosts([...set]) });
    }

    async setTheme(theme) {
      await chrome.storage.local.set({ theme: theme === "dark" ? "dark" : "light" });
    }

    /**
     * @param {ProtectionProfile} profile
     */
    async setProtectionProfile(profile) {
      const next = sanitizeProfile(profile);
      await chrome.storage.local.set({ protectionProfile: next });
      return next;
    }

    async resetCount() {
      await chrome.storage.local.set({ blockedCount: 0 });
    }

    async bumpBlocked() {
      const { blockedCount = 0, enabled = true } = await chrome.storage.local.get({
        blockedCount: 0,
        enabled: true,
      });
      if (!enabled) return;
      await chrome.storage.local.set({ blockedCount: (Number(blockedCount) || 0) + 1 });
    }
  }

  class RulesetController {
    constructor() {
      this._ids = (chrome.runtime.getManifest().declarative_net_request?.rule_resources || []).map(
        (resource) => resource.id
      );
      this._httpsId = "https_upgrade";
    }

    /**
     * @param {boolean} enabled
     * @param {Record<string, boolean>} [features]
     */
    async apply(enabled, features = {}) {
      if (!this._ids.length) {
        await this.#setBadge(enabled);
        return;
      }

      if (!enabled) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          disableRulesetIds: this._ids,
        });
      } else {
        const enable = this._ids.filter(
          (id) => id !== this._httpsId || features.httpsUpgrade !== false
        );
        const disable = this._ids.filter((id) => !enable.includes(id));
        const payload = {};
        if (enable.length) payload.enableRulesetIds = enable;
        if (disable.length) payload.disableRulesetIds = disable;
        if (payload.enableRulesetIds || payload.disableRulesetIds) {
          await chrome.declarativeNetRequest.updateEnabledRulesets(payload);
        }
      }
      await this.#setBadge(enabled);
    }

    async #setBadge(enabled) {
      await chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
      await chrome.action.setBadgeBackgroundColor({ color: "#111111" });
      await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
    }
  }

  /**
   * Sites that break under UA spoof / Force-English Accept-Language.
   * Used as DNR excludedRequestDomains + excludedInitiatorDomains.
   */
  class SiteCompat {
    static FRAGILE_DOMAINS = Object.freeze([
      "taobao.com",
      "tmall.com",
      "tmall.hk",
      "alibaba.com",
      "alicdn.com",
      "aliexpress.com",
      "alipay.com",
      "alipayobjects.com",
      "1688.com",
      "mmstat.com",
      "taobaocdn.com",
      "tbcdn.cn",
      "jd.com",
      "jd.hk",
      "360buyimg.com",
      "qq.com",
      "wechat.com",
      "weixin.qq.com",
      "baidu.com",
      "bilibili.com",
      "hdslb.com",
      // Gmail / Workspace — header/UA spoof breaks sync (#2014)
      "mail.google.com",
      "accounts.google.com",
      "docs.google.com",
      "drive.google.com",
      "calendar.google.com",
      "meet.google.com",
      "chat.google.com",
      "gmail.com",
      // Meta / NVIDIA — header spoof breaks product SPAs
      "facebook.com",
      "fb.com",
      "messenger.com",
      "instagram.com",
      "meta.com",
      "threads.net",
      "whatsapp.com",
      "nvidia.com",
      "nvidiagrid.net",
      "build.nvidia.com",
      "integrate.api.nvidia.com",
      "api.nvcf.nvidia.com",
      "ngc.nvidia.com",
      "org.ngc.nvidia.com",
      "auth0.com",
    ]);

    /**
     * Live-score / illicit-stream SPA CDNs — blocklists often catch these as trackers.
     * Keep allowlisted so match lists & players can load; ads still blocked elsewhere.
     */
    static STREAM_COMPAT_DOMAINS = Object.freeze([
      "rbtvplus18.top",
      "tcxru135mdqf.ru",
      "statics1.tcxru135mdqf.ru",
      "apis-data10.tcxru135mdqf.ru",
      "apis-data-defra10.tcxru135mdqf.ru",
      "logos1.tcxru135mdqf.ru",
      "ta2mnt200stayr2.cfd",
      "apis-live.ta2mnt200stayr2.cfd",
      "apis-live-defra.ta2mnt200stayr2.cfd",
      "cutty13dm.cfd",
      "app98.cutty13dm.cfd",
    ]);

    /** School LMS hosts — UA spoof / FP can break Moodle & campus portals. */
    static EDU_COMPAT_DOMAINS = Object.freeze([
      "edu.kh",
      "ccun.edu.kh",
      "moodle.ccun.edu.kh",
      "instructure.com",
      "canvaslms.com",
      "blackboard.com",
      "brightspace.com",
      "schoology.com",
    ]);

    /** @returns {string[]} */
    static uaExcludeDomains() {
      return [
        ...SiteCompat.FRAGILE_DOMAINS,
        ...SiteCompat.STREAM_COMPAT_DOMAINS,
        ...SiteCompat.EDU_COMPAT_DOMAINS,
      ];
    }
  }

  /** Random User-Agent via DNR modifyHeaders + stored pool settings. */
  class UserAgentController {
    static RULE_ID = 9001;
    static ALARM = "abl-ua-renew";

    static #resourceTypes = [
      "main_frame",
      "sub_frame",
      "xmlhttprequest",
      "script",
      "stylesheet",
      "image",
      "font",
      "media",
      "websocket",
      "ping",
      "other",
    ];

    /**
     * @param {ExtensionStateStore} store
     */
    constructor(store) {
      this._store = store;
    }

    async getSettings() {
      const { uaSettings } = await chrome.storage.local.get({ uaSettings: null });
      return globalThis.UaGenerator.sanitizeSettings(uaSettings);
    }

    async saveSettings(partial) {
      const current = await this.getSettings();
      const next = globalThis.UaGenerator.sanitizeSettings({ ...current, ...partial });
      await chrome.storage.local.set({ uaSettings: next });
      return next;
    }

    async #setHeaderRule(ua) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [UserAgentController.RULE_ID],
        addRules: ua
          ? [
              {
                id: UserAgentController.RULE_ID,
                priority: 100,
                action: {
                  type: "modifyHeaders",
                  requestHeaders: [
                    { header: "user-agent", operation: "set", value: ua },
                    // Reduce Client-Hints leakage that can contradict the spoofed UA.
                    { header: "sec-ch-ua", operation: "remove" },
                    { header: "sec-ch-ua-mobile", operation: "remove" },
                    { header: "sec-ch-ua-platform", operation: "remove" },
                    { header: "sec-ch-ua-full-version", operation: "remove" },
                    { header: "sec-ch-ua-full-version-list", operation: "remove" },
                    { header: "sec-ch-ua-platform-version", operation: "remove" },
                    { header: "sec-ch-ua-arch", operation: "remove" },
                    { header: "sec-ch-ua-bitness", operation: "remove" },
                    { header: "sec-ch-ua-model", operation: "remove" },
                  ],
                },
                condition: {
                  urlFilter: "*",
                  resourceTypes: UserAgentController.#resourceTypes,
                  excludedRequestDomains: [...SiteCompat.uaExcludeDomains()],
                  excludedInitiatorDomains: [...SiteCompat.uaExcludeDomains()],
                },
              },
            ]
          : [],
      });
    }

    async #schedule(settings) {
      await chrome.alarms.clear(UserAgentController.ALARM);
      const mins = Number(settings.autoRenewMinutes) || 0;
      if (mins > 0) {
        await chrome.alarms.create(UserAgentController.ALARM, {
          periodInMinutes: Math.max(1, mins),
        });
      }
    }

    /**
     * @param {{ force?: boolean, renew?: boolean }} [opts]
     */
    async apply(opts = {}) {
      if (!globalThis.UaGenerator) return { ok: false, error: "generator_missing" };
      const status = await this._store.getStatus();
      const settings = await this.getSettings();
      const featureOn = status.enabled && status.features.randomUa === true;

      if (!featureOn) {
        await this.#setHeaderRule("");
        await chrome.alarms.clear(UserAgentController.ALARM);
        return { ok: true, enabled: false, uaSettings: settings };
      }

      let next = settings;
      const needNew =
        opts.renew ||
        !settings.current ||
        (opts.force && !settings.current);

      if (needNew || opts.renew) {
        const ua = globalThis.UaGenerator.generate(settings);
        next = await this.saveSettings({
          current: ua,
          updatedAt: Date.now(),
        });
      }

      await this.#setHeaderRule(next.current);
      await this.#schedule(next);
      return { ok: true, enabled: true, uaSettings: next };
    }

    async renew() {
      return this.apply({ renew: true });
    }
  }

  /** WebRTC IP leak control via chrome.privacy — yields if another extension owns the setting. */
  class WebRtcPrivacyController {
    constructor() {
      this._last = {
        ok: true,
        applied: false,
        conflict: false,
        levelOfControl: "",
        error: "",
      };
    }

    get status() {
      return { ...this._last };
    }

    /**
     * @param {boolean} enabled
     * @param {boolean} featureOn
     */
    async apply(enabled, featureOn) {
      const api = chrome.privacy?.network?.webRTCIPHandlingPolicy;
      if (!api) {
        this._last = {
          ok: false,
          applied: false,
          conflict: false,
          levelOfControl: "unavailable",
          error: "api_missing",
        };
        return this._last;
      }
      try {
        const current = await api.get({});
        const level = String(current?.levelOfControl || "");
        const wantOn = Boolean(enabled && featureOn !== false);

        if (level === "controlled_by_other_extensions") {
          this._last = {
            ok: true,
            applied: false,
            conflict: true,
            levelOfControl: level,
            error: "other_extension",
          };
          return this._last;
        }
        if (level === "not_controllable") {
          this._last = {
            ok: false,
            applied: false,
            conflict: false,
            levelOfControl: level,
            error: "not_controllable",
          };
          return this._last;
        }

        const value = wantOn ? "disable_non_proxied_udp" : "default";
        await api.set({ value });
        this._last = {
          ok: true,
          applied: wantOn,
          conflict: false,
          levelOfControl: level,
          error: "",
        };
        return this._last;
      } catch (err) {
        const msg = String(err?.message || err);
        const conflict = /another|other|conflict|controll/i.test(msg);
        console.warn("GOSAFE adblock WebRTC policy failed:", err);
        this._last = {
          ok: false,
          applied: false,
          conflict,
          levelOfControl: "",
          error: msg.slice(0, 160),
        };
        return this._last;
      }
    }
  }

  /** Temporary first-party allow (10 / 60 min) without permanent whitelist. */
  class TempAllowController {
    static RULE_ID = 9102;
    static ALARM = "abl-temp-allow";

    async #readClean() {
      const { tempAllows = {} } = await chrome.storage.local.get({ tempAllows: {} });
      const now = Date.now();
      const cleaned = {};
      let dirty = false;
      for (const [host, exp] of Object.entries(tempAllows || {})) {
        const key = globalThis.AblDs?.HostKey?.normalize
          ? globalThis.AblDs.HostKey.normalize(host)
          : String(host || "")
              .replace(/^www\./, "")
              .toLowerCase();
        const until = Number(exp) || 0;
        if (!key || until <= now) {
          dirty = true;
          continue;
        }
        cleaned[key] = until;
      }
      if (dirty || Object.keys(cleaned).length !== Object.keys(tempAllows || {}).length) {
        await chrome.storage.local.set({ tempAllows: cleaned });
      }
      return cleaned;
    }

    async expiresAt(host) {
      const map = await this.#readClean();
      const key = globalThis.AblDs?.HostKey?.normalize
        ? globalThis.AblDs.HostKey.normalize(host)
        : String(host || "")
            .replace(/^www\./, "")
            .toLowerCase();
      return Number(map[key]) || 0;
    }

    async isActive(host) {
      return (await this.expiresAt(host)) > Date.now();
    }

    /**
     * @param {string} host
     * @param {number} minutes 0 clears
     */
    async set(host, minutes) {
      const key = globalThis.AblDs?.HostKey?.normalize
        ? globalThis.AblDs.HostKey.normalize(host)
        : String(host || "")
            .replace(/^www\./, "")
            .toLowerCase();
      if (!key) return { ok: false };
      const map = await this.#readClean();
      if (minutes <= 0) delete map[key];
      else map[key] = Date.now() + Math.max(1, minutes) * 60_000;
      await chrome.storage.local.set({ tempAllows: map });
      await this.apply();
      await this.#schedule();
      return { ok: true, expiresAt: map[key] || 0 };
    }

    async apply() {
      const map = await this.#readClean();
      const hosts = Object.keys(map).slice(0, 100);
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [TempAllowController.RULE_ID],
        addRules: hosts.length
          ? [
              {
                id: TempAllowController.RULE_ID,
                priority: 10000,
                action: { type: "allow" },
                condition: {
                  requestDomains: hosts,
                  resourceTypes: ["main_frame", "sub_frame"],
                },
              },
            ]
          : [],
      });
    }

    async #schedule() {
      await chrome.alarms.clear(TempAllowController.ALARM);
      const map = await this.#readClean();
      if (!Object.keys(map).length) return;
      await chrome.alarms.create(TempAllowController.ALARM, { periodInMinutes: 1 });
    }

    async sweep() {
      await this.apply();
      await this.#schedule();
    }
  }

  /** Dedicated crypto-miner script/domain block (toggleable). */
  class MinerBlockController {
    static RULE_ID = 9300;

    static #DOMAINS = Object.freeze([
      "coinhive.com",
      "coin-hive.com",
      "jsecoin.com",
      "crypto-loot.com",
      "cryptoloot.pro",
      "webmine.pro",
      "webminepool.com",
      "minero.cc",
      "authedmine.com",
      "ppoi.org",
      "2giga.link",
      "coinlab.biz",
      "webassembly.stream",
      "cryptonight.wasm",
      "monero-miner.com",
      "minexmr.com",
      "supportxmr.com",
    ]);

    /**
     * @param {boolean} enabled
     * @param {boolean} featureOn
     */
    async apply(enabled, featureOn) {
      const on = Boolean(enabled && featureOn !== false);
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [MinerBlockController.RULE_ID],
        addRules: on
          ? [
              {
                id: MinerBlockController.RULE_ID,
                priority: 80,
                action: { type: "block" },
                condition: {
                  requestDomains: [...MinerBlockController.#DOMAINS],
                  resourceTypes: [
                    "script",
                    "xmlhttprequest",
                    "websocket",
                    "other",
                    "sub_frame",
                  ],
                },
              },
            ]
          : [],
      });
    }
  }

  /** Harder third-party cookies + strip third-party Referer. */
  class StrictTrackingController {
    static RULE_ID = 9401;

    static #TYPES = Object.freeze([
      "main_frame",
      "sub_frame",
      "xmlhttprequest",
      "script",
      "image",
      "stylesheet",
      "font",
      "media",
      "websocket",
      "ping",
      "other",
    ]);

    /**
     * @param {boolean} enabled
     * @param {boolean} featureOn
     */
    async apply(enabled, featureOn) {
      const on = Boolean(enabled && featureOn);
      try {
        const cookies = chrome.privacy?.websites?.thirdPartyCookiesAllowed;
        if (cookies) await cookies.set({ value: !on });
      } catch (err) {
        console.warn("GOSAFE adblock third-party cookies policy failed:", err);
      }
      try {
        const audit = chrome.privacy?.websites?.hyperlinkAuditingEnabled;
        if (audit) await audit.set({ value: !on });
      } catch {
        // ignore
      }
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [StrictTrackingController.RULE_ID],
        addRules: on
          ? [
              {
                id: StrictTrackingController.RULE_ID,
                priority: 40,
                action: {
                  type: "modifyHeaders",
                  requestHeaders: [{ header: "referer", operation: "remove" }],
                },
                condition: {
                  domainType: "thirdParty",
                  resourceTypes: [...StrictTrackingController.#TYPES],
                  excludedInitiatorDomains: [...SiteCompat.FRAGILE_DOMAINS],
                },
              },
            ]
          : [],
      });
    }
  }

  /**
   * Link hover preview — fetch content-type + Open Graph metadata in SW.
   */
  class LinkPreviewService {
    static #MAX_HTML = 250_000;
    static #TIMEOUT_MS = 7000;

    /**
     * @param {string} url
     * @param {string} [kind]
     */
    static async inspect(url, kind = "page") {
      let parsed;
      try {
        parsed = new URL(String(url || ""));
      } catch {
        return { ok: false, error: "bad_url" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "bad_protocol" };
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), LinkPreviewService.#TIMEOUT_MS);
      try {
        let res = await fetch(parsed.href, {
          method: "GET",
          redirect: "follow",
          credentials: "omit",
          signal: ctrl.signal,
          headers: { Accept: "*/*", "User-Agent": "GOSAFE-LinkPreview/1.0" },
        });
        const finalUrl = res.url || parsed.href;
        const contentType = String(res.headers.get("content-type") || "").toLowerCase();
        const ct = contentType.split(";")[0].trim();

        if (kind === "image" || ct.startsWith("image/")) {
          return {
            ok: true,
            url: finalUrl,
            kind: "image",
            title: parsed.pathname.split("/").pop() || parsed.hostname,
            description: ct || "Image",
            image: finalUrl,
            contentType: ct,
            frameOk: false,
          };
        }
        if (kind === "pdf" || ct.includes("pdf")) {
          return {
            ok: true,
            url: finalUrl,
            kind: "pdf",
            title: parsed.pathname.split("/").pop() || "PDF document",
            description: "PDF document",
            image: "",
            contentType: ct || "application/pdf",
            frameOk: true,
          };
        }
        if (
          kind === "doc" ||
          /officedocument|msword|ms-excel|ms-powerpoint|text\/plain|text\/csv/.test(ct)
        ) {
          return {
            ok: true,
            url: finalUrl,
            kind: "doc",
            title: parsed.pathname.split("/").pop() || "Document",
            description: ct || "Office / text document",
            image: "",
            contentType: ct,
            frameOk: true,
          };
        }
        if (kind === "media" || ct.startsWith("video/") || ct.startsWith("audio/")) {
          return {
            ok: true,
            url: finalUrl,
            kind: "media",
            title: parsed.pathname.split("/").pop() || "Media",
            description: ct || "Media file",
            image: "",
            contentType: ct,
            frameOk: false,
          };
        }

        // HTML page — scrape lightweight OG / twitter / title
        const buf = await res.arrayBuffer();
        const slice = buf.byteLength > LinkPreviewService.#MAX_HTML
          ? buf.slice(0, LinkPreviewService.#MAX_HTML)
          : buf;
        const html = new TextDecoder("utf-8", { fatal: false }).decode(slice);
        const meta = LinkPreviewService.#parseHtml(html, finalUrl);
        const xfo = String(res.headers.get("x-frame-options") || "").toLowerCase();
        const csp = String(res.headers.get("content-security-policy") || "").toLowerCase();
        const frameOk =
          !xfo.includes("deny") &&
          !xfo.includes("sameorigin") &&
          !/frame-ancestors\s+('none'|none)/i.test(csp);

        return {
          ok: true,
          url: finalUrl,
          kind: "page",
          title: meta.title || parsed.hostname,
          description: meta.description || "",
          image: meta.image || "",
          contentType: ct || "text/html",
          // Prefer live frame when the site allows embedding; OG image is a fallback thumb.
          frameOk: Boolean(frameOk),
        };
      } catch (err) {
        return { ok: false, error: String(err?.message || err || "fetch_failed") };
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * @param {string} html
     * @param {string} baseUrl
     */
    static #parseHtml(html, baseUrl) {
      const pick = (re) => {
        const m = html.match(re);
        return m ? LinkPreviewService.#decode(m[1] || m[2] || "").trim() : "";
      };
      let title =
        pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
        pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
        pick(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
        pick(/<title[^>]*>([^<]{1,200})<\/title>/i);
      let description =
        pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
        pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
        pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
        pick(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
      let image =
        pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
        pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
        pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);

      if (image) {
        try {
          image = new URL(image, baseUrl).href;
        } catch {
          image = "";
        }
      }
      return { title, description, image };
    }

    static #decode(s) {
      return String(s || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    }
  }

  /** Prefer English: Accept-Language header while protection is on. */
  class ForceEnglishController {
    static RULE_ID = 9003;

    static #TYPES = Object.freeze([
      "main_frame",
      "sub_frame",
      "xmlhttprequest",
      "script",
      "stylesheet",
      "image",
      "font",
      "media",
      "websocket",
      "ping",
      "other",
    ]);

    /**
     * @param {boolean} enabled
     * @param {boolean} featureOn
     */
    async apply(enabled, featureOn) {
      const on = Boolean(enabled && featureOn);
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ForceEnglishController.RULE_ID],
        addRules: on
          ? [
              {
                id: ForceEnglishController.RULE_ID,
                priority: 50,
                action: {
                  type: "modifyHeaders",
                  requestHeaders: [
                    {
                      header: "accept-language",
                      operation: "set",
                      value: "en-US,en;q=0.9",
                    },
                  ],
                },
                condition: {
                  urlFilter: "*",
                  resourceTypes: [...ForceEnglishController.#TYPES],
                  excludedRequestDomains: [...SiteCompat.uaExcludeDomains()],
                  excludedInitiatorDomains: [...SiteCompat.uaExcludeDomains()],
                },
              },
            ]
          : [],
      });
    }
  }

  /**
   * Service-worker GTX translator (content scripts cannot fetch this under many CSPs).
   */
  class ForceEnglishTranslator {
    static #ENDPOINT = "https://translate.googleapis.com/translate_a/single";
    /** @type {Map<string, string>} */
    static #cache = new Map();
    static #CAP = 1200;
    static #chain = Promise.resolve();

    /**
     * @param {string} text
     * @param {string} [sl]
     * @param {string} [tl]
     */
    static async #fetchOne(text, sl = "auto", tl = "en") {
      const raw = String(text || "");
      if (!raw.trim()) return { text: raw, detected: sl };
      const from = String(sl || "auto").trim() || "auto";
      const to = String(tl || "en").trim() || "en";
      const cacheKey = `${from}|${to}|${raw}`;
      if (ForceEnglishTranslator.#cache.has(cacheKey)) {
        const hit = ForceEnglishTranslator.#cache.get(cacheKey);
        if (hit) {
          if (!Array.isArray(hit.segments) || !hit.segments.length) {
            hit.segments = [{ src: raw, dst: hit.text || raw }];
          }
          return hit;
        }
      }
      // POST — long selections blow past GET URL limits and silently fail.
      const body = new URLSearchParams({
        client: "gtx",
        sl: from,
        tl: to,
        dt: "t",
        q: raw.slice(0, 4500),
      });
      const res = await fetch(ForceEnglishTranslator.#ENDPOINT, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: body.toString(),
      });
      if (!res.ok) return { text: raw, detected: from, error: `http ${res.status}`, segments: [] };
      const json = await res.json();
      if (!Array.isArray(json?.[0])) {
        return { text: raw, detected: from, error: "bad response", segments: [] };
      }
      /** @type {{ src: string, dst: string }[]} */
      const segments = [];
      const joinedParts = [];
      for (const row of json[0]) {
        if (!Array.isArray(row)) continue;
        const dst = String(row[0] || "");
        const src = String(row[1] || "");
        if (!dst && !src) continue;
        joinedParts.push(dst);
        segments.push({ src, dst });
      }
      const joined = joinedParts.join("");
      const detected = String(json?.[2] || from || "auto");
      if (!joined) return { text: raw, detected, error: "empty", segments: [] };
      // If API omitted src chunks, treat whole input as one segment.
      if (segments.length && segments.every((s) => !s.src)) {
        segments[0] = { src: raw, dst: joined };
        for (let i = 1; i < segments.length; i += 1) segments[i].src = "";
      }
      const out = { text: joined, detected, segments };
      ForceEnglishTranslator.#cache.set(cacheKey, out);
      while (ForceEnglishTranslator.#cache.size > ForceEnglishTranslator.#CAP) {
        ForceEnglishTranslator.#cache.delete(ForceEnglishTranslator.#cache.keys().next().value);
      }
      return out;
    }

    /**
     * Serialize requests lightly to avoid hammering the endpoint.
     * @param {string[]} texts
     * @param {string} [sl]
     * @param {string} [tl]
     * @returns {Promise<{ texts: string[], detected: string, segments: { src: string, dst: string }[][] }>}
     */
    static async translateMany(texts, sl = "auto", tl = "en") {
      const list = Array.isArray(texts) ? texts.map((t) => String(t ?? "")) : [];
      const out = new Array(list.length);
      /** @type {{ src: string, dst: string }[][]} */
      const segmentsOut = new Array(list.length);
      let detected = String(sl || "auto");
      const wave = 6;
      for (let i = 0; i < list.length; i += wave) {
        const slice = list.slice(i, i + wave);
        // eslint-disable-next-line no-await-in-loop
        const part = await Promise.all(
          slice.map((t) =>
            ForceEnglishTranslator.#chain
              .then(() => ForceEnglishTranslator.#fetchOne(t, sl, tl))
              .catch(() => ({ text: t, detected: sl, segments: [] }))
          )
        );
        for (let j = 0; j < part.length; j += 1) {
          out[i + j] = part[j].text;
          segmentsOut[i + j] = Array.isArray(part[j].segments) ? part[j].segments : [];
          if (part[j].detected && part[j].detected !== "auto") detected = part[j].detected;
        }
      }
      return { texts: out, detected, segments: segmentsOut };
    }
  }

  /**
   * Page Insights: site permission manager (contentSettings) + session third-party blocks.
   * Session DNR rule ids: 9700–9799.
   */
  class PageInsightsController {
    static RULE_BASE = 9700;
    static RULE_MAX = 100;
    static PERM_TYPES = Object.freeze([
      { type: "notifications", label: "Notifications" },
      { type: "camera", label: "Camera" },
      { type: "microphone", label: "Microphone" },
    ]);

    static #resourceTypes = Object.freeze([
      "script",
      "xmlhttprequest",
      "image",
      "sub_frame",
      "media",
      "font",
      "stylesheet",
      "websocket",
      "ping",
      "other",
    ]);

    /**
     * @param {string} origin
     */
    static #pattern(origin) {
      try {
        const u = new URL(origin);
        return `${u.origin}/*`;
      } catch {
        return "";
      }
    }

    /**
     * @param {string} origin
     */
    async getPermissions(origin) {
      const pattern = PageInsightsController.#pattern(origin);
      if (!pattern) return { ok: false, error: "bad_origin" };
      const cs = chrome.contentSettings;
      if (!cs) return { ok: false, error: "contentSettings_unavailable" };

      const permissions = [];
      for (const meta of PageInsightsController.PERM_TYPES) {
        const api = cs[meta.type];
        if (!api?.get) {
          permissions.push({ ...meta, setting: "unknown", controllable: false });
          continue;
        }
        try {
          const details = await new Promise((resolve, reject) => {
            try {
              api.get({ primaryUrl: origin }, (d) => {
                const err = chrome.runtime.lastError;
                if (err) reject(new Error(err.message));
                else resolve(d);
              });
            } catch (e) {
              reject(e);
            }
          });
          permissions.push({
            ...meta,
            setting: String(details?.setting || "ask"),
            controllable: true,
          });
        } catch (err) {
          permissions.push({
            ...meta,
            setting: "error",
            controllable: false,
            error: String(err?.message || err),
          });
        }
      }
      return { ok: true, origin, permissions };
    }

    /**
     * @param {string} origin
     * @param {string} permission
     * @param {string} setting
     */
    async setPermission(origin, permission, setting) {
      const pattern = PageInsightsController.#pattern(origin);
      if (!pattern) return { ok: false, error: "bad_origin" };
      const allowedType = PageInsightsController.PERM_TYPES.some((p) => p.type === permission);
      if (!allowedType) return { ok: false, error: "unsupported_permission" };
      const setTo = setting === "allow" || setting === "block" || setting === "ask" ? setting : "";
      if (!setTo) return { ok: false, error: "bad_setting" };
      const api = chrome.contentSettings?.[permission];
      if (!api?.set) return { ok: false, error: "contentSettings_unavailable" };
      try {
        await new Promise((resolve, reject) => {
          try {
            api.set({ primaryPattern: pattern, setting: setTo }, () => {
              const err = chrome.runtime.lastError;
              if (err) reject(new Error(err.message));
              else resolve();
            });
          } catch (e) {
            reject(e);
          }
        });
        return { ok: true, permission, setting: setTo };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    }

    /**
     * Session-scoped block of third-party hosts (opt-in from Page Insights panel).
     * @param {string[]} hosts
     * @param {string} [pageHost]
     */
    async blockThirdPartiesSession(hosts, pageHost = "") {
      const page = String(pageHost || "")
        .replace(/^www\./i, "")
        .toLowerCase();
      const cleaned = [
        ...new Set(
          (Array.isArray(hosts) ? hosts : [])
            .map((h) =>
              String(h || "")
                .replace(/^www\./i, "")
                .toLowerCase()
                .replace(/[^a-z0-9.-]/g, "")
            )
            .filter(
              (h) =>
                h &&
                h.includes(".") &&
                h !== page &&
                !page.endsWith(`.${h}`) &&
                !h.endsWith(`.${page}`)
            )
        ),
      ].slice(0, PageInsightsController.RULE_MAX);

      const removeRuleIds = [];
      for (let i = 0; i < PageInsightsController.RULE_MAX; i += 1) {
        removeRuleIds.push(PageInsightsController.RULE_BASE + i);
      }

      const addRules = cleaned.map((host, i) => ({
        id: PageInsightsController.RULE_BASE + i,
        priority: 55,
        action: { type: "block" },
        condition: {
          requestDomains: [host],
          resourceTypes: [...PageInsightsController.#resourceTypes],
        },
      }));

      try {
        if (chrome.declarativeNetRequest.updateSessionRules) {
          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds,
            addRules,
          });
        } else {
          await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds,
            addRules,
          });
        }
        return { ok: true, count: cleaned.length, hosts: cleaned };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    }
  }

  /** Privacy Badger–style GPC + Do Not Track request headers. */
  class PrivacySignalsController {
    static RULE_ID = 9402;

    static #TYPES = Object.freeze([
      "main_frame",
      "sub_frame",
      "xmlhttprequest",
      "script",
      "image",
      "stylesheet",
      "font",
      "media",
      "websocket",
      "ping",
      "other",
    ]);

    /**
     * @param {boolean} enabled
     * @param {boolean} featureOn
     */
    async apply(enabled, featureOn) {
      const on = Boolean(enabled && featureOn);
      try {
        const dnt = chrome.privacy?.websites?.doNotTrackEnabled;
        if (dnt) await dnt.set({ value: on });
      } catch {
        // ignore
      }
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [PrivacySignalsController.RULE_ID],
        addRules: on
          ? [
              {
                id: PrivacySignalsController.RULE_ID,
                priority: 45,
                action: {
                  type: "modifyHeaders",
                  requestHeaders: [
                    { header: "Sec-GPC", operation: "set", value: "1" },
                    { header: "DNT", operation: "set", value: "1" },
                  ],
                },
                condition: {
                  urlFilter: "*",
                  resourceTypes: [...PrivacySignalsController.#TYPES],
                },
              },
            ]
          : [],
      });
    }
  }

  /** Per-site feature overrides (e.g. cosmetics off on one host). */
  class SiteFeatureOverrideStore {
    async getMap() {
      const { siteFeatureOverrides = {} } = await chrome.storage.local.get({
        siteFeatureOverrides: {},
      });
      return siteFeatureOverrides && typeof siteFeatureOverrides === "object"
        ? siteFeatureOverrides
        : {};
    }

    async featuresFor(host) {
      const key = globalThis.AblDs?.HostKey?.normalize
        ? globalThis.AblDs.HostKey.normalize(host)
        : String(host || "")
            .replace(/^www\./, "")
            .toLowerCase();
      const map = await this.getMap();
      if (!key) return {};
      const parts = key.split(".").filter(Boolean);
      for (let i = 0; i < parts.length - 1; i += 1) {
        const suffix = parts.slice(i).join(".");
        if (map[suffix] && typeof map[suffix] === "object") return { ...map[suffix] };
      }
      return map[key] && typeof map[key] === "object" ? { ...map[key] } : {};
    }

    /**
     * @param {string} host
     * @param {string} key
     * @param {boolean | null | undefined} value null clears
     */
    async set(host, key, value) {
      if (!(key in DEFAULT_FEATURES)) return { ok: false };
      const clean = globalThis.AblDs?.HostKey?.normalize
        ? globalThis.AblDs.HostKey.normalize(host)
        : String(host || "")
            .replace(/^www\./, "")
            .toLowerCase();
      if (!clean) return { ok: false };
      const map = await this.getMap();
      const current = { ...(map[clean] || {}) };
      if (value === null || value === undefined) delete current[key];
      else current[key] = Boolean(value);
      if (Object.keys(current).length) map[clean] = current;
      else delete map[clean];
      await chrome.storage.local.set({ siteFeatureOverrides: map });
      return { ok: true, features: current };
    }
  }

  /**
   * Zero-click privacy preset — one tap enables hard privacy + session cookie wipe.
   */
  class PrivacyModeController {
    static PRESET = Object.freeze({
      httpsUpgrade: true,
      webrtcGuard: true,
      permissionGuard: true,
      clipboardGuard: true,
      fingerprintGuard: true,
      strictTracking: true,
      minerBlock: true,
      phishingGuard: true,
      malwareWarn: true,
      popupBlocker: true,
      downloadGuard: true,
      privacyMode: true,
      trackerLearn: true,
      privacySignals: true,
    });

    /**
     * @param {ExtensionStateStore} store
     */
    constructor(store) {
      this._store = store;
    }

    async isOn() {
      const status = await this._store.getStatus();
      return Boolean(status.features.privacyMode);
    }

    /**
     * @param {boolean} on
     * @param {{ clearCookies?: boolean }} [opts]
     */
    async set(on, opts = {}) {
      const status = await this._store.getStatus();
      const features = { ...status.features };
      if (on) {
        Object.assign(features, PrivacyModeController.PRESET);
        await chrome.storage.local.set({
          features: sanitizeFeatures(features),
          protectionProfile: "advanced",
          privacyModeMeta: { enabledAt: Date.now(), clearCookies: opts.clearCookies !== false },
        });
        if (opts.clearCookies !== false) await this.clearSessionCookies();
      } else {
        features.privacyMode = false;
        // Leave other toggles as-is (user may want to keep strict tracking).
        await chrome.storage.local.set({
          features: sanitizeFeatures(features),
          privacyModeMeta: { enabledAt: 0, clearCookies: false },
        });
      }
      return { ok: true, on: Boolean(on) };
    }

    async clearSessionCookies() {
      if (!chrome.browsingData?.remove) return { ok: false };
      try {
        await chrome.browsingData.remove(
          {},
          {
            cookies: true,
            cacheStorage: false,
            localStorage: false,
            indexedDB: false,
          }
        );
        return { ok: true };
      } catch (err) {
        console.warn("GOSAFE adblock cookie clear failed:", err);
        return { ok: false };
      }
    }

    /** On browser start, wipe leftover cookies if privacy mode stayed on. */
    async maybeClearOnStartup() {
      const status = await this._store.getStatus();
      if (!status.features.privacyMode) return;
      const { privacyModeMeta } = await chrome.storage.local.get({ privacyModeMeta: null });
      if (privacyModeMeta?.clearCookies === false) return;
      await this.clearSessionCookies();
    }
  }

  /**
   * Per-host privacy firewall session counters + recent security alerts.
   */
  class SecurityFirewallStore {
    static KEY = "securityFirewall";

    async #read() {
      try {
        if (chrome.storage.session?.get) {
          const data = await chrome.storage.session.get({ securityFirewall: {} });
          if (data.securityFirewall && typeof data.securityFirewall === "object") {
            return data.securityFirewall;
          }
        }
      } catch {
        // fall through to local
      }
      const local = await chrome.storage.local.get({ securityFirewall: {} });
      return local.securityFirewall && typeof local.securityFirewall === "object"
        ? local.securityFirewall
        : {};
    }

    async #write(map) {
      try {
        if (chrome.storage.session?.set) {
          await chrome.storage.session.set({ securityFirewall: map });
          return;
        }
      } catch {
        // fall through
      }
      await chrome.storage.local.set({ securityFirewall: map });
    }

    #bucket(map, host) {
      const key = String(host || "")
        .replace(/^www\./, "")
        .toLowerCase() || "unknown";
      if (!map[key]) {
        map[key] = {
          trackers: 0,
          fingerprint: 0,
          suspicious: 0,
          attacks: 0,
          alerts: [],
        };
      }
      return { key, bucket: map[key] };
    }

    async bump(host, field, n = 1) {
      const map = await this.#read();
      const { bucket } = this.#bucket(map, host);
      bucket[field] = (Number(bucket[field]) || 0) + n;
      await this.#write(map);
    }

    async alert(host, entry) {
      const map = await this.#read();
      const { bucket } = this.#bucket(map, host);
      bucket.attacks = (Number(bucket.attacks) || 0) + 1;
      const alerts = Array.isArray(bucket.alerts) ? bucket.alerts : [];
      alerts.unshift({
        kind: entry.kind || "attack",
        title: String(entry.title || "Alert").slice(0, 160),
        detail: String(entry.detail || "").slice(0, 220),
        ts: Date.now(),
        level: "bad",
      });
      bucket.alerts = alerts.slice(0, 40);
      await this.#write(map);
      return bucket;
    }

    async forHost(host) {
      const map = await this.#read();
      const { bucket } = this.#bucket(map, host);
      return {
        stats: {
          trackers: Number(bucket.trackers) || 0,
          fingerprint: Number(bucket.fingerprint) || 0,
          suspicious: Number(bucket.suspicious) || 0,
          attacks: Number(bucket.attacks) || 0,
        },
        alerts: Array.isArray(bucket.alerts) ? bucket.alerts : [],
      };
    }
  }

  /** Classifies dangerous downloads with regex sets (set membership + pattern match). */
  class DownloadGuard {
    static #DANGEROUS_EXT =
      /\.(apk|exe|msi|dmg|scr|bat|cmd|pif|hta|vbs|vbe|wsf|wsh|jse|iso|img|cab|msix|appx)(?:$|[?#])/i;

    static #BAIT_NAME =
      /(setup|installer|update|upgrade|player|codec|fix|crack|keygen|activator|download[_-]?now|free[_-]?vpn|movie[_-]?player)/i;

    static #ARCHIVE_EXT = /\.(zip|rar|7z|gz)(?:$|[?#])/i;

    /** @param {string} url */
    static pathOf(url) {
      try {
        const u = new URL(url);
        return `${u.pathname}${u.search}`;
      } catch {
        return url || "";
      }
    }

    /** @param {{ finalUrl?: string, url?: string, filename?: string }} item */
    shouldBlock(item) {
      const url = item.finalUrl || item.url || "";
      const name = item.filename || "";
      const path = DownloadGuard.pathOf(url);

      if (DownloadGuard.#DANGEROUS_EXT.test(path) || DownloadGuard.#DANGEROUS_EXT.test(name)) {
        return true;
      }

      if (DownloadGuard.#BAIT_NAME.test(name) && DownloadGuard.#ARCHIVE_EXT.test(`${name} ${path}`)) {
        return true;
      }

      if (/^(blob:|data:)/i.test(item.url || "") && DownloadGuard.#DANGEROUS_EXT.test(name)) {
        return true;
      }

      return false;
    }
  }

  /**
   * Ordered failover over mirror endpoints (linear probe until first valid HTML).
   * Algorithm: for i in 0..n-1 try fetch; accept if size + structure heuristics pass.
   */
  class MediumMirrorFetcher {
    static #MIN_HTML_LEN = 2000;
    static #ARTICLE_MARK = /<article[\s>]|<h1[\s>]/i;

    /**
     * @param {string} articleUrl
     * @returns {string[]}
     */
    static buildMirrorQueue(articleUrl) {
      const href = String(articleUrl || "");
      const queue = [
        `https://freedium-mirror.cfd/${href}`,
        `https://freedium-mirror.cfd/${href.replace(/^https?:\/\//i, "")}`,
      ];
      return [...new Set(queue)];
    }

    /**
     * @param {string} articleUrl
     * @returns {Promise<{ ok: true, html: string, mirrorUrl: string } | { ok: false, error: string }>}
     */
    async fetchUnlockHtml(articleUrl) {
      const queue = MediumMirrorFetcher.buildMirrorQueue(articleUrl);

      for (const mirrorUrl of queue) {
        try {
          const res = await fetch(mirrorUrl, {
            redirect: "follow",
            credentials: "omit",
            headers: { Accept: "text/html" },
          });
          if (!res.ok) continue;

          const html = await res.text();
          if (html.length < MediumMirrorFetcher.#MIN_HTML_LEN) continue;
          if (!MediumMirrorFetcher.#ARTICLE_MARK.test(html)) continue;

          return { ok: true, html, mirrorUrl };
        } catch {
          // try next mirror in queue
        }
      }

      return { ok: false, error: "mirror_fetch_failed" };
    }
  }

  /** Reload / HTTPS-upgrade the active tab so toggles apply without a manual refresh. */
  class ActiveTabEnforcer {
    static #timer = 0;

    /** Features that only take full effect after a navigation. */
    static RELOAD_KEYS = new Set([
      "httpsUpgrade",
      "randomUa",
      "cosmetics",
      "clickGuard",
      "scriptlets",
      "clipboardGuard",
      "permissionGuard",
      "youtubeSkip",
      "spotifySkip",
      "mediumUnlock",
      "loginWallBypass",
      "phishingGuard",
      "fingerprintGuard",
      "listAutoUpdate",
      "cookieConsent",
      "popupBlocker",
      "antiAdblock",
      "autoplayBlock",
      "strictTracking",
      "minerBlock",
      "malwareWarn",
      "quietMode",
      "adaptiveLearn",
      "trustScore",
      "privacyMode",
      "securityWatch",
      "trackerLearn",
      "privacySignals",
      "dnsDefense",
      "forceEnglish",
      "linkPreview",
      "textSelection",
      "videoPip",
      "readerMode",
      "quizAssist",
      "fbAddFriend",
      "pageInsights",
      "aiAssistant",
    ]);

    /**
     * @param {{ preferHttps?: boolean }} [opts]
     */
    static schedule(opts = {}) {
      clearTimeout(ActiveTabEnforcer.#timer);
      ActiveTabEnforcer.#timer = setTimeout(() => {
        ActiveTabEnforcer.apply(opts).catch((err) => {
          console.warn("GOSAFE adblock tab refresh failed:", err);
        });
      }, 120);
    }

    /**
     * @param {{ preferHttps?: boolean }} [opts]
     */
    static async apply(opts = {}) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id || !tab.url) return;

      let url;
      try {
        url = new URL(tab.url);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;

      if (opts.preferHttps && url.protocol === "http:") {
        const status = await store.getStatus();
        if (status.enabled && status.features.httpsUpgrade !== false) {
          url.protocol = "https:";
          await chrome.tabs.update(tab.id, { url: url.href });
          return;
        }
      }

      await chrome.tabs.reload(tab.id);
    }
  }

  /** Apply DNR + WebRTC + UA + site rules + list updater schedule. */
  async function applyProtectionState(opts = {}) {
    const status = await store.getStatus();
    await rulesets.apply(status.enabled, status.features);
    await webrtc.apply(status.enabled, status.features.webrtcGuard);
    await minerBlock.apply(status.enabled, status.features.minerBlock);
    await strictTracking.apply(status.enabled, status.features.strictTracking);
    await privacySignals.apply(status.enabled, status.features.privacySignals);
    await forceEnglish.apply(status.enabled, status.features.forceEnglish !== false);
    await trackerLearner.applyRules(
      status.enabled && status.features.trackerLearn !== false
    );
    await tempAllow.apply();
    await userAgent.apply(opts);
    await siteRuleStore.hydrate();
    try {
      if (globalThis.AblUserRules?.UserRuleStore) {
        await globalThis.AblUserRules.UserRuleStore.applyOnStartup();
      }
    } catch {
      // ignore user-rule sync failures
    }
    await listUpdater.schedule();
    if (opts.syncLists) {
      await listUpdater.sync();
    }
  }

  /** Routes extension messages to handlers (command map / dispatch table). */
  class MessageRouter {
    /**
     * @param {ExtensionStateStore} store
     * @param {MediumMirrorFetcher} mirrors
     */
    constructor(store, mirrors) {
      this._store = store;
      this._mirrors = mirrors;

      /** @type {Map<string, (message: any, sendResponse: Function) => boolean | void | Promise<void>>} */
      this._handlers = new Map([
        ["getStatus", (message, sendResponse) => {
          this._store.getStatus().then(sendResponse);
          return true;
        }],
        ["setEnabled", (message, sendResponse) => {
          const enabled = Boolean(message.enabled);
          this._store
            .setEnabled(enabled)
            .then(() => applyProtectionState())
            .then(() =>
              activityLog.append({
                kind: enabled
                  ? globalThis.AblActivityLog.ActivityLogStore.kinds.protectOn
                  : globalThis.AblActivityLog.ActivityLogStore.kinds.protectOff,
                title: enabled ? "Protection enabled" : "Protection paused",
              })
            )
            .then(() => {
              ActiveTabEnforcer.schedule({ preferHttps: enabled });
              sendResponse({ ok: true, refreshed: true });
            });
          return true;
        }],
        ["resetCount", (message, sendResponse) => {
          this._store.resetCount().then(() => sendResponse({ ok: true }));
          return true;
        }],
        ["setFeature", (message, sendResponse) => {
          const key = String(message.key || "");
          const value = Boolean(message.value);
          this._store
            .setFeature(key, value)
            .then(async () => {
              const status = await this._store.getStatus();
              if (!status.features.quietMode) {
                await activityLog.append({
                  kind: globalThis.AblActivityLog.ActivityLogStore.kinds.feature,
                  title: value ? `Enabled ${key}` : `Disabled ${key}`,
                  detail: "Feature toggle",
                });
              }
            })
            .then(() =>
              applyProtectionState({
                syncLists: key === "listAutoUpdate" && value,
              })
            )
            .then(() => {
              if (ActiveTabEnforcer.RELOAD_KEYS.has(key)) {
                ActiveTabEnforcer.schedule({
                  preferHttps: key === "httpsUpgrade" && value,
                });
              }
              sendResponse({ ok: true, refreshed: ActiveTabEnforcer.RELOAD_KEYS.has(key) });
            });
          return true;
        }],
        ["setSitePaused", (message, sendResponse) => {
          this._store
            .setSitePaused(String(message.host || ""), message.paused)
            .then(() => {
              ActiveTabEnforcer.schedule({ preferHttps: !message.paused });
              sendResponse({ ok: true, refreshed: true });
            });
          return true;
        }],
        ["getSiteRule", (message, sendResponse) => {
          siteRuleStore.hydrate().then(() => {
            const host = String(message.host || "");
            sendResponse({ host, mode: siteRuleStore.modeFor(host) });
          });
          return true;
        }],
        ["setSiteRule", (message, sendResponse) => {
          const host = String(message.host || "");
          const mode = String(message.mode || "default");
          siteRuleStore
            .setMode(host, mode === "allow" || mode === "block" ? mode : "default")
            .then(async (resolved) => {
              if (mode === "allow") {
                await this._store.setSitePaused(host, false);
              }
              if (mode === "allow" || mode === "block" || mode === "default") {
                await tempAllow.set(host, 0);
              }
              const title =
                resolved === "allow"
                  ? "Whitelisted site (still monitored)"
                  : resolved === "block"
                    ? "Blocked site rule"
                    : "Site rule cleared (Auto)";
              const status = await this._store.getStatus();
              if (!status.features.quietMode) {
                await activityLog.append({
                  kind: globalThis.AblActivityLog.ActivityLogStore.kinds.siteRule,
                  title,
                  detail: host,
                  host,
                });
              }
              ActiveTabEnforcer.schedule({ preferHttps: mode !== "block" });
              sendResponse({ ok: true, host, mode: resolved });
            });
          return true;
        }],
        ["getTempAllow", (message, sendResponse) => {
          tempAllow.expiresAt(String(message.host || "")).then((expiresAt) => {
            sendResponse({ expiresAt });
          });
          return true;
        }],
        ["setTempAllow", (message, sendResponse) => {
          const host = String(message.host || "");
          const minutes = Number(message.minutes) || 0;
          tempAllow
            .set(host, minutes)
            .then(async (result) => {
              if (minutes > 0) {
                await this._store.setSitePaused(host, false);
              }
              const status = await this._store.getStatus();
              if (!status.features.quietMode) {
                await activityLog.append({
                  kind: globalThis.AblActivityLog.ActivityLogStore.kinds.siteRule,
                  title:
                    minutes > 0
                      ? `Temporary allow · ${minutes}m`
                      : "Temporary allow cleared",
                  detail: host,
                  host,
                });
              }
              ActiveTabEnforcer.schedule({ preferHttps: true });
              sendResponse(result);
            });
          return true;
        }],
        ["getSiteFeatureOverride", (message, sendResponse) => {
          siteFeatureOverrides.featuresFor(String(message.host || "")).then((features) => {
            sendResponse({ features });
          });
          return true;
        }],
        ["setSiteFeatureOverride", (message, sendResponse) => {
          const host = String(message.host || "");
          const key = String(message.key || "");
          const value = message.value;
          siteFeatureOverrides
            .set(host, key, value)
            .then((result) => {
              ActiveTabEnforcer.schedule();
              sendResponse(result);
            });
          return true;
        }],
        ["listCustomCosmetics", (message, sendResponse) => {
          const host = String(message.host || "");
          customCosmeticStore.list(host).then((selectors) => {
            sendResponse({ ok: true, host, selectors });
          });
          return true;
        }],
        ["addCustomCosmetic", (message, sendResponse) => {
          const host = String(message.host || "");
          const selector = String(message.selector || "");
          customCosmeticStore.add(host, selector).then(async (result) => {
            if (result.added) {
              await activityLog.append({
                kind: globalThis.AblActivityLog.ActivityLogStore.kinds.system,
                title: "Hidden page element",
                detail: selector.slice(0, 120),
                host,
              });
            }
            sendResponse({ ...result, host });
          });
          return true;
        }],
        ["removeCustomCosmetic", (message, sendResponse) => {
          const host = String(message.host || "");
          const selector = String(message.selector || "");
          customCosmeticStore.remove(host, selector).then((result) => {
            sendResponse({ ...result, host });
          });
          return true;
        }],
        ["clearCustomCosmetics", (message, sendResponse) => {
          const host = String(message.host || "");
          customCosmeticStore.clearHost(host).then((result) => {
            sendResponse({ ...result, host });
          });
          return true;
        }],
        ["scanUrlRisk", (message, sendResponse) => {
          phishingGuard.evaluate(String(message.url || "")).then(sendResponse);
          return true;
        }],
        ["syncFilterLists", (message, sendResponse) => {
          listUpdater.sync().then(async (meta) => {
            await activityLog.append({
              kind: globalThis.AblActivityLog.ActivityLogStore.kinds.listUpdate,
              title: meta?.ok ? "Filter lists updated" : "Filter list update failed",
              detail: meta?.ok
                ? `${meta.count || 0} supplemental rules`
                : String(meta?.error || "error"),
            });
            sendResponse(meta);
          });
          return true;
        }],
        ["getActivityLog", (message, sendResponse) => {
          Promise.all([this._store.getStatus(), siteRuleStore.hydrate()]).then(([status]) => {
            const watchHosts = [];
            for (const [host, mode] of siteRuleStore.book.entries()) {
              if (mode === "allow") watchHosts.push(host);
            }
            activityLog.dashboard({ ...status, watchHosts }).then(sendResponse);
          });
          return true;
        }],
        ["clearActivityLog", (message, sendResponse) => {
          activityLog.clear().then(() => sendResponse({ ok: true }));
          return true;
        }],
        ["exceptionFromLog", (message, sendResponse) => {
          const host = String(message.host || "")
            .replace(/^www\./, "")
            .toLowerCase();
          const mode = message.temp ? null : "allow";
          const minutes = Number(message.minutes) || 60;
          if (!host) {
            sendResponse({ ok: false, reason: "host" });
            return true;
          }
          (async () => {
            if (message.temp) {
              await tempAllow.set(host, minutes);
              await this._store.setSitePaused(host, false);
              if (!(await this._store.getStatus()).features.quietMode) {
                await activityLog.append({
                  kind: globalThis.AblActivityLog.ActivityLogStore.kinds.siteRule,
                  title: `Temporary allow · ${minutes}m (from log)`,
                  detail: host,
                  host,
                });
              }
              ActiveTabEnforcer.schedule({ preferHttps: true });
              sendResponse({ ok: true, host, mode: "temp", minutes });
              return;
            }
            await siteRuleStore.setMode(host, "allow");
            await this._store.setSitePaused(host, false);
            await tempAllow.set(host, 0);
            if (!(await this._store.getStatus()).features.quietMode) {
              await activityLog.append({
                kind: globalThis.AblActivityLog.ActivityLogStore.kinds.siteRule,
                title: "Whitelisted site (from activity log)",
                detail: host,
                host,
              });
            }
            ActiveTabEnforcer.schedule({ preferHttps: true });
            sendResponse({ ok: true, host, mode: "allow" });
          })().catch((err) => sendResponse({ ok: false, error: String(err) }));
          return true;
        }],
        ["getUserRules", (message, sendResponse) => {
          globalThis.AblUserRules.UserRuleStore.load().then(sendResponse);
          return true;
        }],
        ["setUserRules", (message, sendResponse) => {
          const text = String(message.text || "");
          globalThis.AblUserRules.UserRuleStore.save(text)
            .then(async (parsed) => {
              ActiveTabEnforcer.schedule({});
              if (!(await this._store.getStatus()).features.quietMode) {
                await activityLog.append({
                  kind: globalThis.AblActivityLog.ActivityLogStore.kinds.system,
                  title: "User rules saved",
                  detail: `${parsed.blocks.length} blocks · ${Object.keys(parsed.cosmetics).length} cosmetic hosts`,
                });
              }
              sendResponse({ ok: true, ...parsed });
            })
            .catch((err) => sendResponse({ ok: false, error: String(err) }));
          return true;
        }],
        ["logActivity", (message, sendResponse) => {
          const entry = message.entry || {};
          if (!entry.kind || !entry.title) {
            sendResponse({ ok: false });
            return true;
          }
          this._store.getStatus().then(async (status) => {
            if (
              status.features.quietMode &&
              (entry.kind === "system" || entry.kind === "feature" || entry.kind === "hijack")
            ) {
              sendResponse({ ok: true, skipped: true });
              return;
            }
            await activityLog.append(entry);
            sendResponse({ ok: true });
          });
          return true;
        }],
        ["getListUpdateMeta", (message, sendResponse) => {
          chrome.storage.local.get({ listUpdateMeta: null }).then((data) => {
            sendResponse(data.listUpdateMeta || listUpdater.status);
          });
          return true;
        }],
        ["setTheme", (message, sendResponse) => {
          this._store
            .setTheme(String(message.theme || "light"))
            .then(() => sendResponse({ ok: true }));
          return true;
        }],
        ["setProtectionProfile", (message, sendResponse) => {
          this._store
            .setProtectionProfile(String(message.profile || "light"))
            .then((profile) => {
              ActiveTabEnforcer.schedule();
              sendResponse({ ok: true, profile });
            });
          return true;
        }],
        ["fetchMediumUnlock", (message, sendResponse) => {
          this._mirrors.fetchUnlockHtml(String(message.url || "")).then(sendResponse);
          return true;
        }],
        ["getUaStatus", (message, sendResponse) => {
          Promise.all([this._store.getStatus(), userAgent.getSettings()]).then(
            ([status, uaSettings]) => {
              sendResponse({
                enabled: status.enabled,
                featureOn: status.features.randomUa !== false,
                uaSettings,
              });
            }
          );
          return true;
        }],
        ["setUaSettings", (message, sendResponse) => {
          userAgent
            .saveSettings(message.settings || {})
            .then(() => userAgent.apply({ renew: Boolean(message.renew) }))
            .then((result) => {
              if (message.renew) ActiveTabEnforcer.schedule();
              sendResponse(result);
            });
          return true;
        }],
        ["renewUserAgent", (message, sendResponse) => {
          userAgent.renew().then(async (result) => {
            await activityLog.append({
              kind: globalThis.AblActivityLog.ActivityLogStore.kinds.uaRenew,
              title: "User-Agent renewed",
              detail: String(result?.uaSettings?.current || "").slice(0, 120),
            });
            ActiveTabEnforcer.schedule();
            sendResponse(result);
          });
          return true;
        }],
        ["openUaOptions", (message, sendResponse) => {
          chrome.runtime.openOptionsPage?.();
          sendResponse({ ok: true });
          return true;
        }],
        ["observeAdaptive", (message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.adaptiveLearn === false) {
              sendResponse({ ok: false, skipped: true });
              return;
            }
            const result = await adaptiveLearn.observe(
              {
                host: String(message.host || ""),
                selector: String(message.selector || ""),
                detail: String(message.detail || ""),
                kind: String(message.kind || "dismiss"),
              },
              {
                addCosmetic: (host, selector) => customCosmeticStore.add(host, selector),
              }
            );
            if (result.promoted && !status.features.quietMode) {
              await activityLog.append({
                kind: globalThis.AblActivityLog.ActivityLogStore.kinds.system,
                title: "Adaptive rule learned",
                detail: String(result.selector || result.pattern || "").slice(0, 140),
                host: String(message.host || ""),
              });
            }
            sendResponse(result);
          });
          return true;
        }],
        ["getAdaptiveStatus", (message, sendResponse) => {
          adaptiveLearn.status().then(sendResponse);
          return true;
        }],
        ["clearAdaptiveLearn", (message, sendResponse) => {
          adaptiveLearn.clear().then(sendResponse);
          return true;
        }],
        ["getTrustScore", (message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.trustScore === false) {
              sendResponse({ ok: false, disabled: true });
              return;
            }
            const url = String(message.url || "");
            let host = "";
            try {
              host = globalThis.AblDs.HostKey.fromUrl(url) || "";
            } catch {
              host = "";
            }
            const hints = {
              thirdPartyScripts: Number(message.thirdPartyScripts) || 0,
              listHit: host ? listUpdater.lookup(host) : null,
            };
            const report = globalThis.AblPhishing.TrustScore.evaluate(url, hints);
            sendResponse({ ok: true, ...report });
          });
          return true;
        }],
        ["getPagePermissions", (message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.pageInsights === false) {
              sendResponse({ ok: false, disabled: true });
              return;
            }
            const origin = String(message.origin || "");
            sendResponse(await pageInsights.getPermissions(origin));
          });
          return true;
        }],
        ["setPagePermission", (message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.pageInsights === false) {
              sendResponse({ ok: false, disabled: true });
              return;
            }
            sendResponse(
              await pageInsights.setPermission(
                String(message.origin || ""),
                String(message.permission || ""),
                String(message.setting || "")
              )
            );
          });
          return true;
        }],
        ["blockThirdPartiesSession", (message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.pageInsights === false) {
              sendResponse({ ok: false, disabled: true });
              return;
            }
            const result = await pageInsights.blockThirdPartiesSession(
              message.hosts,
              String(message.pageHost || "")
            );
            if (result.ok && activityLog) {
              activityLog.append({
                kind: globalThis.AblActivityLog.ActivityLogStore.kinds.feature,
                title: "Session third-party block",
                detail: `${result.count || 0} host(s)`,
                host: String(message.pageHost || ""),
              });
            }
            sendResponse(result);
          });
          return true;
        }],
        ["getDnsDefenseStatus", (_message, sendResponse) => {
          this._store.getStatus().then((status) => {
            if (!status.enabled || status.features.dnsDefense === false) {
              sendResponse({ ok: false, disabled: true });
              return;
            }
            sendResponse(dnsDefense ? dnsDefense.status() : { ok: false, disabled: true });
          });
          return true;
        }],
        ["forceEnglishNavigate", (message, sendResponse, sender) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.forceEnglish === false) {
              sendResponse({ ok: false, disabled: true });
              return;
            }
            const url = String(message.url || "");
            if (!/^https:\/\/[a-z0-9.-]+\.translate\.goog(\/|$|\?)/i.test(url)) {
              sendResponse({ ok: false, error: "invalid_proxy" });
              return;
            }
            try {
              const tabId = sender?.tab?.id;
              if (!tabId) {
                sendResponse({ ok: false, error: "no_tab" });
                return;
              }
              await chrome.tabs.update(tabId, { url });
              sendResponse({ ok: true });
            } catch (err) {
              sendResponse({ ok: false, error: String(err?.message || err) });
            }
          });
          return true;
        }],
        ["translateToEnglish", (message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.forceEnglish === false) {
              sendResponse({ ok: false, disabled: true, texts: [] });
              return;
            }
            const texts = Array.isArray(message.texts) ? message.texts.map((t) => String(t ?? "")) : [];
            if (!texts.length) {
              sendResponse({ ok: true, texts: [] });
              return;
            }
            try {
              const result = await ForceEnglishTranslator.translateMany(texts, "auto", "en");
              sendResponse({ ok: true, texts: result.texts, detected: result.detected });
            } catch (err) {
              sendResponse({
                ok: false,
                error: String(err?.message || err),
                texts,
              });
            }
          });
          return true;
        }],
        ["translateSelection", (message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.textSelection === false) {
              sendResponse({ ok: false, disabled: true, text: "", detected: "" });
              return;
            }
            const text = String(message.text || "").slice(0, 4500);
            const from = String(message.from || "auto");
            const to = String(message.to || "en");
            if (!text.trim()) {
              sendResponse({ ok: true, text: "", detected: from });
              return;
            }
            try {
              const result = await ForceEnglishTranslator.translateMany([text], from, to);
              sendResponse({
                ok: true,
                text: result.texts[0] || text,
                detected: result.detected,
                segments: result.segments?.[0] || [],
              });
            } catch (err) {
              sendResponse({
                ok: false,
                error: String(err?.message || err),
                text,
                detected: from,
                segments: [],
              });
            }
          });
          return true;
        }],
        ["previewLink", (message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.linkPreview === false) {
              sendResponse({ ok: false, disabled: true });
              return;
            }
            try {
              const report = await LinkPreviewService.inspect(
                String(message.url || ""),
                String(message.kind || "page")
              );
              sendResponse(report);
            } catch (err) {
              sendResponse({ ok: false, error: String(err?.message || err) });
            }
          });
          return true;
        }],
        ["getAiSettings", (_message, sendResponse) => {
          const Ai = globalThis.AblAi?.NvidiaAiSettings;
          if (!Ai) {
            sendResponse({ ok: false, error: "ai_unavailable" });
            return false;
          }
          Ai.get().then((s) => sendResponse({ ok: true, ...s, apiKey: s.hasKey ? "••••••••" : "" }));
          return true;
        }],
        ["setAiSettings", (message, sendResponse) => {
          const Ai = globalThis.AblAi?.NvidiaAiSettings;
          if (!Ai) {
            sendResponse({ ok: false, error: "ai_unavailable" });
            return false;
          }
          const patch = {};
          if (message.enabled !== undefined) patch.enabled = Boolean(message.enabled);
          if (message.model !== undefined) patch.model = String(message.model || "");
          if (message.apiKey !== undefined) {
            const key = String(message.apiKey || "").trim();
            // Ignore masked placeholder so we don't wipe a real key
            if (key && !/^•+$/.test(key)) patch.apiKey = key;
            if (message.clearKey) patch.apiKey = "";
          }
          Ai.set(patch).then((s) => sendResponse({ ok: true, ...s }));
          return true;
        }],
        ["aiExplainAlert", (message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.aiAssistant === false) {
              sendResponse({ ok: false, disabled: true });
              return;
            }
            const Chat = globalThis.AblAi?.NvidiaChatClient;
            if (!Chat) {
              sendResponse({ ok: false, error: "ai_unavailable" });
              return;
            }
            try {
              const result = await Chat.explainAlert(message.entry || {});
              sendResponse(result);
            } catch (err) {
              sendResponse({ ok: false, error: String(err?.message || err) });
            }
          });
          return true;
        }],
        ["aiAnswerQuiz", (message, sendResponse) => {
          let replied = false;
          const reply = (payload) => {
            if (replied) return;
            replied = true;
            try {
              sendResponse(payload);
            } catch {
              // channel already closed
            }
          };
          (async () => {
            const status = await this._store.getStatus();
            const fromSelection = message?.source === "selection" || Boolean(message?.text);
            if (!status.enabled) {
              reply({ ok: false, error: "disabled" });
              return;
            }
            if (
              status.features.quizAssist === false &&
              (!fromSelection || status.features.textSelection === false)
            ) {
              reply({ ok: false, error: "disabled" });
              return;
            }
            const Chat = globalThis.AblAi?.NvidiaChatClient;
            if (!Chat) {
              reply({ ok: false, error: "ai_unavailable" });
              return;
            }
            let result;
            if (fromSelection && message.text) {
              result = await Chat.answerSelectionQuiz({
                text: message.text,
                host: message.host,
              });
            } else {
              result = await Chat.answerQuiz({
                question: message.question,
                choices: message.choices,
                host: message.host,
                mode: message.mode,
                maxLen: message.maxLen,
              });
            }
            reply(result && typeof result === "object" ? result : { ok: false, error: "empty_result" });
          })().catch((err) => {
            reply({ ok: false, error: String(err?.message || err || "quiz_failed") });
          });
          return true;
        }],
        ["aiAnalyzeActiveTab", (_message, sendResponse) => {
          this._store.getStatus().then(async (status) => {
            if (!status.enabled || status.features.aiAssistant === false) {
              sendResponse({ ok: false, disabled: true });
              return;
            }
            const Chat = globalThis.AblAi?.NvidiaChatClient;
            if (!Chat) {
              sendResponse({ ok: false, error: "ai_unavailable" });
              return;
            }
            try {
              const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
              const tab = tabs[0];
              if (!tab?.id || !tab.url) {
                sendResponse({ ok: false, error: "no_tab" });
                return;
              }
              let parsed;
              try {
                parsed = new URL(tab.url);
              } catch {
                sendResponse({ ok: false, error: "bad_url" });
                return;
              }
              if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                sendResponse({ ok: false, error: "unsupported_page" });
                return;
              }

              let fingerprint = null;
              try {
                fingerprint = await chrome.tabs.sendMessage(tab.id, { type: "collectPageTech" });
                fingerprint = fingerprint?.fingerprint || null;
              } catch {
                fingerprint = null;
              }
              if (!fingerprint) {
                fingerprint = {
                  url: tab.url,
                  host: parsed.hostname.replace(/^www\./, ""),
                  title: tab.title || "",
                  note: "Content probe unavailable — using tab metadata only",
                };
              }

              // Server / CDN response headers (service worker has host access)
              try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 5000);
                const res = await fetch(parsed.href, {
                  method: "GET",
                  redirect: "follow",
                  credentials: "omit",
                  signal: ctrl.signal,
                  headers: { Accept: "text/html", "User-Agent": "GOSAFE-PageProbe/1.0" },
                });
                clearTimeout(timer);
                try {
                  res.body?.cancel?.();
                } catch {
                  // ignore
                }
                const want = [
                  "server",
                  "x-powered-by",
                  "via",
                  "cf-ray",
                  "cf-cache-status",
                  "x-vercel-id",
                  "x-vercel-cache",
                  "x-shopify-stage",
                  "x-generator",
                  "x-drupal-cache",
                  "x-aspnet-version",
                  "strict-transport-security",
                  "content-security-policy",
                  "x-frame-options",
                  "x-content-type-options",
                  "referrer-policy",
                  "permissions-policy",
                  "report-to",
                  "nel",
                ];
                const headers = {};
                for (const name of want) {
                  const v = res.headers.get(name);
                  if (v) headers[name] = String(v).slice(0, 240);
                }
                fingerprint.serverHints = {
                  finalUrl: res.url || parsed.href,
                  status: res.status,
                  headers,
                };
              } catch (err) {
                fingerprint.serverHints = {
                  error: String(err?.message || err || "header_probe_failed"),
                };
              }

              const result = await Chat.analyzePage(fingerprint);
              sendResponse({ ...result, fingerprint });
            } catch (err) {
              sendResponse({ ok: false, error: String(err?.message || err) });
            }
          });
          return true;
        }],
        ["getWebRtcStatus", (_message, sendResponse) => {
          sendResponse({ ok: true, ...webrtc.status });
          return false;
        }],
        ["setPrivacyMode", (message, sendResponse) => {
          const on = Boolean(message.on);
          privacyMode
            .set(on, { clearCookies: message.clearCookies !== false })
            .then(async (result) => {
              await applyProtectionState({ force: true });
              ActiveTabEnforcer.schedule({ preferHttps: on });
              const status = await this._store.getStatus();
              if (!status.features.quietMode) {
                await activityLog.append({
                  kind: globalThis.AblActivityLog.ActivityLogStore.kinds.feature,
                  title: on ? "Privacy mode on" : "Privacy mode off",
                  detail: on ? "Trackers, fingerprint, HTTPS, cookies" : "",
                });
              }
              sendResponse(result);
            });
          return true;
        }],
        ["clearPrivacyCookies", (message, sendResponse) => {
          privacyMode.clearSessionCookies().then(sendResponse);
          return true;
        }],
        ["getSecurityFirewall", (message, sendResponse) => {
          securityFirewall.forHost(String(message.host || "")).then(sendResponse);
          return true;
        }],
        ["securityAlert", (message, sendResponse) => {
          const entry = message.entry || {};
          const host = String(entry.host || message.host || "");
          securityFirewall.alert(host, entry).then(async () => {
            const status = await this._store.getStatus();
            if (!status.features.quietMode) {
              await activityLog.append({
                kind: globalThis.AblActivityLog.ActivityLogStore.kinds.system,
                title: String(entry.title || "Security alert").slice(0, 140),
                detail: String(entry.detail || "").slice(0, 180),
                host,
              });
            }
            sendResponse({ ok: true });
          });
          return true;
        }],
        ["securityMetric", (message, sendResponse) => {
          const host = String(message.host || "");
          const metric = String(message.metric || "");
          const field =
            metric === "fingerprint"
              ? "fingerprint"
              : metric === "suspicious"
                ? "suspicious"
                : "";
          if (!field) {
            sendResponse({ ok: false });
            return true;
          }
          securityFirewall.bump(host, field, 1).then(() => sendResponse({ ok: true }));
          return true;
        }],
        ["openSecurityAssistant", (message, sendResponse) => {
          chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
            const tab = tabs?.[0];
            const u = new URL(chrome.runtime.getURL("popup/security.html"));
            if (tab?.id) u.searchParams.set("tabId", String(tab.id));
            if (tab?.url) u.searchParams.set("url", tab.url);
            await chrome.tabs.create({ url: u.href });
            sendResponse({ ok: true });
          });
          return true;
        }],
        ["getTrackerLearnStatus", (message, sendResponse) => {
          trackerLearner.status().then(sendResponse);
          return true;
        }],
        ["clearTrackerLearn", (message, sendResponse) => {
          trackerLearner
            .clear()
            .then(() => applyProtectionState())
            .then(() => sendResponse({ ok: true }));
          return true;
        }],
      ]);
    }

    /**
     * @param {any} message
     * @param {(value: any) => void} sendResponse
     * @returns {boolean}
     */
    dispatch(message, sendResponse, sender) {
      const type = message?.type;
      const handler = type ? this._handlers.get(type) : null;
      if (!handler) return false;
      return Boolean(handler(message, sendResponse, sender));
    }
  }

  // ---------------------------------------------------------------------------
  // Composition root
  // ---------------------------------------------------------------------------

  const store = new ExtensionStateStore();
  const rulesets = new RulesetController();
  const webrtc = new WebRtcPrivacyController();
  const tempAllow = new TempAllowController();
  const minerBlock = new MinerBlockController();
  const strictTracking = new StrictTrackingController();
  const privacySignals = new PrivacySignalsController();
  const pageInsights = new PageInsightsController();
  const forceEnglish = new ForceEnglishController();
  const siteFeatureOverrides = new SiteFeatureOverrideStore();
  const privacyMode = new PrivacyModeController(store);
  const securityFirewall = new SecurityFirewallStore();
  const trackerLearner = globalThis.AblTrackerLearn
    ? new globalThis.AblTrackerLearn.HeuristicTrackerLearner()
    : {
        async hydrate() {},
        async observe() {
          return null;
        },
        async applyRules() {},
        async status() {
          return { watching: 0, blocked: 0, list: [] };
        },
        async clear() {
          return { ok: true };
        },
      };
  const adaptiveLearn = globalThis.AblAdaptive
    ? new globalThis.AblAdaptive.AdaptiveLearnStore()
    : {
        async hydrate() {},
        async observe() {
          return { ok: false };
        },
        async status() {
          return { patterns: 0, hosts: 0, promoted: 0 };
        },
        async clear() {
          return { ok: true };
        },
      };
  const userAgent = new UserAgentController(store);
  const downloadGuard = new DownloadGuard();
  const mirrors = new MediumMirrorFetcher();

  if (!globalThis.AblDs || !globalThis.AblSiteRules || !globalThis.AblPhishing || !globalThis.AblListUpdater || !globalThis.AblActivityLog) {
    console.error("GOSAFE adblock: required modules failed to load");
  }

  adaptiveLearn.hydrate?.().catch(() => {});
  trackerLearner.hydrate?.().catch(() => {});

  const siteRuleStore = new globalThis.AblSiteRules.SiteRuleStore();
  const customCosmeticStore = new globalThis.AblCustomCosmetics.CustomCosmeticStore();
  const listUpdater = new globalThis.AblListUpdater.SupplementalListUpdater(() =>
    store.getStatus()
  );
  const phishingGuard = new globalThis.AblPhishing.PhishingNavigationGuard(
    () => store.getStatus(),
    (host) => listUpdater.lookup(host)
  );
  listUpdater.hydrate?.().catch(() => {});
  const dnsDefense =
    globalThis.AblDnsDefense?.DnsDefenseEngine
      ? new globalThis.AblDnsDefense.DnsDefenseEngine()
      : null;
  const activityLog = globalThis.AblActivityLog
    ? new globalThis.AblActivityLog.ActivityLogStore()
    : {
        async append() {},
        async list() {
          return [];
        },
        async clear() {},
        async ensureStarted() {},
        async recordBlock() {},
        async setTip() {
          return false;
        },
        async dashboard() {
          return { entries: [], kpis: {}, features: [] };
        },
      };

  /**
   * Silent one-line tips on serious alerts — no popup UI.
   * Runs only when an NVIDIA API key is already stored.
   */
  class SilentAlertTips {
    static #KINDS = new Set(["phishing", "dns", "hijack", "soft_nav", "download", "site_block"]);
    static #lastAt = 0;
    static #MIN_GAP_MS = 20_000;
    static #busy = false;

    /**
     * @param {{ id?: string, kind?: string, title?: string, detail?: string, host?: string }} entry
     */
    static maybeEnrich(entry) {
      if (!entry?.id || !SilentAlertTips.#KINDS.has(String(entry.kind || ""))) return;
      if (SilentAlertTips.#busy) return;
      const now = Date.now();
      if (now - SilentAlertTips.#lastAt < SilentAlertTips.#MIN_GAP_MS) return;
      SilentAlertTips.#busy = true;
      SilentAlertTips.#lastAt = now;
      (async () => {
        try {
          const Ai = globalThis.AblAi;
          if (!Ai?.NvidiaAiSettings || !Ai?.NvidiaChatClient) return;
          const settings = await Ai.NvidiaAiSettings.get();
          if (!settings.hasKey || settings.enabled === false) return;
          const result = await Ai.NvidiaChatClient.silentTip(entry);
          if (!result?.ok || !result.text) return;
          await activityLog.setTip(entry.id, result.text);
        } catch {
          // silent
        } finally {
          SilentAlertTips.#busy = false;
        }
      })();
    }

    /** Wrap activityLog.append so serious events get a tip in the background. */
    static install(log) {
      if (!log || typeof log.append !== "function") return log;
      const original = log.append.bind(log);
      log.append = async (partial) => {
        const entry = await original(partial);
        try {
          SilentAlertTips.maybeEnrich(entry);
        } catch {
          // ignore
        }
        return entry;
      };
      return log;
    }
  }

  SilentAlertTips.install(activityLog);
  const router = new MessageRouter(store, mirrors);

  async function cancelDownload(id) {
    try {
      await chrome.downloads.cancel(id);
    } catch {
      // already finished/cancelled
    }
    try {
      await chrome.downloads.erase({ id });
    } catch {
      // ignore
    }
    await store.bumpBlocked();
    await activityLog.append({
      kind: globalThis.AblActivityLog.ActivityLogStore.kinds.download,
      title: "Blocked risky download",
    });
  }

  chrome.runtime.onInstalled.addListener(async () => {
    try {
      await store.ensureDefaults();
      await activityLog.ensureStarted();
      await applyProtectionState({ renew: false, force: true, syncLists: true });
    } catch (err) {
      console.error("GOSAFE adblock install init failed:", err);
      try {
        await rulesets.apply(true, DEFAULT_FEATURES);
      } catch {
        // ignore
      }
    }
  });

  chrome.runtime.onStartup.addListener(async () => {
    try {
      const settings = await userAgent.getSettings();
      await activityLog.ensureStarted();
      await privacyMode.maybeClearOnStartup();
      await applyProtectionState({
        renew: settings.renewOnStartup !== false,
        syncLists: false,
      });
    } catch (err) {
      console.error("GOSAFE adblock startup init failed:", err);
    }
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    try {
      if (alarm.name === UserAgentController.ALARM) {
        const result = await userAgent.renew();
        const status = await store.getStatus();
        if (!status.features.quietMode) {
          await activityLog.append({
            kind: globalThis.AblActivityLog.ActivityLogStore.kinds.uaRenew,
            title: "User-Agent auto-renewed",
            detail: String(result?.uaSettings?.current || "").slice(0, 120),
          });
        }
      } else if (alarm.name === globalThis.AblListUpdater.SupplementalListUpdater.ALARM) {
        const meta = await listUpdater.sync();
        const status = await store.getStatus();
        if (!status.features.quietMode) {
          await activityLog.append({
            kind: globalThis.AblActivityLog.ActivityLogStore.kinds.listUpdate,
            title: meta?.ok ? "Lists auto-updated" : "List auto-update failed",
            detail: meta?.ok ? `${meta.count || 0} rules` : String(meta?.error || ""),
          });
        }
      } else if (alarm.name === TempAllowController.ALARM) {
        await tempAllow.sweep();
      }
    } catch (err) {
      console.warn("GOSAFE adblock alarm failed:", err);
    }
  });

  chrome.webNavigation?.onBeforeNavigate?.addListener(async (details) => {
    if (details.frameId !== 0) return;
    const url = details.url || "";
    if (!/^https?:/i.test(url)) return;
    if (url.startsWith(chrome.runtime.getURL(""))) return;

    try {
      await siteRuleStore.hydrate();
      const host = globalThis.AblDs.HostKey.fromUrl(url);
      if (await tempAllow.isActive(host)) return;
      const mode = siteRuleStore.modeFor(host);
      if (mode === "allow") return;

      if (mode === "block") {
        const warn = phishingGuard.warningUrl(url, 100, ["site_block"]);
        await chrome.tabs.update(details.tabId, { url: warn });
        await activityLog.append({
          kind: globalThis.AblActivityLog.ActivityLogStore.kinds.siteBlock,
          title: "Blocked site rule",
          detail: url.slice(0, 140),
          host,
        });
        return;
      }

      const verdict = await phishingGuard.evaluate(url);
      if (verdict.block) {
        const warn = phishingGuard.warningUrl(url, verdict.score, verdict.reasons);
        await chrome.tabs.update(details.tabId, { url: warn });
        const listNote =
          verdict.listHit === "phishing_feed"
            ? "live phishing feed"
            : verdict.listHit === "nrd"
              ? "NRD feed"
              : "";
        await activityLog.append({
          kind: globalThis.AblActivityLog.ActivityLogStore.kinds.phishing,
          title: listNote
            ? `Phishing warning · ${listNote}`
            : `Phishing warning · score ${verdict.score}`,
          detail: (verdict.reasons || []).join(", ") || url.slice(0, 140),
          host: verdict.host || host,
        });
      }

      // Real-time DNS spoof / rebinding check (multi-resolver consensus).
      if (dnsDefense) {
        const st = await store.getStatus();
        if (st.enabled && st.features.dnsDefense !== false) {
          const spoof = await dnsDefense.checkSpoof(host);
          if (spoof && !st.features.quietMode) {
            await activityLog.append({
              kind: globalThis.AblActivityLog.ActivityLogStore.kinds.dns,
              title: spoof.title,
              detail: spoof.detail,
              host: spoof.host || host,
            });
          }
        }
      }
    } catch (err) {
      console.warn("GOSAFE adblock navigation guard failed:", err);
    }
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (!changes.enabled && !changes.features && !changes.uaSettings && !changes.siteRules) {
      return;
    }
    if (changes.uaSettings && !changes.enabled && !changes.features && !changes.siteRules) {
      return;
    }
    await applyProtectionState();
  });

  /** Only count / log real block actions — allowlist matches are NOT blocks. */
  class MatchedRuleClassifier {
    static SKIP_RULESETS = new Set(["allowlist", "https_upgrade", "trackparams"]);

    /**
     * @param {{ rule?: { rulesetId?: string, ruleId?: number } }} info
     */
    static isBlock(info) {
      const rulesetId = String(info?.rule?.rulesetId || "");
      const ruleId = Number(info?.rule?.ruleId) || 0;
      if (!rulesetId) return false;
      if (MatchedRuleClassifier.SKIP_RULESETS.has(rulesetId)) return false;

      // Dynamic rules: UA spoof + site allow are not blocks.
      if (rulesetId === "_dynamic" || rulesetId === "_session") {
        if (ruleId === 9001) return false; // User-Agent modifyHeaders
        if (ruleId === 9003) return false; // Force English Accept-Language
        if (ruleId === 9101) return false; // per-site allow
        if (ruleId === 9102) return false; // temporary allow
        if (ruleId === 9401) return false; // strict tracking referer strip
        if (ruleId === 9402) return false; // GPC / DNT headers
        // 9200+ site blocks, 9300 miner, 9500 learned trackers, 10000+ supplemental
        return ruleId >= 9200;
      }

      // Static blocklists / urlfilters / protections / spotify
      return true;
    }

    /**
     * Human-readable provenance for activity log.
     * @param {{ rule?: { rulesetId?: string, ruleId?: number } }} info
     */
    static sourceLabel(info) {
      const rulesetId = String(info?.rule?.rulesetId || "");
      const ruleId = Number(info?.rule?.ruleId) || 0;
      if (rulesetId.startsWith("blocklist")) return "HaGeZi / static lists";
      if (rulesetId.startsWith("urlfilter")) return "URL filters";
      if (rulesetId === "protections") return "Protections";
      if (rulesetId === "d3host") return "d3ward hosts";
      if (rulesetId === "redirects") return "Redirect stubs";
      if (rulesetId === "trackparams") return "URL tracking strip";
      if (rulesetId === "spotify") return "Spotify";
      if (rulesetId === "_dynamic" || rulesetId === "_session") {
        if (ruleId >= 10000) return "Live phishing / NRD";
        if (ruleId >= 9700 && ruleId < 9800) return "Page Insights session block";
        if (ruleId >= 9600 && ruleId < 9700) return "User rules";
        if (ruleId >= 9500 && ruleId < 9600) return "Learned trackers";
        if (ruleId === 9300) return "Miner block";
        if (ruleId >= 9200 && ruleId < 9300) return "Site block rule";
        return "Dynamic rules";
      }
      return rulesetId || "rules";
    }

    /**
     * @param {{ rule?: { rulesetId?: string, ruleId?: number } }} info
     * @returns {"block" | "redirect"}
     */
    static actionKind(info) {
      const rulesetId = String(info?.rule?.rulesetId || "");
      if (rulesetId === "redirects" || rulesetId === "trackparams") return "redirect";
      return "block";
    }
  }

  chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener(async (info) => {
    if (!MatchedRuleClassifier.isBlock(info)) return;
    await store.bumpBlocked();
    try {
      await activityLog.recordBlock({
        url: info?.request?.url,
        initiator: info?.request?.initiator,
        rulesetId: info?.rule?.rulesetId,
        ruleId: info?.rule?.ruleId,
        source: MatchedRuleClassifier.sourceLabel(info),
        type: info?.request?.type,
        action: MatchedRuleClassifier.actionKind(info),
      });
      const initiatorHost = globalThis.AblDs?.HostKey?.fromUrl
        ? globalThis.AblDs.HostKey.fromUrl(info?.request?.initiator || "")
        : "";
      if (initiatorHost) {
        await securityFirewall.bump(initiatorHost, "trackers", 1);
        const ruleId = Number(info?.rule?.ruleId) || 0;
        if (ruleId === 9300) {
          await securityFirewall.bump(initiatorHost, "suspicious", 1);
        }
      }
    } catch {
      // ignore log failures
    }
  });

  chrome.downloads.onCreated.addListener(async (item) => {
    const status = await store.getStatus();
    if (!status.enabled || !status.features.downloadGuard) return;
    if (!downloadGuard.shouldBlock(item)) return;
    try {
      const host = globalThis.AblDs?.HostKey?.fromUrl
        ? globalThis.AblDs.HostKey.fromUrl(item.finalUrl || item.url || "")
        : "";
      await securityFirewall.alert(host || "download", {
        kind: "attack",
        title: "GOSAFE blocked: Drive-by download",
        detail: String(item.filename || item.url || "").slice(0, 160),
      });
    } catch {
      // ignore
    }
    await cancelDownload(item.id);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    return router.dispatch(message, sendResponse, sender);
  });

  // Privacy Badger–style observation of third-party requests + DNS tunnel heuristics.
  if (chrome.webRequest?.onCompleted) {
    chrome.webRequest.onCompleted.addListener(
      async (details) => {
        try {
          const status = await store.getStatus();
          if (!status.enabled) return;

          if (dnsDefense && status.features.dnsDefense !== false) {
            let reqHost = "";
            try {
              reqHost = new URL(details.url || "").hostname;
            } catch {
              reqHost = "";
            }
            if (reqHost) {
              const tunnel = dnsDefense.observeHostname(reqHost);
              if (tunnel && !status.features.quietMode) {
                await activityLog.append({
                  kind: globalThis.AblActivityLog.ActivityLogStore.kinds.dns,
                  title: tunnel.title,
                  detail: tunnel.detail,
                  host: tunnel.host,
                  initiator: (() => {
                    try {
                      return globalThis.AblDs.HostKey.fromUrl(details.initiator || "") || "";
                    } catch {
                      return "";
                    }
                  })(),
                });
              }
            }
          }

          if (status.features.trackerLearn === false) return;
          const result = await trackerLearner.observe(details);
          if (result?.promoted && !status.features.quietMode) {
            await activityLog.append({
              kind: globalThis.AblActivityLog.ActivityLogStore.kinds.system,
              title: "Learned tracker blocked",
              detail: `${result.tracker} seen on ${result.count}+ sites`,
              host: result.tracker,
            });
            await securityFirewall.bump(result.tracker, "trackers", 1);
          }
        } catch {
          // ignore
        }
      },
      {
        urls: ["<all_urls>"],
        types: [
          "script",
          "image",
          "xmlhttprequest",
          "ping",
          "sub_frame",
          "websocket",
          "other",
        ],
      }
    );
  }
})();
