(() => {
  "use strict";

  const { HostKey } = globalThis.AblDs;

  /**
   * On-device adaptive learning — cluster annoyance dismissals → auto cosmetics.
   * Not cloud AI: pattern tokens from selectors / class names the user closes.
   */
  class AdaptiveLearnStore {
    static KEY = "adaptiveLearn";
    static COSMETIC_KEY = "adaptiveCosmetics";
    static PROMOTE_AT = 3;
    static MAX_PATTERNS = 200;
    static MAX_PER_HOST = 40;

    static #TOKEN_RE =
      /\b(popup|modal|overlay|dialog|newsletter|subscribe|promo|coupon|cart|checkout|interstitial|paywall|consent|cookie|adblock|banner|flyer|lightbox|upsell|shopping|offer|discount)\b/gi;

    /**
     * @param {string} text
     * @returns {string[]}
     */
    static tokensFrom(text) {
      const raw = String(text || "").toLowerCase();
      const found = raw.match(AdaptiveLearnStore.#TOKEN_RE) || [];
      return [...new Set(found.map((t) => t.toLowerCase()))].sort();
    }

    /**
     * Stable pattern id from tokens (need ≥1 annoyance token).
     * @param {string[]} tokens
     */
    static patternKey(tokens) {
      const t = (tokens || []).filter(Boolean);
      if (!t.length) return "";
      return t.slice(0, 4).join("|");
    }

    /**
     * Build a safe generalized hide selector from tokens.
     * @param {string[]} tokens
     */
    static selectorFromTokens(tokens) {
      const parts = [];
      for (const t of tokens.slice(0, 3)) {
        const safe = t.replace(/[^a-z0-9_-]/gi, "");
        if (!safe || safe.length < 3) continue;
        parts.push(`[class*='${safe}' i]`);
        parts.push(`[id*='${safe}' i]`);
      }
      if (!parts.length) return "";
      return parts.join(",");
    }

    constructor() {
      /** @type {{ patterns: Record<string, { count: number, hosts: string[], selector: string, updatedAt: number }>, promoted: number }} */
      this._data = { patterns: {}, promoted: 0 };
      this._cosmetics = {};
      this._ready = false;
    }

    async hydrate() {
      const data = await chrome.storage.local.get({
        [AdaptiveLearnStore.KEY]: null,
        [AdaptiveLearnStore.COSMETIC_KEY]: {},
      });
      const raw = data[AdaptiveLearnStore.KEY];
      this._data =
        raw && typeof raw === "object"
          ? {
              patterns: raw.patterns && typeof raw.patterns === "object" ? raw.patterns : {},
              promoted: Number(raw.promoted) || 0,
            }
          : { patterns: {}, promoted: 0 };
      this._cosmetics =
        data[AdaptiveLearnStore.COSMETIC_KEY] && typeof data[AdaptiveLearnStore.COSMETIC_KEY] === "object"
          ? data[AdaptiveLearnStore.COSMETIC_KEY]
          : {};
      this._ready = true;
    }

    async #persist() {
      await chrome.storage.local.set({
        [AdaptiveLearnStore.KEY]: this._data,
        [AdaptiveLearnStore.COSMETIC_KEY]: this._cosmetics,
      });
    }

    /**
     * @param {{ host: string, selector?: string, detail?: string, kind?: string }} event
     * @param {{ addCosmetic: (host: string, selector: string) => Promise<{ added?: boolean }> }} deps
     */
    async observe(event, deps) {
      if (!this._ready) await this.hydrate();
      const host = HostKey.normalize(event.host || "");
      const blob = `${event.selector || ""} ${event.detail || ""} ${event.kind || ""}`;
      const tokens = AdaptiveLearnStore.tokensFrom(blob);
      const key = AdaptiveLearnStore.patternKey(tokens);
      if (!host || !key) {
        return { ok: false, reason: "no_pattern" };
      }

      const entry = this._data.patterns[key] || {
        count: 0,
        hosts: [],
        selector: "",
        updatedAt: 0,
      };
      entry.count += 1;
      entry.updatedAt = Date.now();
      if (event.selector) entry.selector = String(event.selector).slice(0, 280);
      if (!entry.hosts.includes(host)) {
        entry.hosts.push(host);
        if (entry.hosts.length > 20) entry.hosts = entry.hosts.slice(-20);
      }
      this._data.patterns[key] = entry;

      // Cap pattern map size (drop oldest).
      const keys = Object.keys(this._data.patterns);
      if (keys.length > AdaptiveLearnStore.MAX_PATTERNS) {
        keys
          .sort(
            (a, b) =>
              (this._data.patterns[a].updatedAt || 0) - (this._data.patterns[b].updatedAt || 0)
          )
          .slice(0, keys.length - AdaptiveLearnStore.MAX_PATTERNS)
          .forEach((k) => delete this._data.patterns[k]);
      }

      let promoted = false;
      let promotedSelector = "";
      if (entry.count >= AdaptiveLearnStore.PROMOTE_AT) {
        promotedSelector =
          AdaptiveLearnStore.selectorFromTokens(tokens) ||
          (entry.selector && globalThis.AblCustomCosmetics?.CustomCosmeticBook?.isSafeSelector(entry.selector)
            ? entry.selector
            : "");
        if (promotedSelector) {
          // Apply to every host that taught this pattern (cross-site similar popups).
          const targets = entry.hosts.length ? entry.hosts : [host];
          for (const h of targets) {
            await this.#addAdaptiveCosmetic(h, promotedSelector);
            if (deps?.addCosmetic) {
              try {
                await deps.addCosmetic(h, promotedSelector);
              } catch {
                // ignore
              }
            }
          }
          promoted = true;
          this._data.promoted = (Number(this._data.promoted) || 0) + 1;
          // Reset count so we don't re-promote every observation.
          entry.count = 0;
          this._data.patterns[key] = entry;
        }
      }

      await this.#persist();
      return {
        ok: true,
        pattern: key,
        count: entry.count,
        promoted,
        selector: promotedSelector,
      };
    }

    /**
     * @param {string} host
     * @param {string} selector
     */
    async #addAdaptiveCosmetic(host, selector) {
      const key = HostKey.normalize(host);
      if (!key || !selector) return;
      const list = Array.isArray(this._cosmetics[key]) ? this._cosmetics[key].slice() : [];
      if (list.includes(selector)) return;
      list.push(selector);
      this._cosmetics[key] = list.slice(0, AdaptiveLearnStore.MAX_PER_HOST);
    }

    /**
     * @param {string} host
     * @returns {string[]}
     */
    selectorsFor(host) {
      const key = HostKey.normalize(host);
      if (!key) return [];
      const out = [];
      const seen = new Set();
      for (const suffix of HostKey.suffixes(key)) {
        const list = this._cosmetics[suffix];
        if (!Array.isArray(list)) continue;
        for (const s of list) {
          if (seen.has(s)) continue;
          seen.add(s);
          out.push(s);
        }
      }
      return out;
    }

    async status() {
      if (!this._ready) await this.hydrate();
      const patterns = Object.keys(this._data.patterns).length;
      const hosts = Object.keys(this._cosmetics).length;
      return {
        patterns,
        hosts,
        promoted: Number(this._data.promoted) || 0,
      };
    }

    async clear() {
      this._data = { patterns: {}, promoted: 0 };
      this._cosmetics = {};
      await this.#persist();
      return { ok: true };
    }
  }

  globalThis.AblAdaptive = { AdaptiveLearnStore };
})();
