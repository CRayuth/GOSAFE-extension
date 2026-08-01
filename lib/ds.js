(() => {
  "use strict";

  /**
   * HostKey — normalize + suffix walk (longest → shortest).
   * Used by site rules and phishing brand checks.
   */
  class HostKey {
    /** @param {string} host */
    static normalize(host) {
      return String(host || "")
        .trim()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .replace(/^www\./i, "")
        .toLowerCase();
    }

    /**
     * Suffix array of labels for domain matching.
     * e.g. a.b.example.com → ["a.b.example.com","b.example.com","example.com"]
     * @param {string} host
     * @returns {string[]}
     */
    static suffixes(host) {
      const h = HostKey.normalize(host);
      if (!h || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return h ? [h] : [];
      const parts = h.split(".").filter(Boolean);
      if (parts.length < 2) return [h];
      const out = [];
      for (let i = 0; i < parts.length - 1; i += 1) {
        out.push(parts.slice(i).join("."));
      }
      return out;
    }

    /** @param {string} urlOrHost */
    static fromUrl(urlOrHost) {
      try {
        if (/^https?:\/\//i.test(urlOrHost)) {
          return HostKey.normalize(new URL(urlOrHost).hostname);
        }
      } catch {
        // fall through
      }
      return HostKey.normalize(urlOrHost);
    }
  }

  /**
   * Edit distance (Levenshtein) — classic DP, O(nm).
   * Used for typosquat brand detection.
   */
  class EditDistance {
    /**
     * @param {string} a
     * @param {string} b
     * @param {number} [max]
     */
    static levenshtein(a, b, max = 4) {
      const s = String(a);
      const t = String(b);
      if (Math.abs(s.length - t.length) > max) return max + 1;
      const m = s.length;
      const n = t.length;
      const prev = new Uint16Array(n + 1);
      const cur = new Uint16Array(n + 1);
      for (let j = 0; j <= n; j += 1) prev[j] = j;
      for (let i = 1; i <= m; i += 1) {
        cur[0] = i;
        let rowMin = cur[0];
        for (let j = 1; j <= n; j += 1) {
          const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
          if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > max) return max + 1;
        prev.set(cur);
      }
      return prev[n];
    }
  }

  /**
   * LRU cache — Map insertion order as queue.
   * @template K, V
   */
  class LruCache {
    /**
     * @param {number} capacity
     */
    constructor(capacity) {
      this._cap = Math.max(1, capacity);
      /** @type {Map<K, V>} */
      this._map = new Map();
    }

    /** @param {K} key */
    get(key) {
      if (!this._map.has(key)) return undefined;
      const value = this._map.get(key);
      this._map.delete(key);
      this._map.set(key, value);
      return value;
    }

    /**
     * @param {K} key
     * @param {V} value
     */
    set(key, value) {
      if (this._map.has(key)) this._map.delete(key);
      this._map.set(key, value);
      while (this._map.size > this._cap) {
        const oldest = this._map.keys().next().value;
        this._map.delete(oldest);
      }
    }

    clear() {
      this._map.clear();
    }
  }

  globalThis.AblDs = { HostKey, EditDistance, LruCache };
})();
