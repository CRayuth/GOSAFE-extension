(() => {
  "use strict";

  const { HostKey } = globalThis.AblDs;

  /**
   * Privacy Badger–style heuristic: third parties seen on many first-party sites → block.
   * Inspired by EFF Privacy Badger (learn-to-block), not a fork.
   */
  class HeuristicTrackerLearner {
    static KEY = "trackerLearn";
    static RULE_ID = 9500;
    static PROMOTE_AT = 3;
    static MAX_TRACKERS = 80;
    static MAX_SEEN = 400;

    static #SAFE = new Set([
      "googleapis.com",
      "gstatic.com",
      "google.com",
      "gvt1.com",
      "youtube.com",
      "ytimg.com",
      "ggpht.com",
      "cloudflare.com",
      "cloudflareinsights.com",
      "jsdelivr.net",
      "cdnjs.cloudflare.com",
      "unpkg.com",
      "jquery.com",
      "github.com",
      "githubusercontent.com",
      "apple.com",
      "icloud.com",
      "microsoft.com",
      "live.com",
      "office.com",
      "amazon.com",
      "amazonaws.com",
      "cloudfront.net",
      "akamaihd.net",
      "akamaized.net",
      "fastly.net",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "typekit.net",
      "stripe.com",
      "paypal.com",
      "recaptcha.net",
      "gstatic.cn",
    ]);

    static #TRACKY_TYPES = new Set([
      "script",
      "image",
      "xmlhttprequest",
      "ping",
      "sub_frame",
      "websocket",
      "other",
      "font",
      "media",
    ]);

    constructor() {
      /** @type {{ seen: Record<string, string[]>, blocked: string[] }} */
      this._data = { seen: {}, blocked: [] };
      this._ready = false;
      this._dirty = false;
      this._flushTimer = 0;
    }

    async hydrate() {
      const { trackerLearn = null } = await chrome.storage.local.get({ trackerLearn: null });
      if (trackerLearn && typeof trackerLearn === "object") {
        this._data = {
          seen: trackerLearn.seen && typeof trackerLearn.seen === "object" ? trackerLearn.seen : {},
          blocked: Array.isArray(trackerLearn.blocked) ? trackerLearn.blocked.slice(0, HeuristicTrackerLearner.MAX_TRACKERS) : [],
        };
      }
      this._ready = true;
    }

    async persist() {
      await chrome.storage.local.set({ trackerLearn: this._data });
      this._dirty = false;
    }

    #schedulePersist() {
      this._dirty = true;
      clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => {
        this.persist().catch(() => {});
      }, 1500);
    }

    static #apex(host) {
      const h = HostKey.normalize(host);
      const parts = h.split(".").filter(Boolean);
      if (parts.length <= 2) return h;
      // naive eTLD+1
      return parts.slice(-2).join(".");
    }

    static isSafe(trackerHost) {
      const apex = HeuristicTrackerLearner.#apex(trackerHost);
      if (!apex) return true;
      if (HeuristicTrackerLearner.#SAFE.has(apex)) return true;
      for (const s of HeuristicTrackerLearner.#SAFE) {
        if (apex === s || apex.endsWith(`.${s}`)) return true;
      }
      return false;
    }

    /**
     * @param {{ url?: string, initiator?: string, type?: string, tabId?: number }} details
     */
    async observe(details) {
      if (!this._ready) await this.hydrate();
      if (details.tabId != null && details.tabId < 0) return null;
      const type = String(details.type || "");
      if (type === "main_frame" || !HeuristicTrackerLearner.#TRACKY_TYPES.has(type)) {
        return null;
      }

      const tracker = HostKey.fromUrl(details.url || "");
      const firstParty = HostKey.fromUrl(details.initiator || "");
      if (!tracker || !firstParty) return null;
      if (tracker === firstParty) return null;
      // same site suffix
      if (tracker.endsWith(`.${firstParty}`) || firstParty.endsWith(`.${tracker}`)) return null;
      if (HeuristicTrackerLearner.#apex(tracker) === HeuristicTrackerLearner.#apex(firstParty)) {
        return null;
      }
      if (HeuristicTrackerLearner.isSafe(tracker)) return null;
      if (this._data.blocked.includes(tracker) || this._data.blocked.includes(HeuristicTrackerLearner.#apex(tracker))) {
        return null;
      }

      const key = HeuristicTrackerLearner.#apex(tracker);
      const sites = Array.isArray(this._data.seen[key]) ? this._data.seen[key].slice() : [];
      const fp = HeuristicTrackerLearner.#apex(firstParty);
      if (!sites.includes(fp)) {
        sites.push(fp);
        if (sites.length > 30) sites.splice(0, sites.length - 30);
        this._data.seen[key] = sites;
      }

      // Cap seen map
      const keys = Object.keys(this._data.seen);
      if (keys.length > HeuristicTrackerLearner.MAX_SEEN) {
        keys.slice(0, keys.length - HeuristicTrackerLearner.MAX_SEEN).forEach((k) => {
          delete this._data.seen[k];
        });
      }

      let promoted = false;
      if (sites.length >= HeuristicTrackerLearner.PROMOTE_AT) {
        if (!this._data.blocked.includes(key)) {
          this._data.blocked.push(key);
          if (this._data.blocked.length > HeuristicTrackerLearner.MAX_TRACKERS) {
            this._data.blocked = this._data.blocked.slice(-HeuristicTrackerLearner.MAX_TRACKERS);
          }
          promoted = true;
        }
        delete this._data.seen[key];
      }

      this.#schedulePersist();
      if (promoted) await this.applyRules(true);
      return { tracker: key, count: sites.length, promoted };
    }

    /**
     * @param {boolean} enabled
     */
    async applyRules(enabled) {
      if (!this._ready) await this.hydrate();
      const domains = enabled ? this._data.blocked.slice(0, HeuristicTrackerLearner.MAX_TRACKERS) : [];
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [HeuristicTrackerLearner.RULE_ID],
        addRules: domains.length
          ? [
              {
                id: HeuristicTrackerLearner.RULE_ID,
                priority: 75,
                action: { type: "block" },
                condition: {
                  requestDomains: domains,
                  domainType: "thirdParty",
                  resourceTypes: [
                    "script",
                    "image",
                    "xmlhttprequest",
                    "ping",
                    "sub_frame",
                    "websocket",
                    "other",
                  ],
                },
              },
            ]
          : [],
      });
    }

    async status() {
      if (!this._ready) await this.hydrate();
      return {
        watching: Object.keys(this._data.seen).length,
        blocked: this._data.blocked.length,
        list: this._data.blocked.slice(),
      };
    }

    async clear() {
      this._data = { seen: {}, blocked: [] };
      await this.persist();
      await this.applyRules(false);
      return { ok: true };
    }

    async unblock(host) {
      if (!this._ready) await this.hydrate();
      const key = HeuristicTrackerLearner.#apex(host);
      this._data.blocked = this._data.blocked.filter((h) => h !== key && h !== HostKey.normalize(host));
      await this.persist();
      await this.applyRules(true);
      return { ok: true };
    }
  }

  globalThis.AblTrackerLearn = { HeuristicTrackerLearner };
})();
