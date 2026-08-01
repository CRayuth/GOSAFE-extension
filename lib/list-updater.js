(() => {
  "use strict";

  const { HostKey } = globalThis.AblDs;

  /**
   * Fetch → parse → unique domain set → DNR dynamic rules.
   * Algorithm: linear failover over mirror URLs; cap with reservoir of first N unique hosts.
   */
  class SupplementalListUpdater {
    static ALARM = "abl-list-update";
    static RULE_START = 10000;
    static MAX_RULES = 1500;
    static PERIOD_MINUTES = 24 * 60;

    static #MIRRORS = Object.freeze([
      "https://hole.cert.pl/domains/v2/domains.txt",
      "https://raw.githubusercontent.com/appany/nrd-list/main/nrd-14day.txt",
    ]);

    /**
     * @param {() => Promise<{ enabled: boolean, features: Record<string, boolean> }>} getStatus
     */
    constructor(getStatus) {
      this._getStatus = getStatus;
      this._last = { ok: false, count: 0, at: 0, error: "" };
    }

    get status() {
      return { ...this._last };
    }

    async schedule() {
      await chrome.alarms.clear(SupplementalListUpdater.ALARM);
      const status = await this._getStatus();
      if (!status.enabled || status.features.listAutoUpdate === false) return;
      await chrome.alarms.create(SupplementalListUpdater.ALARM, {
        periodInMinutes: SupplementalListUpdater.PERIOD_MINUTES,
        delayInMinutes: 1,
      });
    }

    /**
     * @param {string} text
     * @returns {string[]}
     */
    static parseDomainList(text) {
      const set = new Set();
      const lines = String(text || "").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
        let host = trimmed;
        if (host.includes("://")) {
          try {
            host = new URL(host).hostname;
          } catch {
            continue;
          }
        }
        host = HostKey.normalize(host.split(/\s+/)[0]);
        if (!host || host.length < 4 || !host.includes(".")) continue;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
        set.add(host);
        if (set.size >= SupplementalListUpdater.MAX_RULES) break;
      }
      return [...set];
    }

    async #clearRules() {
      const ids = [];
      for (let i = 0; i < SupplementalListUpdater.MAX_RULES; i += 1) {
        ids.push(SupplementalListUpdater.RULE_START + i);
      }
      // Chrome accepts large remove arrays; chunk for safety.
      for (let i = 0; i < ids.length; i += 500) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: ids.slice(i, i + 500),
          addRules: [],
        });
      }
    }

    /**
     * Pack domains into DNR block rules (batched requestDomains).
     * @param {string[]} domains
     */
    async #applyDomains(domains) {
      await this.#clearRules();
      const BATCH = 50;
      const addRules = [];
      let ruleOffset = 0;
      for (let i = 0; i < domains.length && ruleOffset < SupplementalListUpdater.MAX_RULES; i += BATCH) {
        const slice = domains.slice(i, i + BATCH);
        addRules.push({
          id: SupplementalListUpdater.RULE_START + ruleOffset,
          priority: 40,
          action: { type: "block" },
          condition: {
            requestDomains: slice,
            resourceTypes: [
              "main_frame",
              "sub_frame",
              "script",
              "xmlhttprequest",
              "image",
              "ping",
              "websocket",
              "other",
            ],
          },
        });
        ruleOffset += 1;
      }

      for (let i = 0; i < addRules.length; i += 100) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: addRules.slice(i, i + 100),
        });
      }
      return ruleOffset;
    }

    async sync() {
      const status = await this._getStatus();
      if (!status.enabled || status.features.listAutoUpdate === false) {
        await this.#clearRules();
        this._last = { ok: true, count: 0, at: Date.now(), error: "disabled" };
        await chrome.storage.local.set({ listUpdateMeta: this._last });
        return this._last;
      }

      let lastError = "all_mirrors_failed";
      for (const mirror of SupplementalListUpdater.#MIRRORS) {
        try {
          const res = await fetch(mirror, { cache: "no-store", credentials: "omit" });
          if (!res.ok) {
            lastError = `http_${res.status}`;
            continue;
          }
          const text = await res.text();
          const domains = SupplementalListUpdater.parseDomainList(text);
          if (domains.length < 10) {
            lastError = "too_few_domains";
            continue;
          }
          const count = await this.#applyDomains(domains);
          this._last = { ok: true, count, at: Date.now(), error: "", source: mirror };
          await chrome.storage.local.set({ listUpdateMeta: this._last });
          return this._last;
        } catch (err) {
          lastError = String(err?.message || err);
        }
      }

      this._last = { ok: false, count: 0, at: Date.now(), error: lastError };
      await chrome.storage.local.set({ listUpdateMeta: this._last });
      return this._last;
    }
  }

  globalThis.AblListUpdater = { SupplementalListUpdater };
})();
