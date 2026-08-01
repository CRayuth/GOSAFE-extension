(() => {
  "use strict";

  /**
   * Circular / ring buffer (newest at front).
   */
  class ActivityRingBuffer {
    /**
     * @param {number} capacity
     * @param {object[]} [seed]
     */
    constructor(capacity, seed = []) {
      this._cap = Math.max(1, capacity);
      /** @type {object[]} */
      this._items = Array.isArray(seed) ? seed.slice(0, this._cap) : [];
    }

    /** @param {object} entry */
    pushFront(entry) {
      this._items.unshift(entry);
      if (this._items.length > this._cap) {
        this._items.length = this._cap;
      }
    }

    /**
     * Merge into newest matching entry if within windowMs.
     * @param {(item: object) => boolean} match
     * @param {(item: object) => void} update
     * @param {number} windowMs
     * @returns {boolean}
     */
    mergeRecent(match, update, windowMs) {
      const head = this._items[0];
      if (!head || !match(head)) return false;
      if (Date.now() - Number(head.ts || 0) > windowMs) return false;
      update(head);
      head.ts = Date.now();
      return true;
    }

    toArray() {
      return this._items.slice();
    }

    clear() {
      this._items = [];
    }

    get size() {
      return this._items.length;
    }
  }

  /** @typedef {{ id: string, ts: number, kind: string, title: string, detail?: string, host?: string, count?: number, ruleset?: string, source?: string, initiator?: string, url?: string, type?: string, ruleId?: number, action?: string }} ActivityEntry */

  /**
   * Persistent activity log + KPI counters (SIEM-lite for the popup).
   */
  class ActivityLogStore {
    static KEY = "activityLog";
    static KPI_KEY = "activityKpis";
    static MAX = 200;
    static FLUSH_MS = 800;

    static #KINDS = Object.freeze({
      phishing: "phishing",
      siteBlock: "site_block",
      download: "download",
      uaRenew: "ua_renew",
      listUpdate: "list_update",
      hijack: "hijack",
      softNav: "soft_nav",
      loginWall: "login_wall",
      protectOn: "protect_on",
      protectOff: "protect_off",
      blocked: "blocked",
      feature: "feature",
      siteRule: "site_rule",
      system: "system",
      dns: "dns",
    });

    static #EMPTY_KPIS = () => ({
      blocked: 0,
      hijack: 0,
      soft_nav: 0,
      login_wall: 0,
      phishing: 0,
      download: 0,
      ua_renew: 0,
      list_update: 0,
      site_block: 0,
      feature: 0,
      site_rule: 0,
      protect_on: 0,
      protect_off: 0,
      system: 0,
      dns: 0,
      startedAt: Date.now(),
    });

    static get kinds() {
      return ActivityLogStore.#KINDS;
    }

    constructor() {
      /** @type {ActivityRingBuffer | null} */
      this._buf = null;
      /** @type {ReturnType<typeof ActivityLogStore.#EMPTY_KPIS> | null} */
      this._kpis = null;
      this._dirty = false;
      this._flushTimer = 0;
      this._writing = false;
    }

    /**
     * @param {Partial<ActivityEntry> & { kind: string, title: string }} partial
     * @returns {ActivityEntry}
     */
    static normalize(partial) {
      const kind = String(partial.kind || "event");
      return {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        ts: Number(partial.ts) || Date.now(),
        kind,
        title: String(partial.title || kind).slice(0, 100),
        detail: partial.detail ? String(partial.detail).slice(0, 200) : "",
        host: partial.host ? String(partial.host).slice(0, 100) : "",
        count: Math.max(1, Number(partial.count) || 1),
        ruleset: partial.ruleset ? String(partial.ruleset).slice(0, 40) : "",
        source: partial.source ? String(partial.source).slice(0, 48) : "",
        initiator: partial.initiator ? String(partial.initiator).slice(0, 100) : "",
        url: partial.url ? String(partial.url).slice(0, 220) : "",
        type: partial.type ? String(partial.type).slice(0, 32) : "",
        ruleId: Number(partial.ruleId) || 0,
        action: partial.action ? String(partial.action).slice(0, 16) : "",
        tip: partial.tip ? String(partial.tip).slice(0, 280) : "",
      };
    }

    static hostFromUrl(url) {
      try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        return "";
      }
    }

    async #hydrate() {
      if (this._buf && this._kpis) return;
      const data = await chrome.storage.local.get({
        [ActivityLogStore.KEY]: [],
        [ActivityLogStore.KPI_KEY]: null,
      });
      const raw = Array.isArray(data[ActivityLogStore.KEY]) ? data[ActivityLogStore.KEY] : [];
      this._buf = new ActivityRingBuffer(ActivityLogStore.MAX, raw);
      const k = data[ActivityLogStore.KPI_KEY];
      this._kpis =
        k && typeof k === "object"
          ? { ...ActivityLogStore.#EMPTY_KPIS(), ...k }
          : ActivityLogStore.#EMPTY_KPIS();
    }

    #scheduleFlush() {
      this._dirty = true;
      if (this._flushTimer) return;
      this._flushTimer = setTimeout(() => {
        this._flushTimer = 0;
        this.#flush().catch(() => {});
      }, ActivityLogStore.FLUSH_MS);
    }

    async #flush() {
      if (!this._dirty || this._writing) return;
      await this.#hydrate();
      this._writing = true;
      this._dirty = false;
      try {
        await chrome.storage.local.set({
          [ActivityLogStore.KEY]: this._buf.toArray(),
          [ActivityLogStore.KPI_KEY]: this._kpis,
        });
      } finally {
        this._writing = false;
        if (this._dirty) this.#scheduleFlush();
      }
    }

    /**
     * @param {string} kind
     */
    #bumpKpi(kind) {
      if (!this._kpis) return;
      const key = kind in this._kpis ? kind : null;
      if (key) this._kpis[key] = (Number(this._kpis[key]) || 0) + 1;
    }

    /**
     * @param {Partial<ActivityEntry> & { kind: string, title: string }} partial
     */
    async append(partial) {
      await this.#hydrate();
      const entry = ActivityLogStore.normalize(partial);
      this._buf.pushFront(entry);
      this.#bumpKpi(entry.kind);
      this.#scheduleFlush();
      return entry;
    }

    /**
     * Attach a silent safety tip to an existing log entry.
     * @param {string} id
     * @param {string} tip
     */
    async setTip(id, tip) {
      await this.#hydrate();
      const text = String(tip || "").trim().slice(0, 280);
      if (!id || !text) return false;
      const items = this._buf.toArray();
      const hit = items.find((e) => e.id === id);
      if (!hit) return false;
      hit.tip = text;
      this.#scheduleFlush();
      return true;
    }

    /**
     * Network / DNR filter hit — coalesce bursts per host + ruleset.
     * @param {{ url?: string, initiator?: string, rulesetId?: string, source?: string, type?: string, ruleId?: number, action?: string }} info
     */
    async recordBlock(info = {}) {
      await this.#hydrate();
      const host =
        ActivityLogStore.hostFromUrl(info.url) ||
        ActivityLogStore.hostFromUrl(info.initiator) ||
        "unknown";
      const initiator = ActivityLogStore.hostFromUrl(info.initiator) || "";
      const ruleset = String(info.rulesetId || "rules");
      const source = String(info.source || ruleset).slice(0, 48);
      const url = String(info.url || "").slice(0, 220);
      const type = String(info.type || "");
      const ruleId = Number(info.ruleId) || 0;
      const action = String(info.action || "block").slice(0, 16);
      const verb = action === "redirect" ? "Redirected" : "Blocked";
      const detailBase = initiator ? `from ${initiator}` : source;
      const merged = this._buf.mergeRecent(
        (item) =>
          item.kind === "blocked" &&
          item.host === host &&
          (item.initiator || "") === initiator &&
          (item.ruleset || "") === ruleset &&
          (Number(item.ruleId) || 0) === ruleId,
        (item) => {
          item.count = (Number(item.count) || 1) + 1;
          item.title = `${verb} ${host} ×${item.count}`;
          item.detail = detailBase;
          item.ruleset = ruleset;
          item.source = source;
          item.initiator = initiator;
          item.url = url || item.url;
          item.type = type || item.type;
          item.ruleId = ruleId;
          item.action = action;
        },
        4000
      );
      if (!merged) {
        this._buf.pushFront(
          ActivityLogStore.normalize({
            kind: "blocked",
            title: `${verb} ${host}`,
            detail: detailBase,
            host,
            ruleset,
            source,
            initiator,
            url,
            type,
            ruleId,
            action,
            count: 1,
          })
        );
      }
      this.#bumpKpi("blocked");
      this.#scheduleFlush();
    }

    /** Drop false-positive “blocks” that were actually allowlist matches. */
    async #purgeAllowlistNoise() {
      await this.#hydrate();
      const before = this._buf.size;
      const kept = this._buf.toArray().filter((e) => {
        if (e.kind !== "blocked") return true;
        const rs = String(e.ruleset || e.detail || "");
        return rs !== "allowlist" && !/\ballowlist\b/i.test(rs);
      });
      if (kept.length === before) return;
      this._buf = new ActivityRingBuffer(ActivityLogStore.MAX, kept);
      const removed = before - kept.length;
      if (removed > 0 && this._kpis) {
        this._kpis.blocked = Math.max(0, (Number(this._kpis.blocked) || 0) - removed);
      }
      this.#scheduleFlush();
    }

    /**
     * Aggregate top blocked hosts for the chart.
     * @param {ActivityEntry[]} entries
     */
    static chartFrom(entries) {
      /** @type {Map<string, number>} */
      const map = new Map();
      for (const e of entries) {
        if (e.kind !== "blocked" || !e.host) continue;
        map.set(e.host, (map.get(e.host) || 0) + (Number(e.count) || 1));
      }
      return [...map.entries()]
        .map(([host, count]) => ({ host, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    }

    async ensureStarted() {
      await this.#hydrate();
      if (this._buf.size > 0) return;
      await this.append({
        kind: "system",
        title: "Monitoring online",
        detail: "Network blocks and guards stream here",
      });
    }

    async list() {
      await this.#hydrate();
      return this._buf.toArray();
    }

    async kpis() {
      await this.#hydrate();
      return { ...this._kpis };
    }

    /**
     * Full dashboard payload for the popup SIEM view.
     * @param {{ blockedCount?: number, features?: Record<string, boolean>, enabled?: boolean }} status
     */
    /**
     * Full dashboard payload for the popup SIEM view.
     * @param {{ blockedCount?: number, features?: Record<string, boolean>, enabled?: boolean, watchHosts?: string[] }} status
     */
    async dashboard(status = {}) {
      await this.#hydrate();
      await this.#purgeAllowlistNoise();
      await this.ensureStarted();
      const features = status.features || {};
      const featureRows = Object.entries(features).map(([key, on]) => ({
        key,
        on: Boolean(on),
      }));
      const kpis = { ...this._kpis };
      if (typeof status.blockedCount === "number") {
        kpis.lifetimeBlocked = status.blockedCount;
      }
      kpis.featuresOn = featureRows.filter((f) => f.on).length;
      kpis.featuresTotal = featureRows.length;
      const watchSet = new Set(
        (Array.isArray(status.watchHosts) ? status.watchHosts : []).map((h) =>
          String(h || "")
            .replace(/^www\./, "")
            .toLowerCase()
        )
      );
      const entries = this._buf.toArray().map((e) => {
        const init = String(e.initiator || "")
          .replace(/^www\./, "")
          .toLowerCase();
        const watched = Boolean(init && [...watchSet].some((w) => init === w || init.endsWith(`.${w}`)));
        return watched ? { ...e, watched: true } : e;
      });
      return {
        entries,
        chart: ActivityLogStore.chartFrom(entries),
        kpis,
        features: featureRows,
        watchHosts: [...watchSet],
        enabled: status.enabled !== false,
      };
    }

    async clear() {
      await this.#hydrate();
      this._buf.clear();
      this._kpis = ActivityLogStore.#EMPTY_KPIS();
      this._dirty = true;
      await this.#flush();
      await this.append({
        kind: "system",
        title: "Log cleared",
        detail: "Counters reset — monitoring continues",
      });
    }
  }

  globalThis.AblActivityLog = { ActivityRingBuffer, ActivityLogStore };
})();
