(() => {
  "use strict";

  const { HostKey } = globalThis.AblDs;

  /**
   * Per-host custom cosmetic (hide) selectors — Map + longest-suffix collect.
   */
  class CustomCosmeticBook {
    static MAX_PER_HOST = 50;
    static MAX_SELECTOR_LEN = 280;

    constructor() {
      /** @type {Map<string, string[]>} */
      this._rules = new Map();
    }

    /**
     * @param {Record<string, string[]> | null | undefined} raw
     */
    load(raw) {
      this._rules.clear();
      if (!raw || typeof raw !== "object") return;
      for (const [host, list] of Object.entries(raw)) {
        const key = HostKey.normalize(host);
        if (!key || !Array.isArray(list)) continue;
        const cleaned = CustomCosmeticBook.sanitizeList(list);
        if (cleaned.length) this._rules.set(key, cleaned);
      }
    }

    /** @returns {Record<string, string[]>} */
    toJSON() {
      const out = {};
      for (const [k, v] of this._rules) out[k] = v.slice();
      return out;
    }

    /**
     * @param {string} selector
     * @returns {boolean}
     */
    static isSafeSelector(selector) {
      const s = String(selector || "").trim();
      if (!s || s.length > CustomCosmeticBook.MAX_SELECTOR_LEN) return false;
      const low = s.toLowerCase();
      if (low === "html" || low === "body" || low === "*" || low === ":root") return false;
      if (/[{};]|<\/|@import|expression\s*\(/i.test(s)) return false;
      return true;
    }

    /**
     * @param {string[]} list
     * @returns {string[]}
     */
    static sanitizeList(list) {
      const out = [];
      const seen = new Set();
      for (const item of list) {
        const s = String(item || "").trim();
        if (!CustomCosmeticBook.isSafeSelector(s) || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= CustomCosmeticBook.MAX_PER_HOST) break;
      }
      return out;
    }

    /**
     * Collect selectors matching host via suffix walk (exact host first).
     * @param {string} host
     * @returns {string[]}
     */
    collect(host) {
      const seen = new Set();
      const out = [];
      for (const suffix of HostKey.suffixes(host)) {
        const list = this._rules.get(suffix);
        if (!list) continue;
        for (const s of list) {
          if (seen.has(s)) continue;
          seen.add(s);
          out.push(s);
        }
      }
      return out;
    }

    /**
     * Exact-host list (for manage UI).
     * @param {string} host
     * @returns {string[]}
     */
    listFor(host) {
      const key = HostKey.normalize(host);
      return key ? (this._rules.get(key) || []).slice() : [];
    }

    /**
     * @param {string} host
     * @param {string} selector
     * @returns {{ ok: boolean, selectors: string[], added: boolean }}
     */
    add(host, selector) {
      const key = HostKey.normalize(host);
      const sel = String(selector || "").trim();
      if (!key || !CustomCosmeticBook.isSafeSelector(sel)) {
        return { ok: false, selectors: [], added: false };
      }
      const cur = this._rules.get(key) || [];
      if (cur.includes(sel)) return { ok: true, selectors: cur.slice(), added: false };
      if (cur.length >= CustomCosmeticBook.MAX_PER_HOST) {
        return { ok: false, selectors: cur.slice(), added: false };
      }
      const next = [...cur, sel];
      this._rules.set(key, next);
      return { ok: true, selectors: next.slice(), added: true };
    }

    /**
     * @param {string} host
     * @param {string} selector
     * @returns {string[]}
     */
    remove(host, selector) {
      const key = HostKey.normalize(host);
      if (!key) return [];
      const sel = String(selector || "").trim();
      const cur = this._rules.get(key) || [];
      const next = cur.filter((s) => s !== sel);
      if (next.length) this._rules.set(key, next);
      else this._rules.delete(key);
      return next.slice();
    }

    /**
     * @param {string} host
     */
    clearHost(host) {
      const key = HostKey.normalize(host);
      if (key) this._rules.delete(key);
    }
  }

  class CustomCosmeticStore {
    static KEY = "customCosmetics";

    constructor() {
      this.book = new CustomCosmeticBook();
      this._ready = false;
    }

    async hydrate() {
      const data = await chrome.storage.local.get({ [CustomCosmeticStore.KEY]: {} });
      this.book.load(data[CustomCosmeticStore.KEY]);
      this._ready = true;
    }

    async persist() {
      await chrome.storage.local.set({
        [CustomCosmeticStore.KEY]: this.book.toJSON(),
      });
    }

    /**
     * @param {string} host
     * @param {string} selector
     */
    async add(host, selector) {
      if (!this._ready) await this.hydrate();
      const result = this.book.add(host, selector);
      if (result.added) await this.persist();
      return result;
    }

    /**
     * @param {string} host
     * @param {string} selector
     */
    async remove(host, selector) {
      if (!this._ready) await this.hydrate();
      const selectors = this.book.remove(host, selector);
      await this.persist();
      return { ok: true, selectors };
    }

    /**
     * @param {string} host
     */
    async clearHost(host) {
      if (!this._ready) await this.hydrate();
      this.book.clearHost(host);
      await this.persist();
      return { ok: true };
    }

    /**
     * @param {string} host
     */
    async list(host) {
      if (!this._ready) await this.hydrate();
      return this.book.listFor(host);
    }
  }

  globalThis.AblCustomCosmetics = { CustomCosmeticBook, CustomCosmeticStore };
})();
