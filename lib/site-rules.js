(() => {
  "use strict";

  const { HostKey } = globalThis.AblDs;

  /** @typedef {"allow" | "block" | "default"} SiteMode */

  /**
   * Per-site policy book — Map + longest-suffix resolution.
   */
  class SiteRuleBook {
    static ALLOW_ID = 9101;
    static BLOCK_ID_BASE = 9200;
    static MAX_BLOCKS = 80;

    constructor() {
      /** @type {Map<string, SiteMode>} */
      this._rules = new Map();
    }

    /**
     * @param {Record<string, SiteMode> | null | undefined} raw
     */
    load(raw) {
      this._rules.clear();
      if (!raw || typeof raw !== "object") return;
      for (const [host, mode] of Object.entries(raw)) {
        const key = HostKey.normalize(host);
        if (!key) continue;
        if (mode === "allow" || mode === "block") this._rules.set(key, mode);
      }
    }

    /** @returns {Record<string, SiteMode>} */
    toJSON() {
      const out = {};
      for (const [k, v] of this._rules) out[k] = v;
      return out;
    }

    /**
     * Longest-suffix match.
     * @param {string} host
     * @returns {SiteMode}
     */
    resolve(host) {
      for (const suffix of HostKey.suffixes(host)) {
        const mode = this._rules.get(suffix);
        if (mode) return mode;
      }
      return "default";
    }

    /**
     * @param {string} host
     * @param {SiteMode} mode
     */
    set(host, mode) {
      const key = HostKey.normalize(host);
      if (!key) return;
      if (mode === "default") this._rules.delete(key);
      else this._rules.set(key, mode);
    }

    get size() {
      return this._rules.size;
    }

    entries() {
      return this._rules.entries();
    }
  }

  /**
   * Sync SiteRuleBook → DNR dynamic allow/block rules.
   */
  class SiteRuleDnrSync {
    static #RESOURCE_TYPES = [
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
    ];

    /**
     * @param {SiteRuleBook} book
     */
    async apply(book) {
      const removeRuleIds = [SiteRuleBook.ALLOW_ID];
      for (let i = 0; i < SiteRuleBook.MAX_BLOCKS; i += 1) {
        removeRuleIds.push(SiteRuleBook.BLOCK_ID_BASE + i);
      }

      const addRules = [];
      const allows = [];
      const blocks = [];
      for (const [host, mode] of book.entries()) {
        if (mode === "allow") allows.push(host);
        else if (mode === "block") blocks.push(host);
      }

      if (allows.length) {
        // Trust first-party navigation only — do NOT allowAllRequests.
        // Third-party ads/trackers on the page stay blocked and keep logging.
        addRules.push({
          id: SiteRuleBook.ALLOW_ID,
          priority: 10000,
          action: { type: "allow" },
          condition: {
            requestDomains: allows.slice(0, 100),
            resourceTypes: ["main_frame", "sub_frame"],
          },
        });
      }

      blocks.slice(0, SiteRuleBook.MAX_BLOCKS).forEach((host, index) => {
        addRules.push({
          id: SiteRuleBook.BLOCK_ID_BASE + index,
          priority: 9000,
          action: { type: "block" },
          condition: {
            requestDomains: [host],
            resourceTypes: SiteRuleDnrSync.#RESOURCE_TYPES,
          },
        });
      });

      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    }
  }

  /**
   * Persistence facade for site rules.
   */
  class SiteRuleStore {
    constructor() {
      this.book = new SiteRuleBook();
      this._dnr = new SiteRuleDnrSync();
    }

    async hydrate() {
      const { siteRules = {} } = await chrome.storage.local.get({ siteRules: {} });
      this.book.load(siteRules);
      await this._dnr.apply(this.book);
      return this.book;
    }

    async persist() {
      await chrome.storage.local.set({ siteRules: this.book.toJSON() });
      await this._dnr.apply(this.book);
    }

    /**
     * @param {string} host
     * @param {SiteMode} mode
     */
    async setMode(host, mode) {
      this.book.set(host, mode);
      await this.persist();
      return this.book.resolve(host);
    }

    /** @param {string} host */
    modeFor(host) {
      return this.book.resolve(host);
    }
  }

  globalThis.AblSiteRules = { SiteRuleBook, SiteRuleDnrSync, SiteRuleStore };
})();
