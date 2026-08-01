(() => {
  "use strict";

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
  });

  const PROFILE_HINTS = Object.freeze({
    speed: "Fastest pages — network blocks only, light UI hide",
    light: "Balanced blocking with lighter page work",
    advanced: "Max cosmetics & spoofing — may use more CPU",
  });

  const PROFILE_LABELS = Object.freeze({
    speed: "Speed",
    light: "Light",
    advanced: "Advanced",
  });

  /** @param {unknown} raw @param {object} [features] */
  function sanitizeProfile(raw, features) {
    const v = String(raw || "").toLowerCase();
    if (v === "speed" || v === "light" || v === "advanced") return v;
    if (features && features.speedMode === false) return "advanced";
    if (features && features.speedMode === true) return "speed";
    return "light";
  }

  class PopupStatus {
    constructor(raw = {}) {
      this.enabled = Boolean(raw.enabled ?? true);
      this.blockedCount = Number(raw.blockedCount) || 0;
      this.features = { ...DEFAULT_FEATURES, ...(raw.features || {}) };
      this.pausedHosts = Array.isArray(raw.pausedHosts) ? raw.pausedHosts : [];
      this.theme = raw.theme === "dark" ? "dark" : "light";
      this.protectionProfile = sanitizeProfile(raw.protectionProfile, raw.features);
    }
  }

  class BackgroundClient {
    async getStatus() {
      const raw = await chrome.runtime.sendMessage({ type: "getStatus" });
      return new PopupStatus(raw);
    }

    async setEnabled(enabled) {
      await chrome.runtime.sendMessage({ type: "setEnabled", enabled: Boolean(enabled) });
    }

    async setFeature(key, value) {
      await chrome.runtime.sendMessage({
        type: "setFeature",
        key,
        value: Boolean(value),
      });
    }

    async setSitePaused(host, paused) {
      await chrome.runtime.sendMessage({
        type: "setSitePaused",
        host,
        paused: Boolean(paused),
      });
    }

    async setTheme(theme) {
      await chrome.runtime.sendMessage({ type: "setTheme", theme });
    }

    async resetCount() {
      await chrome.runtime.sendMessage({ type: "resetCount" });
    }

    async getActivityLog() {
      return chrome.runtime.sendMessage({ type: "getActivityLog" });
    }

    async clearActivityLog() {
      await chrome.runtime.sendMessage({ type: "clearActivityLog" });
    }
  }

  class ThemeController {
    static #LOGO_LIGHT = "../icons/default_logo.png";
    static #LOGO_DARK = "../icons/logo_whenturntodarkmode.png";

    /**
     * @param {HTMLElement} root
     * @param {HTMLElement} icon
     * @param {HTMLImageElement | null} [logo]
     */
    constructor(root, icon, logo = null) {
      this._root = root;
      this._icon = icon;
      this._logo = logo;
    }

    /** @param {"light" | "dark"} theme */
    apply(theme) {
      const next = theme === "dark" ? "dark" : "light";
      this._root.setAttribute("data-theme", next);
      this._icon.className = next === "dark" ? "fa-regular fa-sun" : "fa-regular fa-moon";
      if (this._logo) {
        this._logo.src =
          next === "dark" ? ThemeController.#LOGO_DARK : ThemeController.#LOGO_LIGHT;
      }
      return next;
    }

    toggle(current) {
      return current === "dark" ? "light" : "dark";
    }
  }

  class ActiveTabInfo {
    static async resolve() {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) return { host: "", kind: "unknown", insecure: false };
        const url = new URL(tab.url);
        if (!/^https?:$/i.test(url.protocol)) {
          return { host: url.protocol.replace(":", ""), kind: "internal", insecure: false };
        }
        const host = url.hostname.replace(/^www\./, "").toLowerCase();
        let kind = "site";
        if (host === "youtube.com" || host.endsWith(".youtube.com")) kind = "youtube";
        else if (host === "medium.com" || host.endsWith(".medium.com")) kind = "medium";
        else if (/anime|stream|movie|film|watch|fullhd|vid/i.test(host)) kind = "media";
        return {
          host,
          kind,
          url: tab.url,
          insecure: url.protocol === "http:",
        };
      } catch {
        return { host: "", kind: "unknown" };
      }
    }
  }

  class PopupView {
    constructor() {
      this.body = document.body;
      this.html = document.documentElement;
      this.toggle = document.getElementById("toggle");
      this.statusText = document.getElementById("statusText");
      this.blockedCount = document.getElementById("blockedCount");
      this.modeText = document.getElementById("modeText");
      this.actionClear = document.getElementById("actionClear");
      this.pauseSite = document.getElementById("pauseSite");
      this.pauseSiteLabel = document.getElementById("pauseSiteLabel");
      this.pauseSiteIcon = document.getElementById("pauseSiteIcon");
      this.siteHost = document.getElementById("siteHost");
      this.siteHint = document.getElementById("siteHint");
      this.versionText = document.getElementById("versionText");
      this.themeToggle = document.getElementById("themeToggle");
      this.themeIcon = document.getElementById("themeIcon");
      this.featuresToggle = document.getElementById("featuresToggle");
      this.featuresSection = document.getElementById("featuresSection");
      this.brandLogo = document.getElementById("brandLogo");
      this.theme = new ThemeController(this.html, this.themeIcon, this.brandLogo);
      this.featureInputs = {
        cosmetics: document.getElementById("featCosmetics"),
        clickGuard: document.getElementById("featClickGuard"),
        youtubeSkip: document.getElementById("featYoutube"),
        spotifySkip: document.getElementById("featSpotify"),
        mediumUnlock: document.getElementById("featMedium"),
        loginWallBypass: document.getElementById("featLoginWall"),
        downloadGuard: document.getElementById("featDownloads"),
        httpsUpgrade: document.getElementById("featHttps"),
        clipboardGuard: document.getElementById("featClipboard"),
        scriptlets: document.getElementById("featScriptlets"),
        webrtcGuard: document.getElementById("featWebrtc"),
        permissionGuard: document.getElementById("featPermissions"),
        randomUa: document.getElementById("featRandomUa"),
        phishingGuard: document.getElementById("featPhishing"),
        fingerprintGuard: document.getElementById("featFingerprint"),
        listAutoUpdate: document.getElementById("featListUpdate"),
        cookieConsent: document.getElementById("featCookie"),
        popupBlocker: document.getElementById("featPopup"),
        antiAdblock: document.getElementById("featAntiadblock"),
        autoplayBlock: document.getElementById("featAutoplay"),
        strictTracking: document.getElementById("featStrict"),
        minerBlock: document.getElementById("featMiner"),
        malwareWarn: document.getElementById("featMalware"),
        quietMode: document.getElementById("featQuiet"),
        adaptiveLearn: document.getElementById("featAdaptive"),
        trustScore: document.getElementById("featTrust"),
        securityWatch: document.getElementById("featSecWatch"),
        trackerLearn: document.getElementById("featTrackerLearn"),
        privacySignals: document.getElementById("featPrivacySignals"),
      };
      this.profileHover = document.getElementById("profileHover");
      this.profileTrigger = document.getElementById("profileTrigger");
      this.profileMenu = document.getElementById("profileMenu");
      this.profileHint = document.getElementById("profileHint");
      this.uaCard = document.getElementById("uaCard");
      this.uaSummary = document.getElementById("uaSummary");
      this.uaPreview = document.getElementById("uaPreview");
      this.uaRenew = document.getElementById("uaRenew");
      this.openUaOptions = document.getElementById("openUaOptions");
      this.trustCard = document.getElementById("trustCard");
      this.trustBadge = document.getElementById("trustBadge");
      this.trustHost = document.getElementById("trustHost");
      this.trustChecks = document.getElementById("trustChecks");
      this.trustVerdict = document.getElementById("trustVerdict");
      this.trustReasons = document.getElementById("trustReasons");
      this.privacyModeBtn = document.getElementById("privacyModeBtn");
      this.featWebrtcHint = document.getElementById("featWebrtcHint");
      this.featWebrtcRow = document.getElementById("featWebrtcRow");
      this.featListUpdateHint = document.getElementById("featListUpdateHint");
      this.featListUpdateRow = document.getElementById("featListUpdateRow");
      this.privacyModeLabel = document.getElementById("privacyModeLabel");
      this.privacyModeHint = document.getElementById("privacyModeHint");
      this.openSecurity = document.getElementById("openSecurity");
      this.siteModes = document.getElementById("siteModes");
      this.tempAllow = document.getElementById("tempAllow");
      this.tempAllowHint = document.getElementById("tempAllowHint");
      this.tempAllowClear = document.getElementById("tempAllowClear");
      this.siteCosmeticsRow = document.getElementById("siteCosmeticsRow");
      this.siteFeatCosmetics = document.getElementById("siteFeatCosmetics");
      this.siteWatch = document.getElementById("siteWatch");
      this.siteWatchText = document.getElementById("siteWatchText");
      this.pickElement = document.getElementById("pickElement");
      this.customHides = document.getElementById("customHides");
      this.customHideList = document.getElementById("customHideList");
      this.clearCustomHides = document.getElementById("clearCustomHides");
      this.pageHome = document.getElementById("pageHome");
      this.pageLog = document.getElementById("pageLog");
      this.navLog = document.getElementById("navLog");
      this.navBack = document.getElementById("navBack");
      this.logList = document.getElementById("logList");
      this.logEmpty = document.getElementById("logEmpty");
      this.logFilters = document.getElementById("logFilters");
      this.logChart = document.getElementById("logChart");
      this.logTableBody = document.getElementById("logTableBody");
      this.chartCard = document.getElementById("chartCard");
      this.kpiBlocked = document.getElementById("kpiBlocked");
      this.kpiGuards = document.getElementById("kpiGuards");
      this.kpiSecurity = document.getElementById("kpiSecurity");
      this.kpiFeatures = document.getElementById("kpiFeatures");
      this.featStrip = document.getElementById("featStrip");
      this.pageTitle = document.getElementById("pageTitle");
      this.shell = document.querySelector(".shell");
      this._page = "home";
      this._logFilter = "all";
      this._logEntries = [];
      this._logChart = [];
      this._tip = null;
      this.versionText.textContent = `v${chrome.runtime.getManifest().version}`;
    }

    /**
     * @param {"home"|"log"} page
     */
    showPage(page) {
      const isLog = page === "log";
      this._page = isLog ? "log" : "home";
      this.pageHome.hidden = isLog;
      this.pageHome.classList.toggle("is-active", !isLog);
      this.pageLog.hidden = !isLog;
      this.pageLog.classList.toggle("is-active", isLog);
      this.shell?.classList.toggle("is-log-page", isLog);

      this.brandLogo.hidden = isLog;
      this.pageTitle.hidden = !isLog;
      this.navBack.hidden = !isLog;
      this.navLog.hidden = isLog;
      if (this.actionClear) {
        this.actionClear.hidden = false;
        this.actionClear.title = isLog ? "Clear activity log" : "Clear blocked counter";
        this.actionClear.setAttribute(
          "aria-label",
          isLog ? "Clear activity log" : "Clear blocked counter"
        );
      }

      requestAnimationFrame(() => this.fitPopupHeight());
    }

    /**
     * @param {{
     *   entries?: object[],
     *   chart?: Array<{ host: string, count: number }>,
     *   kpis?: Record<string, number>,
     *   features?: Array<{ key: string, on: boolean }>,
     *   enabled?: boolean
     * }} data
     */
    renderDashboard(data) {
      const kpis = data?.kpis || {};
      const features = Array.isArray(data?.features) ? data.features : [];
      this._logEntries = Array.isArray(data?.entries) ? data.entries : [];
      this._logChart = Array.isArray(data?.chart) ? data.chart : [];

      const fmt = (n) => {
        const v = Number(n) || 0;
        if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
        if (v >= 10_000) return `${Math.round(v / 1000)}k`;
        return String(v);
      };

      const blocked = kpis.lifetimeBlocked ?? kpis.blocked ?? 0;
      const guards = (kpis.hijack || 0) + (kpis.soft_nav || 0) + (kpis.login_wall || 0);
      const security =
        (kpis.phishing || 0) + (kpis.download || 0) + (kpis.site_block || 0);

      this.kpiBlocked.textContent = fmt(blocked);
      this.kpiGuards.textContent = fmt(guards);
      this.kpiSecurity.textContent = fmt(security);
      this.kpiFeatures.textContent = `${kpis.featuresOn || 0}/${kpis.featuresTotal || features.length || 0}`;

      const labels = {
        cosmetics: "Cosmetics",
        clickGuard: "Clickjack",
        youtubeSkip: "YouTube",
        spotifySkip: "Spotify",
        mediumUnlock: "Medium",
        loginWallBypass: "Peek",
        downloadGuard: "Downloads",
        httpsUpgrade: "HTTPS",
        clipboardGuard: "Clipboard",
        scriptlets: "Scriptlets",
        webrtcGuard: "WebRTC",
        permissionGuard: "Permissions",
        randomUa: "UA",
        phishingGuard: "Phishing",
        fingerprintGuard: "Fingerprint",
        listAutoUpdate: "Lists",
      };

      this.featStrip.replaceChildren();
      for (const feat of features) {
        const chip = document.createElement("span");
        chip.className = `feat-chip ${feat.on ? "is-on" : "is-off"}`;
        chip.textContent = labels[feat.key] || feat.key;
        chip.title = feat.on ? "On" : "Off";
        this.featStrip.append(chip);
      }

      for (const btn of this.logFilters?.querySelectorAll("[data-filter]") || []) {
        btn.classList.toggle("is-active", btn.getAttribute("data-filter") === this._logFilter);
      }

      this.#renderChart();
      this.#renderLogFeed();
    }

    setLogFilter(filter) {
      this._logFilter = filter || "all";
      for (const btn of this.logFilters?.querySelectorAll("[data-filter]") || []) {
        btn.classList.toggle("is-active", btn.getAttribute("data-filter") === this._logFilter);
      }
      this.#renderLogFeed();
    }

    #ensureTip() {
      if (this._tip) return this._tip;
      const tip = document.createElement("div");
      tip.className = "siem-tip";
      tip.id = "siemTip";
      document.body.appendChild(tip);
      this._tip = tip;
      return tip;
    }

    /**
     * @param {MouseEvent} event
     * @param {object} entry
     */
    #showTip(event, entry) {
      const tip = this.#ensureTip();
      const lines = [];
      lines.push(`<strong>${entry.title || entry.host || entry.kind || "Event"}</strong>`);
      if (entry.host) lines.push(`<span>Host: ${entry.host}</span>`);
      if (entry.initiator) lines.push(`<span>From page: ${entry.initiator}</span>`);
      else lines.push(`<span>From page: (unknown / direct)</span>`);
      if (entry.watched) lines.push(`<span>Watch: whitelisted site — tracker still blocked</span>`);
      if (entry.url) lines.push(`<span>URL: ${entry.url}</span>`);
      if (entry.type) lines.push(`<span>Type: ${entry.type}</span>`);
      if (entry.source) lines.push(`<span>Source: ${entry.source}</span>`);
      else if (entry.ruleset) lines.push(`<span>Ruleset: ${entry.ruleset}</span>`);
      tip.innerHTML = lines.join("");
      tip.classList.add("is-on");
      const pad = 8;
      let x = event.clientX + 12;
      let y = event.clientY + 12;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
      const rect = tip.getBoundingClientRect();
      if (rect.right > window.innerWidth - pad) {
        tip.style.left = `${Math.max(pad, event.clientX - rect.width - 12)}px`;
      }
      if (rect.bottom > window.innerHeight - pad) {
        tip.style.top = `${Math.max(pad, event.clientY - rect.height - 12)}px`;
      }
    }

    #hideTip() {
      this._tip?.classList.remove("is-on");
    }

    #renderChart() {
      if (!this.logChart) return;
      this.logChart.replaceChildren();
      const rows = this._logChart || [];
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "chart-empty";
        empty.textContent = "No network blocks yet";
        this.logChart.append(empty);
        return;
      }
      const max = Math.max(...rows.map((r) => r.count), 1);
      for (const row of rows) {
        const el = document.createElement("div");
        el.className = "chart-row";
        el.title = `${row.host}: ${row.count}`;

        const label = document.createElement("span");
        label.className = "chart-label";
        label.textContent = row.host;

        const track = document.createElement("div");
        track.className = "chart-track";
        const bar = document.createElement("div");
        bar.className = "chart-bar";
        bar.style.width = `${Math.max(4, Math.round((row.count / max) * 100))}%`;
        track.append(bar);

        const count = document.createElement("span");
        count.className = "chart-count";
        count.textContent = String(row.count);

        el.append(label, track, count);
        this.logChart.append(el);
      }
    }

    #renderLogFeed() {
      const groups = {
        all: null,
        network: new Set(["blocked"]),
        guards: new Set(["hijack", "soft_nav", "login_wall"]),
        security: new Set(["phishing", "download", "site_block", "site_rule"]),
        system: new Set([
          "system",
          "feature",
          "ua_renew",
          "list_update",
          "protect_on",
          "protect_off",
        ]),
      };
      const allow = groups[this._logFilter] || null;
      const list = this._logEntries.filter((e) => !allow || allow.has(e.kind));

      if (this.chartCard) {
        this.chartCard.hidden = this._logFilter === "guards" || this._logFilter === "security" || this._logFilter === "system";
      }

      if (!this.logTableBody) return;
      this.logTableBody.replaceChildren();
      this.logEmpty.hidden = list.length > 0;

      const timeAgo = (ts) => {
        const sec = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
        if (sec < 60) return `${sec}s`;
        if (sec < 3600) return `${Math.floor(sec / 60)}m`;
        if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
        return `${Math.floor(sec / 86400)}d`;
      };

      for (const entry of list) {
        const tr = document.createElement("tr");
        const host = entry.host || entry.title || entry.kind || "—";
        const from = entry.initiator || (entry.kind === "blocked" ? "—" : entry.detail || "—");
        const count = entry.kind === "blocked" ? String(entry.count || 1) : "·";

        tr.innerHTML = `
          <td title="">${escapeHtml(String(host).slice(0, 42))}${entry.watched ? ' <span class="watch-tag">watch</span>' : ""}</td>
          <td class="col-from">${escapeHtml(String(from).slice(0, 28))}</td>
          <td class="col-count">${escapeHtml(count)}</td>
          <td class="col-age">${escapeHtml(timeAgo(entry.ts))}</td>
        `;
        tr.addEventListener("mouseenter", (ev) => this.#showTip(ev, entry));
        tr.addEventListener("mousemove", (ev) => this.#showTip(ev, entry));
        tr.addEventListener("mouseleave", () => this.#hideTip());
        this.logTableBody.append(tr);
      }

      requestAnimationFrame(() => this.fitPopupHeight());

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }
    }

    /** @deprecated */
    renderActivityLog(entries) {
      this.renderDashboard({ entries, chart: [], kpis: {}, features: [] });
    }

    /** Chrome action popups grow but often do not shrink — pin height to content. */
    fitPopupHeight() {
      const root = this.html;
      const body = this.body;
      root.style.height = "auto";
      body.style.height = "auto";
      const height = Math.ceil(body.getBoundingClientRect().height);
      root.style.height = `${height}px`;
      body.style.height = `${height}px`;
    }

    /** @param {string} ua */
    #summarizeUa(ua) {
      const raw = String(ua || "");
      if (!raw) return "No agent yet — tap shuffle";
      let browser = "Browser";
      if (/Edg\//i.test(raw)) browser = "Edge";
      else if (/Firefox\//i.test(raw)) browser = "Firefox";
      else if (/Version\/.*Safari/i.test(raw) && !/Chrome|Chromium|Edg/i.test(raw)) browser = "Safari";
      else if (/Chrome\//i.test(raw)) browser = "Chrome";

      let os = "Unknown OS";
      if (/Windows NT/i.test(raw)) os = "Windows";
      else if (/Mac OS X/i.test(raw)) os = "macOS";
      else if (/Android/i.test(raw)) os = "Android";
      else if (/Linux/i.test(raw)) os = "Linux";
      return `${browser} · ${os}`;
    }

    /**
     * @param {{
     *   safety?: number,
     *   host?: string,
     *   checks?: { ok: boolean, label: string }[],
     *   verdict?: string,
     *   reasonLabels?: string[],
     *   disabled?: boolean
     * } | null} report
     */
    renderTrustScore(report) {
      if (!this.trustCard) return;
      if (!report || report.disabled || report.safety == null) {
        this.trustCard.hidden = true;
        return;
      }
      this.trustCard.hidden = false;
      const safety = Number(report.safety) || 0;
      const verdict =
        report.verdict === "safe" || report.verdict === "caution" || report.verdict === "block"
          ? report.verdict
          : safety >= 75
            ? "safe"
            : safety >= 45
              ? "caution"
              : "block";
      if (this.trustBadge) {
        this.trustBadge.textContent = String(safety);
        this.trustBadge.classList.remove("is-good", "is-mid", "is-bad");
        this.trustBadge.classList.add(
          verdict === "safe" ? "is-good" : verdict === "caution" ? "is-mid" : "is-bad"
        );
      }
      if (this.trustHost) this.trustHost.textContent = report.host || "—";
      if (this.trustVerdict) {
        this.trustVerdict.hidden = false;
        this.trustVerdict.className = `trust-verdict is-${verdict}`;
        this.trustVerdict.textContent =
          verdict === "safe" ? "Safe" : verdict === "caution" ? "Caution" : "Block / high risk";
      }
      if (this.trustChecks) {
        this.trustChecks.replaceChildren();
        for (const check of report.checks || []) {
          const li = document.createElement("li");
          li.className = check.ok ? "is-ok" : "is-warn";
          li.textContent = check.label;
          this.trustChecks.append(li);
        }
      }
      if (this.trustReasons) {
        const labels = (report.reasonLabels || []).filter(Boolean);
        this.trustReasons.replaceChildren();
        if (!labels.length) {
          this.trustReasons.hidden = true;
        } else {
          this.trustReasons.hidden = false;
          for (const label of labels.slice(0, 6)) {
            const li = document.createElement("li");
            li.textContent = label;
            this.trustReasons.append(li);
          }
        }
      }
    }

    /**
     * @param {{ conflict?: boolean, applied?: boolean, error?: string } | null} status
     */
    renderWebRtcStatus(status) {
      if (!this.featWebrtcHint) return;
      if (status?.conflict) {
        this.featWebrtcHint.textContent =
          "Skipped — another extension (e.g. Surfshark) owns WebRTC";
        this.featWebrtcRow?.classList.add("is-conflict");
      } else if (status?.error === "not_controllable") {
        this.featWebrtcHint.textContent = "Not controllable in this browser";
        this.featWebrtcRow?.classList.add("is-conflict");
      } else {
        this.featWebrtcHint.textContent = "Reduce IP leak risk";
        this.featWebrtcRow?.classList.remove("is-conflict");
      }
    }

    /**
     * @param {{ ok?: boolean, count?: number, at?: number, error?: string, phishingHosts?: number, nrdHosts?: number } | null} meta
     */
    renderListUpdateStatus(meta) {
      if (!this.featListUpdateHint) return;
      if (!meta || (!meta.at && !meta.error)) {
        this.featListUpdateHint.textContent = "Refresh supplemental blocks daily";
        return;
      }
      if (meta.error === "disabled") {
        this.featListUpdateHint.textContent = "Off — enable to sync live feeds";
        return;
      }
      if (meta.ok === false) {
        this.featListUpdateHint.textContent = `Update failed · ${String(meta.error || "error").slice(0, 40)}`;
        return;
      }
      const when = meta.at ? new Date(meta.at) : null;
      const ago = when
        ? (() => {
            const mins = Math.max(0, Math.round((Date.now() - when.getTime()) / 60000));
            if (mins < 60) return `${mins}m ago`;
            const hrs = Math.round(mins / 60);
            if (hrs < 48) return `${hrs}h ago`;
            return when.toLocaleDateString();
          })()
        : "";
      const hosts = Number(meta.phishingHosts || 0) + Number(meta.nrdHosts || 0);
      const parts = [];
      if (hosts) parts.push(`${hosts} hosts`);
      else if (meta.count) parts.push(`${meta.count} rules`);
      if (ago) parts.push(ago);
      this.featListUpdateHint.textContent = parts.length
        ? parts.join(" · ")
        : "Refresh supplemental blocks daily";
    }

    /** @param {boolean} on */
    renderPrivacyMode(on) {
      if (!this.privacyModeBtn) return;
      this.privacyModeBtn.classList.toggle("is-on", on);
      if (this.privacyModeLabel) {
        this.privacyModeLabel.textContent = on ? "Privacy mode on" : "Make me private";
      }
      if (this.privacyModeHint) {
        this.privacyModeHint.textContent = on
          ? "Tap to turn off (cookies already cleared this session)"
          : "Trackers, fingerprint, HTTPS, clear cookies";
      }
    }

    /**
     * @param {"default"|"allow"|"block"} mode
     * @param {boolean} hasHost
     * @param {string} [host]
     * @param {{ expiresAt?: number, cosmetics?: boolean }} [extra]
     */
    renderSiteMode(mode, hasHost, host = "", extra = {}) {
      if (!this.siteModes) return;
      this.siteModes.classList.toggle("is-disabled", !hasHost);
      for (const btn of this.siteModes.querySelectorAll("[data-mode]")) {
        btn.classList.toggle("is-active", btn.getAttribute("data-mode") === mode);
      }
      const watching = hasHost && mode === "allow";
      if (this.siteWatch) {
        this.siteWatch.hidden = !watching;
        if (watching && this.siteWatchText) {
          this.siteWatchText.textContent = host
            ? `${host} trusted — ads/trackers still blocked & logged live`
            : "Whitelisted — ads/trackers still blocked & logged live";
        }
      }
      if (this.pickElement) {
        this.pickElement.disabled = !hasHost;
      }
      if (this.tempAllow) {
        this.tempAllow.hidden = !hasHost;
      }
      const exp = Number(extra.expiresAt) || 0;
      const tempOn = exp > Date.now();
      if (this.tempAllowClear) this.tempAllowClear.hidden = !tempOn;
      if (this.tempAllowHint) {
        if (tempOn) {
          const mins = Math.max(1, Math.round((exp - Date.now()) / 60000));
          this.tempAllowHint.hidden = false;
          this.tempAllowHint.textContent = `Temporary allow · ${mins}m left`;
        } else {
          this.tempAllowHint.hidden = true;
          this.tempAllowHint.textContent = "";
        }
      }
      if (this.siteCosmeticsRow) {
        this.siteCosmeticsRow.hidden = !hasHost;
      }
      if (this.siteFeatCosmetics && hasHost) {
        this.siteFeatCosmetics.checked = extra.cosmetics !== false;
      }
    }

    /**
     * @param {string[]} selectors
     * @param {boolean} hasHost
     */
    renderCustomHides(selectors, hasHost) {
      if (!this.customHides || !this.customHideList) return;
      const list = Array.isArray(selectors) ? selectors : [];
      const show = hasHost && list.length > 0;
      this.customHides.hidden = !show;
      if (this.clearCustomHides) this.clearCustomHides.hidden = !show;
      this.customHideList.replaceChildren();
      if (!show) return;
      for (const sel of list) {
        const li = document.createElement("li");
        li.className = "custom-hide-item";
        const code = document.createElement("code");
        code.textContent = sel;
        code.title = sel;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.title = "Remove";
        btn.setAttribute("aria-label", "Remove hide rule");
        btn.dataset.selector = sel;
        btn.innerHTML = '<i class="fa-regular fa-trash-can" aria-hidden="true"></i>';
        li.append(code, btn);
        this.customHideList.appendChild(li);
      }
    }

    /**
     * @param {"speed"|"light"|"advanced"} profile
     * @param {boolean} enabled
     */
    renderProfile(profile, enabled) {
      const p = sanitizeProfile(profile);
      if (this.profileHint) {
        this.profileHint.textContent = PROFILE_HINTS[p] || PROFILE_HINTS.light;
      }
      if (this.profileHover) {
        this.profileHover.classList.toggle("is-disabled", !enabled);
      }
      if (this.profileMenu) {
        for (const btn of this.profileMenu.querySelectorAll("[data-profile]")) {
          btn.classList.toggle("is-active", btn.getAttribute("data-profile") === p);
        }
      }
    }

    /** @param {boolean} open */
    setProfileMenuOpen(open) {
      if (!this.profileMenu || !this.profileTrigger) return;
      this.profileMenu.hidden = !open;
      this.profileTrigger.setAttribute("aria-expanded", open ? "true" : "false");
      this.profileHover?.classList.toggle("is-open", open);
    }

    /**
     * @param {{ featureOn?: boolean, uaSettings?: { current?: string } }} data
     * @param {boolean} protectionOn
     */
    renderUa(data, protectionOn) {
      const on = Boolean(protectionOn && data?.featureOn);
      const ua = data?.uaSettings?.current || "";
      this.uaCard.classList.toggle("is-off", !on);
      this.uaSummary.textContent = on ? this.#summarizeUa(ua) : "Spoofing paused";
      this.uaPreview.textContent = ua || "Open settings to generate a User-Agent";
      this.uaRenew.disabled = !on;
    }

    /** @param {boolean} open */
    setFeaturesOpen(open) {
      const isOpen = Boolean(open);
      this.featuresSection.classList.toggle("is-collapsed", !isOpen);
      this.html.classList.toggle("features-collapsed", !isOpen);
      this.featuresToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      try {
        localStorage.setItem("abl.featuresExpanded", isOpen ? "1" : "0");
      } catch {
        // ignore
      }
      requestAnimationFrame(() => this.fitPopupHeight());
    }

    /**
     * @param {PopupStatus} status
     * @param {{ host: string, kind: string }} site
     */
    render(status, site) {
      this.theme.apply(status.theme);
      this.body.classList.toggle("is-disabled", !status.enabled);
      this.toggle.checked = status.enabled;
      this.statusText.textContent = status.enabled ? "Active" : "Paused";
      this.statusText.classList.toggle("is-off", !status.enabled);
      this.blockedCount.textContent = this.#formatCount(status.blockedCount);

      const profile = sanitizeProfile(status.protectionProfile, status.features);
      this.modeText.textContent = status.enabled
        ? PROFILE_LABELS[profile] || "Light"
        : "Off";
      this.renderProfile(profile, status.enabled);

      for (const [key, input] of Object.entries(this.featureInputs)) {
        if (input) input.checked = Boolean(status.features[key]);
      }

      const host = site.host || "Unavailable";
      this.siteHost.textContent = host;
      const paused = Boolean(site.host && status.pausedHosts.includes(site.host));
      this._lastSiteMode = site.siteMode || "default";

      if (site.kind === "internal") {
        this.siteHint.textContent = "Browser page — no site controls";
        this.pauseSite.disabled = true;
        this.pauseSiteLabel.textContent = "Unavailable";
        this.pauseSite.classList.remove("is-paused");
        this.pauseSiteIcon.className = "fa-solid fa-ban";
      } else if (!site.host) {
        this.siteHint.textContent = "Open a website to whitelist or pause";
        this.pauseSite.disabled = true;
        this.pauseSiteLabel.textContent = "Pause here";
        this.pauseSiteIcon.className = "fa-solid fa-pause";
      } else {
        this.pauseSite.disabled = false;
        this.pauseSite.classList.toggle("is-paused", paused);
        this.pauseSiteLabel.textContent = paused ? "Resume site" : "Pause here";
        this.pauseSiteIcon.className = paused ? "fa-solid fa-play" : "fa-solid fa-pause";
        if (paused) {
          this.siteHint.textContent = "Protection fully paused on this site";
        } else if (site.siteMode === "allow") {
          this.siteHint.textContent = "Whitelisted — monitoring stays on";
        } else if (site.siteMode === "block") {
          this.siteHint.textContent = "This site is blocked by your rule";
        } else if (site.insecure && status.features.httpsUpgrade) {
          this.siteHint.textContent = "Not secure — page is still on HTTP";
        } else {
          const kindHint = {
            youtube: "YouTube tools available on this page",
            medium: "Medium reader available on this page",
            media: "Streaming-safe mode on this page",
            site: "Protected on this site",
          };
          this.siteHint.textContent = kindHint[site.kind] || kindHint.site;
        }
      }
    }

    #formatCount(n) {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 10_000) return `${Math.round(n / 1000)}k`;
      return String(n);
    }
  }

  class PopupController {
    constructor() {
      this._client = new BackgroundClient();
      this._view = new PopupView();
      this._site = { host: "", kind: "unknown" };
      this._theme = "light";
    }

    async refresh() {
      const status = await this._client.getStatus();
      this._theme = status.theme;
      let tempExpiresAt = 0;
      let siteCosmetics = true;
      try {
        if (this._site.host) {
          const rule = await chrome.runtime.sendMessage({
            type: "getSiteRule",
            host: this._site.host,
          });
          this._site.siteMode = rule?.mode || "default";
          const temp = await chrome.runtime.sendMessage({
            type: "getTempAllow",
            host: this._site.host,
          });
          tempExpiresAt = Number(temp?.expiresAt) || 0;
          if (tempExpiresAt > Date.now()) this._site.siteMode = "allow";
          const ov = await chrome.runtime.sendMessage({
            type: "getSiteFeatureOverride",
            host: this._site.host,
          });
          siteCosmetics =
            ov?.features?.cosmetics !== undefined
              ? Boolean(ov.features.cosmetics)
              : status.features.cosmetics !== false;
        } else {
          this._site.siteMode = "default";
        }
      } catch {
        this._site.siteMode = "default";
      }
      this._view.render(status, this._site);
      this._view.renderPrivacyMode(Boolean(status.features.privacyMode));
      this._view.renderSiteMode(
        this._site.siteMode || "default",
        Boolean(this._site.host),
        this._site.host || "",
        { expiresAt: tempExpiresAt, cosmetics: siteCosmetics }
      );

      try {
        if (this._site.host && status.features.trustScore !== false && status.enabled) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          let thirdPartyScripts = 0;
          try {
            if (tab?.id) {
              const hints = await chrome.tabs.sendMessage(tab.id, {
                type: "getPageTrustHints",
              });
              thirdPartyScripts = Number(hints?.thirdPartyScripts) || 0;
            }
          } catch {
            // content script missing
          }
          const trust = await chrome.runtime.sendMessage({
            type: "getTrustScore",
            url: tab?.url || `https://${this._site.host}/`,
            thirdPartyScripts,
          });
          this._view.renderTrustScore(trust);
        } else {
          this._view.renderTrustScore(null);
        }
      } catch {
        this._view.renderTrustScore(null);
      }
      try {
        const webrtcStatus = await chrome.runtime.sendMessage({ type: "getWebRtcStatus" });
        this._view.renderWebRtcStatus(webrtcStatus);
      } catch {
        this._view.renderWebRtcStatus(null);
      }
      try {
        const listMeta = await chrome.runtime.sendMessage({ type: "getListUpdateMeta" });
        this._view.renderListUpdateStatus(listMeta);
      } catch {
        this._view.renderListUpdateStatus(null);
      }
      try {
        if (this._site.host) {
          const custom = await chrome.runtime.sendMessage({
            type: "listCustomCosmetics",
            host: this._site.host,
          });
          this._view.renderCustomHides(custom?.selectors || [], true);
        } else {
          this._view.renderCustomHides([], false);
        }
      } catch {
        this._view.renderCustomHides([], false);
      }
      try {
        const ua = await chrome.runtime.sendMessage({ type: "getUaStatus" });
        this._view.renderUa(ua, status.enabled);
      } catch {
        this._view.renderUa({ featureOn: status.features.randomUa, uaSettings: {} }, status.enabled);
      }
      requestAnimationFrame(() => this._view.fitPopupHeight());
      return status;
    }

    bind() {
      this._view.toggle.addEventListener("change", async () => {
        await this._client.setEnabled(this._view.toggle.checked);
        await this.refresh();
      });

      this._view.actionClear?.addEventListener("click", async () => {
        if (this._view._page === "log") {
          await this._client.clearActivityLog();
          await this.refreshLog();
        } else {
          await this._client.resetCount();
          await this.refresh();
        }
      });

      this._view.pauseSite.addEventListener("click", async () => {
        if (!this._site.host) return;
        const status = await this._client.getStatus();
        const paused = status.pausedHosts.includes(this._site.host);
        await this._client.setSitePaused(this._site.host, !paused);
        await this.refresh();
      });

      this._view.themeToggle.addEventListener("click", async () => {
        const next = this._view.theme.toggle(this._theme);
        this._theme = next;
        this._view.theme.apply(next);
        await this._client.setTheme(next);
      });

      const closeProfileMenu = () => this._view.setProfileMenuOpen(false);
      let profileCloseTimer = 0;
      const armCloseProfileMenu = () => {
        clearTimeout(profileCloseTimer);
        profileCloseTimer = window.setTimeout(closeProfileMenu, 180);
      };
      const cancelCloseProfileMenu = () => {
        clearTimeout(profileCloseTimer);
        profileCloseTimer = 0;
      };

      this._view.profileTrigger?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this._view.profileMenu) return;
        cancelCloseProfileMenu();
        this._view.setProfileMenuOpen(this._view.profileMenu.hidden);
      });
      this._view.profileHover?.addEventListener("mouseenter", () => {
        cancelCloseProfileMenu();
        this._view.setProfileMenuOpen(true);
      });
      this._view.profileHover?.addEventListener("mouseleave", () => {
        armCloseProfileMenu();
      });
      this._view.profileMenu?.addEventListener("mouseenter", () => {
        cancelCloseProfileMenu();
        this._view.setProfileMenuOpen(true);
      });
      this._view.profileMenu?.addEventListener("click", async (event) => {
        const btn = event.target.closest?.("[data-profile]");
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        const profile = btn.getAttribute("data-profile") || "light";
        cancelCloseProfileMenu();
        closeProfileMenu();
        await chrome.runtime.sendMessage({ type: "setProtectionProfile", profile });
        await this.refresh();
      });
      document.addEventListener("click", (event) => {
        if (!this._view.profileHover?.contains(event.target)) {
          cancelCloseProfileMenu();
          closeProfileMenu();
        }
      });

      this._view.featuresToggle.addEventListener("click", async () => {
        const open = this._view.featuresSection.classList.contains("is-collapsed");
        this._view.setFeaturesOpen(open);
        await chrome.storage.local.set({ featuresExpanded: open });
      });

      for (const [key, input] of Object.entries(this._view.featureInputs)) {
        input.addEventListener("change", async () => {
          await this._client.setFeature(key, input.checked);
          await this.refresh();
        });
      }

      this._view.openUaOptions?.addEventListener("click", () => {
        chrome.runtime.openOptionsPage();
      });

      this._view.uaRenew?.addEventListener("click", async () => {
        this._view.uaRenew.classList.add("is-spinning");
        try {
          await chrome.runtime.sendMessage({ type: "renewUserAgent" });
          await this.refresh();
        } finally {
          this._view.uaRenew.classList.remove("is-spinning");
        }
      });

      this._view.privacyModeBtn?.addEventListener("click", async () => {
        const status = await this._client.getStatus();
        const next = !status.features.privacyMode;
        await chrome.runtime.sendMessage({
          type: "setPrivacyMode",
          on: next,
          clearCookies: true,
        });
        await this.refresh();
      });

      this._view.openSecurity?.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: "openSecurityAssistant" });
        window.close();
      });

      this._view.siteModes?.addEventListener("click", async (event) => {
        const btn = event.target.closest?.("[data-mode]");
        if (!btn || !this._site.host) return;
        const mode = btn.getAttribute("data-mode") || "default";
        await chrome.runtime.sendMessage({
          type: "setSiteRule",
          host: this._site.host,
          mode,
        });
        await this.refresh();
      });

      this._view.tempAllow?.addEventListener("click", async (event) => {
        const btn = event.target.closest?.("[data-mins]");
        if (!btn || !this._site.host) return;
        const minutes = Number(btn.getAttribute("data-mins")) || 0;
        await chrome.runtime.sendMessage({
          type: "setTempAllow",
          host: this._site.host,
          minutes,
        });
        await this.refresh();
      });

      this._view.siteFeatCosmetics?.addEventListener("change", async () => {
        if (!this._site.host) return;
        await chrome.runtime.sendMessage({
          type: "setSiteFeatureOverride",
          host: this._site.host,
          key: "cosmetics",
          value: this._view.siteFeatCosmetics.checked,
        });
        await this.refresh();
      });

      this._view.pickElement?.addEventListener("click", async () => {
        if (!this._site.host) return;
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) return;
          await chrome.tabs.sendMessage(tab.id, { type: "startElementPicker" });
          window.close();
        } catch {
          // Content script may be missing on chrome:// pages
        }
      });

      this._view.customHideList?.addEventListener("click", async (event) => {
        const btn = event.target.closest?.("button[data-selector]");
        if (!btn || !this._site.host) return;
        const selector = btn.getAttribute("data-selector") || "";
        await chrome.runtime.sendMessage({
          type: "removeCustomCosmetic",
          host: this._site.host,
          selector,
        });
        await this.refresh();
      });

      this._view.clearCustomHides?.addEventListener("click", async () => {
        if (!this._site.host) return;
        await chrome.runtime.sendMessage({
          type: "clearCustomCosmetics",
          host: this._site.host,
        });
        await this.refresh();
      });

      this._view.navLog?.addEventListener("click", async () => {
        this._view.showPage("log");
        await this.refreshLog();
        this.#startLogPoll();
      });

      this._view.navBack?.addEventListener("click", () => {
        this.#stopLogPoll();
        this._view.showPage("home");
      });

      this._view.logFilters?.addEventListener("click", (event) => {
        const btn = event.target.closest?.("[data-filter]");
        if (!btn) return;
        this._view.setLogFilter(btn.getAttribute("data-filter") || "all");
      });
    }

    async refreshLog() {
      try {
        const data = await this._client.getActivityLog();
        this._view.renderDashboard(data || {});
      } catch {
        this._view.renderDashboard({ entries: [], kpis: {}, features: [] });
      }
    }

    #startLogPoll() {
      this.#stopLogPoll();
      this._logPoll = setInterval(() => {
        if (this._view._page === "log") this.refreshLog();
      }, 1500);
    }

    #stopLogPoll() {
      if (this._logPoll) {
        clearInterval(this._logPoll);
        this._logPoll = 0;
      }
    }

    async start() {
      this.bind();
      let expanded = true;
      try {
        const cached = localStorage.getItem("abl.featuresExpanded");
        if (cached === "0") expanded = false;
        else if (cached === "1") expanded = true;
      } catch {
        // ignore
      }
      const stored = await chrome.storage.local.get({ featuresExpanded: expanded });
      expanded = stored.featuresExpanded !== false;
      this._view.setFeaturesOpen(expanded);

      this._site = await ActiveTabInfo.resolve();
      this._view.showPage("home");
      await this.refresh();
      // Warm the activity dashboard so first open isn't empty.
      try {
        await chrome.runtime.sendMessage({ type: "getActivityLog" });
      } catch {
        // ignore
      }
      this._view.fitPopupHeight();
    }
  }

  new PopupController().start();
})();
