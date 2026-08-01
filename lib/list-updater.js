(() => {
  "use strict";

  const { HostKey } = globalThis.AblDs;

  /**
   * Fetch → parse → unique domain set → DNR dynamic rules.
   * Merges phishing feeds + supplemental NRD mirrors; keeps an in-memory host index
   * for TrustScore / phishing guard (shared with DNR dynamic blocks).
   */
  class SupplementalListUpdater {
    static ALARM = "abl-list-update";
    static RULE_START = 10000;
    static MAX_RULES = 1500;
    static DOMAINS_PER_RULE = 50;
    static PERIOD_MINUTES = 12 * 60;
    static MAX_INDEX = 1500;

    /** Phishing / malware host feeds (prefer these). */
    static #PHISH_MIRRORS = Object.freeze([
      "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt",
      "https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt",
      "https://hole.cert.pl/domains/v2/domains.txt",
    ]);

    /** Extra NRD / junk domain lists. */
    static #NRD_MIRRORS = Object.freeze([
      "https://raw.githubusercontent.com/appany/nrd-list/main/nrd-14day.txt",
    ]);

    /**
     * @param {() => Promise<{ enabled: boolean, features: Record<string, boolean> }>} getStatus
     */
    constructor(getStatus) {
      this._getStatus = getStatus;
      this._last = { ok: false, count: 0, at: 0, error: "", sources: [] };
      /** @type {Set<string>} */
      this._phishHosts = new Set();
      /** @type {Set<string>} */
      this._nrdHosts = new Set();
    }

    get status() {
      return { ...this._last };
    }

    /** Reload host index from storage (startup). */
    async hydrate() {
      try {
        const { listFeedIndex = null, listUpdateMeta = null } = await chrome.storage.local.get({
          listFeedIndex: null,
          listUpdateMeta: null,
        });
        if (listUpdateMeta && typeof listUpdateMeta === "object") {
          this._last = { ...this._last, ...listUpdateMeta };
        }
        const phish = Array.isArray(listFeedIndex?.phish) ? listFeedIndex.phish : [];
        const nrd = Array.isArray(listFeedIndex?.nrd) ? listFeedIndex.nrd : [];
        this._phishHosts = new Set(phish.map((h) => HostKey.normalize(h)).filter(Boolean));
        this._nrdHosts = new Set(nrd.map((h) => HostKey.normalize(h)).filter(Boolean));
      } catch {
        // ignore
      }
    }

    /**
     * Classify host against live supplemental feeds (suffix match).
     * @param {string} host
     * @returns {"phishing_feed" | "nrd" | null}
     */
    lookup(host) {
      const suffixes = HostKey.suffixes(host);
      for (const s of suffixes) {
        if (this._phishHosts.has(s)) return "phishing_feed";
      }
      for (const s of suffixes) {
        if (this._nrdHosts.has(s)) return "nrd";
      }
      return null;
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
     * @param {number} [limit]
     * @returns {string[]}
     */
    static parseDomainList(text, limit = SupplementalListUpdater.MAX_INDEX) {
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
        if (set.size >= limit) break;
      }
      return [...set];
    }

    async #clearRules() {
      const ids = [];
      for (let i = 0; i < SupplementalListUpdater.MAX_RULES; i += 1) {
        ids.push(SupplementalListUpdater.RULE_START + i);
      }
      for (let i = 0; i < ids.length; i += 500) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: ids.slice(i, i + 500),
          addRules: [],
        });
      }
    }

    async #clearIndex() {
      this._phishHosts = new Set();
      this._nrdHosts = new Set();
      await chrome.storage.local.set({
        listFeedIndex: { phish: [], nrd: [], at: Date.now() },
      });
    }

    /**
     * @param {string[]} domains
     */
    async #applyDomains(domains) {
      await this.#clearRules();
      const BATCH = SupplementalListUpdater.DOMAINS_PER_RULE;
      const addRules = [];
      let ruleOffset = 0;
      for (
        let i = 0;
        i < domains.length && ruleOffset < SupplementalListUpdater.MAX_RULES;
        i += BATCH
      ) {
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

    /**
     * @param {readonly string[]} mirrors
     * @returns {Promise<{ domains: string[], source: string, error: string }>}
     */
    async #fetchFirst(mirrors) {
      let lastError = "all_mirrors_failed";
      for (const mirror of mirrors) {
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
          return { domains, source: mirror, error: "" };
        } catch (err) {
          lastError = String(err?.message || err);
        }
      }
      return { domains: [], source: "", error: lastError };
    }

    /**
     * Fetch every mirror that responds; union domains (capped).
     * @param {readonly string[]} mirrors
     * @returns {Promise<{ domains: string[], sources: string[], error: string }>}
     */
    async #fetchMerge(mirrors) {
      const set = new Set();
      const sources = [];
      let lastError = "all_mirrors_failed";
      for (const mirror of mirrors) {
        if (set.size >= SupplementalListUpdater.MAX_INDEX) break;
        try {
          const res = await fetch(mirror, { cache: "no-store", credentials: "omit" });
          if (!res.ok) {
            lastError = `http_${res.status}`;
            continue;
          }
          const text = await res.text();
          const domains = SupplementalListUpdater.parseDomainList(
            text,
            SupplementalListUpdater.MAX_INDEX
          );
          if (domains.length < 10) {
            lastError = "too_few_domains";
            continue;
          }
          let added = 0;
          for (const host of domains) {
            if (set.size >= SupplementalListUpdater.MAX_INDEX) break;
            const before = set.size;
            set.add(host);
            if (set.size > before) added += 1;
          }
          if (added > 0) sources.push(mirror);
        } catch (err) {
          lastError = String(err?.message || err);
        }
      }
      return {
        domains: [...set],
        sources,
        error: sources.length ? "" : lastError,
      };
    }

    async sync() {
      const status = await this._getStatus();
      if (!status.enabled || status.features.listAutoUpdate === false) {
        await this.#clearRules();
        await this.#clearIndex();
        this._last = { ok: true, count: 0, at: Date.now(), error: "disabled", sources: [] };
        await chrome.storage.local.set({ listUpdateMeta: this._last });
        return this._last;
      }

      const phish = await this.#fetchMerge(SupplementalListUpdater.#PHISH_MIRRORS);
      const nrd = await this.#fetchFirst(SupplementalListUpdater.#NRD_MIRRORS);

      const merged = [];
      const phishSet = new Set();
      const nrdSet = new Set();
      const sources = [...phish.sources];

      for (const host of phish.domains) {
        if (merged.length >= SupplementalListUpdater.MAX_INDEX) break;
        if (phishSet.has(host)) continue;
        phishSet.add(host);
        merged.push(host);
      }
      for (const host of nrd.domains) {
        if (merged.length >= SupplementalListUpdater.MAX_INDEX) break;
        if (phishSet.has(host) || nrdSet.has(host)) continue;
        nrdSet.add(host);
        merged.push(host);
      }
      if (nrd.source) sources.push(nrd.source);

      this._phishHosts = phishSet;
      this._nrdHosts = nrdSet;
      await chrome.storage.local.set({
        listFeedIndex: {
          phish: [...phishSet],
          nrd: [...nrdSet],
          at: Date.now(),
        },
      });

      if (merged.length < 10) {
        this._last = {
          ok: false,
          count: 0,
          at: Date.now(),
          error: phish.error || nrd.error || "all_mirrors_failed",
          sources: [],
        };
        await chrome.storage.local.set({ listUpdateMeta: this._last });
        return this._last;
      }

      const count = await this.#applyDomains(merged);
      this._last = {
        ok: true,
        count,
        at: Date.now(),
        error: "",
        sources,
        phishingHosts: phishSet.size,
        nrdHosts: nrdSet.size,
      };
      await chrome.storage.local.set({ listUpdateMeta: this._last });
      return this._last;
    }
  }

  globalThis.AblListUpdater = { SupplementalListUpdater };
})();
