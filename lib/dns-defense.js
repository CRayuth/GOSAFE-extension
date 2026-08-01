(() => {
  "use strict";

  const { HostKey, LruCache } = globalThis.AblDs || {};

  // ---------------------------------------------------------------------------
  // Data structures
  // ---------------------------------------------------------------------------

  /**
   * Fixed-capacity circular buffer of timestamps (or numbers).
   * O(1) push / O(k) prune for sliding-window rate analysis.
   */
  class RingTimeBuffer {
    /** @param {number} capacity */
    constructor(capacity) {
      this._cap = Math.max(8, capacity | 0);
      /** @type {Float64Array} */
      this._buf = new Float64Array(this._cap);
      this._head = 0;
      this._size = 0;
    }

    /** @param {number} ts */
    push(ts) {
      this._buf[this._head] = ts;
      this._head = (this._head + 1) % this._cap;
      if (this._size < this._cap) this._size += 1;
    }

    /**
     * Count values in (now - windowMs, now]. Scans occupied slots — O(capacity).
     * @param {number} now
     * @param {number} windowMs
     */
    countSince(now, windowMs) {
      const floor = now - windowMs;
      let n = 0;
      for (let i = 0; i < this._size; i += 1) {
        const idx = (this._head - this._size + i + this._cap) % this._cap;
        if (this._buf[idx] > floor) n += 1;
      }
      return n;
    }

    clear() {
      this._head = 0;
      this._size = 0;
    }
  }

  /**
   * Sliding unique-set per key: Map<key, Map<subKey, lastSeenTs>> with LRU eviction of keys.
   * Detects high-cardinality subdomain generation under one apex (tunnel beaconing).
   */
  class SlidingUniqueIndex {
    /**
     * @param {number} maxKeys
     * @param {number} windowMs
     * @param {number} maxUniquesPerKey
     */
    constructor(maxKeys = 256, windowMs = 60_000, maxUniquesPerKey = 64) {
      this._windowMs = windowMs;
      this._maxUniques = maxUniquesPerKey;
      /** @type {LruCache<string, Map<string, number>> | Map<string, Map<string, number>>} */
      this._keys = LruCache ? new LruCache(maxKeys) : new Map();
    }

    /**
     * @param {string} key
     * @param {string} unique
     * @param {number} [now]
     * @returns {{ size: number, isNew: boolean }}
     */
    observe(key, unique, now = Date.now()) {
      let bag = this._keys.get(key);
      if (!bag) {
        bag = new Map();
        this._keys.set(key, bag);
      }
      const floor = now - this._windowMs;
      for (const [u, ts] of [...bag.entries()]) {
        if (ts < floor) bag.delete(u);
      }
      const isNew = !bag.has(unique);
      bag.set(unique, now);
      while (bag.size > this._maxUniques) {
        const oldest = bag.keys().next().value;
        bag.delete(oldest);
      }
      this._keys.set(key, bag);
      return { size: bag.size, isNew };
    }

    clear() {
      if (typeof this._keys.clear === "function") this._keys.clear();
    }
  }

  /**
   * Shannon entropy (bits/char) via frequency histogram — O(n).
   */
  class ShannonEntropy {
    /** @param {string} s */
    static of(s) {
      const raw = String(s || "");
      const n = raw.length;
      if (!n) return 0;
      const freq = new Map();
      for (let i = 0; i < n; i += 1) {
        const ch = raw.charCodeAt(i);
        freq.set(ch, (freq.get(ch) || 0) + 1);
      }
      let h = 0;
      for (const c of freq.values()) {
        const p = c / n;
        h -= p * Math.log2(p);
      }
      return h;
    }
  }

  /**
   * Hostname feature vector for tunnel heuristics.
   */
  class HostnameFingerprint {
    static #HEX = /^[0-9a-f]+$/i;
    static #B32 = /^[a-z2-7]+$/i;
    static #MULTI_PS = new Set([
      "edu",
      "ac",
      "gov",
      "co",
      "com",
      "net",
      "org",
      "sch",
    ]);

    /**
     * @param {string} host
     * @returns {{
     *   host: string,
     *   labels: string[],
     *   apex: string,
     *   left: string,
     *   depth: number,
     *   fqdnLen: number,
     *   maxLabelLen: number,
     *   leftEntropy: number,
     *   hexish: boolean,
     *   b32ish: boolean,
     *   digitRatio: number,
     * }}
     */
    static parse(host) {
      const h = HostKey ? HostKey.normalize(host) : String(host || "").toLowerCase();
      const labels = h.split(".").filter(Boolean);
      let apexLabels = 2;
      if (labels.length >= 3 && HostnameFingerprint.#MULTI_PS.has(labels[labels.length - 2])) {
        apexLabels = 3;
      }
      const apex = labels.slice(-apexLabels).join(".") || h;
      const left = labels.length > apexLabels ? labels[0] : "";
      const maxLabelLen = labels.reduce((m, l) => Math.max(m, l.length), 0);
      let digits = 0;
      for (let i = 0; i < left.length; i += 1) {
        const c = left.charCodeAt(i);
        if (c >= 48 && c <= 57) digits += 1;
      }
      const leftEntropy = ShannonEntropy.of(left);
      const hexish = left.length >= 24 && HostnameFingerprint.#HEX.test(left);
      const b32ish = left.length >= 24 && HostnameFingerprint.#B32.test(left) && !hexish;
      return {
        host: h,
        labels,
        apex,
        left,
        depth: Math.max(0, labels.length - apexLabels),
        fqdnLen: h.length,
        maxLabelLen,
        leftEntropy,
        hexish,
        b32ish,
        digitRatio: left.length ? digits / left.length : 0,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // DNS tunneling scorer
  // ---------------------------------------------------------------------------

  /**
   * Weighted tunnel likelihood from hostname structure + apex cardinality.
   * Inspired by academic DNS-tunnel detectors (entropy, label length, NX-style churn)
   * adapted to browser-visible request hostnames (no raw DNS packets).
   */
  class DnsTunnelScorer {
    static #WEIGHTS = Object.freeze({
      longLabel: 28,
      highEntropy: 22,
      hexPayload: 24,
      b32Payload: 20,
      deepFqdn: 12,
      digitHeavy: 10,
      cardinality: 35,
    });

    static #THRESH = Object.freeze({
      labelLen: 40,
      entropy: 3.55,
      fqdnLen: 90,
      depth: 4,
      digitRatio: 0.45,
      uniqueSubs: 12,
      alertScore: 55,
    });

    /** Apexes that legitimately mint many short-lived names. */
    static #SKIP_APEX = new Set([
      "googleapis.com",
      "gstatic.com",
      "googleusercontent.com",
      "ggpht.com",
      "cloudfront.net",
      "akamaihd.net",
      "akamaized.net",
      "cloudflare.com",
      "cdninstagram.com",
      "fbcdn.net",
      "twimg.com",
      "amazonaws.com",
      "azureedge.net",
      "office.com",
      "microsoft.com",
      "live.com",
      "youtube.com",
      "ytimg.com",
      "googlevideo.com",
      "spotify.com",
      "scdn.co",
    ]);

    constructor() {
      this._card = new SlidingUniqueIndex(320, 45_000, 80);
      this._rate = new Map();
    }

    /**
     * @param {string} host
     * @returns {{ score: number, reasons: string[], fp: object, alert: boolean } | null}
     */
    score(host) {
      const fp = HostnameFingerprint.parse(host);
      if (!fp.host || fp.host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(fp.host)) {
        return null;
      }
      for (const skip of DnsTunnelScorer.#SKIP_APEX) {
        if (fp.apex === skip || fp.host.endsWith(`.${skip}`)) return null;
      }

      const W = DnsTunnelScorer.#WEIGHTS;
      const T = DnsTunnelScorer.#THRESH;
      let score = 0;
      /** @type {string[]} */
      const reasons = [];

      if (fp.maxLabelLen >= T.labelLen) {
        score += W.longLabel;
        reasons.push(`long_label:${fp.maxLabelLen}`);
      }
      if (fp.left.length >= 20 && fp.leftEntropy >= T.entropy) {
        score += W.highEntropy;
        reasons.push(`entropy:${fp.leftEntropy.toFixed(2)}`);
      }
      if (fp.hexish) {
        score += W.hexPayload;
        reasons.push("hex_payload");
      }
      if (fp.b32ish) {
        score += W.b32Payload;
        reasons.push("base32_payload");
      }
      if (fp.fqdnLen >= T.fqdnLen || fp.depth >= T.depth) {
        score += W.deepFqdn;
        reasons.push(`depth:${fp.depth}/len:${fp.fqdnLen}`);
      }
      if (fp.left.length >= 16 && fp.digitRatio >= T.digitRatio) {
        score += W.digitHeavy;
        reasons.push(`digits:${fp.digitRatio.toFixed(2)}`);
      }

      if (fp.left && fp.depth >= 1) {
        const { size, isNew } = this._card.observe(fp.apex, fp.left);
        if (isNew && size >= T.uniqueSubs) {
          score += W.cardinality;
          reasons.push(`sub_churn:${size}`);
        }
      }

      // Soft rate boost: many tunnel-like hits under same apex quickly
      const now = Date.now();
      let ring = this._rate.get(fp.apex);
      if (!ring) {
        ring = new RingTimeBuffer(48);
        this._rate.set(fp.apex, ring);
      }
      if (score >= 30) ring.push(now);
      const burst = ring.countSince(now, 20_000);
      if (burst >= 6) {
        score += 15;
        reasons.push(`burst:${burst}`);
      }

      return {
        score,
        reasons,
        fp,
        alert: score >= T.alertScore,
      };
    }

    clear() {
      this._card.clear();
      this._rate.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // DNS spoof / hijack monitor (multi-resolver consensus)
  // ---------------------------------------------------------------------------

  class IpSet {
    /** @param {Iterable<string>} [ips] */
    constructor(ips = []) {
      /** @type {Set<string>} */
      this._set = new Set([...ips].map(IpSet.normalize).filter(Boolean));
    }

    static normalize(ip) {
      return String(ip || "")
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "");
    }

    /** RFC1918 / loopback / link-local / ULA */
    static isPrivate(ip) {
      const v = IpSet.normalize(ip);
      if (!v) return false;
      if (v === "::1" || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) {
        return true;
      }
      const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
      if (!m) return false;
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a === 10 || a === 127) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 169 && b === 254) return true;
      if (a === 0 || a === 255) return true;
      return false;
    }

    get size() {
      return this._set.size;
    }

    /** @returns {string[]} */
    toArray() {
      return [...this._set];
    }

    /** @param {IpSet} other */
    intersects(other) {
      for (const ip of this._set) {
        if (other._set.has(ip)) return true;
      }
      return false;
    }

    /** @param {IpSet} other */
    equals(other) {
      if (this._set.size !== other._set.size) return false;
      for (const ip of this._set) {
        if (!other._set.has(ip)) return false;
      }
      return true;
    }
  }

  /**
   * Parallel DoH + chrome.dns resolve. Consensus mismatch → spoof signal.
   */
  class MultiResolver {
    static #DOH = Object.freeze([
      {
        id: "cloudflare",
        url: (name) =>
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`,
        headers: { Accept: "application/dns-json" },
      },
      {
        id: "google",
        url: (name) =>
          `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=A`,
        headers: { Accept: "application/dns-json" },
      },
    ]);

    /**
     * @param {string} host
     * @returns {Promise<{ id: string, ips: IpSet, ok: boolean, error?: string }[]>}
     */
    static async resolveAll(host) {
      const name = HostKey ? HostKey.normalize(host) : String(host || "").toLowerCase();
      if (!name) return [];

      const tasks = MultiResolver.#DOH.map(async (ep) => {
        try {
          const res = await fetch(ep.url(name), {
            method: "GET",
            credentials: "omit",
            cache: "no-store",
            headers: ep.headers,
          });
          if (!res.ok) return { id: ep.id, ips: new IpSet(), ok: false, error: `http_${res.status}` };
          const json = await res.json();
          const answers = Array.isArray(json.Answer) ? json.Answer : [];
          const ips = answers
            .filter((a) => a && (a.type === 1 || a.type === "A") && a.data)
            .map((a) => String(a.data));
          return { id: ep.id, ips: new IpSet(ips), ok: ips.length > 0 };
        } catch (err) {
          return {
            id: ep.id,
            ips: new IpSet(),
            ok: false,
            error: String(err?.message || err || "fetch_failed"),
          };
        }
      });

      // Optional native resolver (Chrome "dns" permission)
      tasks.push(
        (async () => {
          try {
            if (typeof chrome === "undefined" || !chrome?.dns?.resolve) {
              return { id: "chrome_dns", ips: new IpSet(), ok: false, error: "unavailable" };
            }
            const result = await new Promise((resolve, reject) => {
              try {
                chrome.dns.resolve(name, (r) => {
                  const err = chrome.runtime?.lastError;
                  if (err) reject(new Error(err.message));
                  else resolve(r);
                });
              } catch (e) {
                reject(e);
              }
            });
            const addr = result?.address ? [String(result.address)] : [];
            return { id: "chrome_dns", ips: new IpSet(addr), ok: addr.length > 0 };
          } catch (err) {
            return {
              id: "chrome_dns",
              ips: new IpSet(),
              ok: false,
              error: String(err?.message || err || "resolve_failed"),
            };
          }
        })()
      );

      return Promise.all(tasks);
    }
  }

  /**
   * Spoof / rebinding detector using resolver consensus + IP pinning.
   */
  class DnsSpoofMonitor {
    static #PIN_TTL_MS = 30 * 60_000;
    static #TRUSTED = new Set([
      "google.com",
      "youtube.com",
      "facebook.com",
      "fb.com",
      "instagram.com",
      "microsoft.com",
      "live.com",
      "apple.com",
      "icloud.com",
      "amazon.com",
      "paypal.com",
      "netflix.com",
      "github.com",
      "cloudflare.com",
      "wikipedia.org",
      "twitter.com",
      "x.com",
      "linkedin.com",
      "whatsapp.com",
      "messenger.com",
      "meta.com",
    ]);

    constructor() {
      /** @type {LruCache<string, { ips: string[], ts: number }> | Map} */
      this._pins = LruCache ? new LruCache(200) : new Map();
      /** @type {LruCache<string, number> | Map} */
      this._cooldown = LruCache ? new LruCache(100) : new Map();
      this._inflight = new Set();
    }

    /** @param {string} host */
    static isTrustedHost(host) {
      const h = HostKey ? HostKey.normalize(host) : String(host || "").toLowerCase();
      const suffixes = HostKey?.suffixes ? HostKey.suffixes(h) : [h];
      return suffixes.some((s) => DnsSpoofMonitor.#TRUSTED.has(s));
    }

    /**
     * @param {string} host
     * @returns {Promise<null | {
     *   alert: boolean,
     *   severity: "warn" | "bad",
     *   title: string,
     *   detail: string,
     *   reasons: string[],
     *   resolvers: object[],
     * }>}
     */
    async check(host) {
      const h = HostKey ? HostKey.normalize(host) : String(host || "").toLowerCase();
      if (!h || this._inflight.has(h)) return null;
      if (!DnsSpoofMonitor.isTrustedHost(h) && !this.#shouldSample(h)) return null;

      const last = this._cooldown.get(h) || 0;
      if (Date.now() - last < 90_000) return null;

      this._inflight.add(h);
      try {
        const results = await MultiResolver.resolveAll(h);
        const ok = results.filter((r) => r.ok && r.ips.size > 0);
        /** @type {string[]} */
        const reasons = [];

        // Private IP for a public hostname → rebinding / local spoof
        for (const r of ok) {
          for (const ip of r.ips.toArray()) {
            if (IpSet.isPrivate(ip)) {
              reasons.push(`private_ip:${r.id}:${ip}`);
            }
          }
        }
        if (reasons.some((x) => x.startsWith("private_ip:"))) {
          this._cooldown.set(h, Date.now());
          return {
            alert: true,
            severity: "bad",
            title: "DNS rebinding / spoof signal",
            detail: `${h} resolved to a private address`,
            reasons,
            resolvers: results.map((r) => ({
              id: r.id,
              ok: r.ok,
              ips: r.ips.toArray(),
              error: r.error,
            })),
          };
        }

        // Consensus: ≥2 successful resolvers with disjoint A sets
        if (ok.length >= 2) {
          let disagree = false;
          for (let i = 0; i < ok.length; i += 1) {
            for (let j = i + 1; j < ok.length; j += 1) {
              if (!ok[i].ips.intersects(ok[j].ips) && !ok[i].ips.equals(ok[j].ips)) {
                disagree = true;
                reasons.push(`mismatch:${ok[i].id}≠${ok[j].id}`);
              }
            }
          }
          if (disagree) {
            this._cooldown.set(h, Date.now());
            return {
              alert: true,
              severity: "bad",
              title: "DNS spoofing suspected",
              detail: `Resolvers disagree on ${h}`,
              reasons,
              resolvers: results.map((r) => ({
                id: r.id,
                ok: r.ok,
                ips: r.ips.toArray(),
                error: r.error,
              })),
            };
          }
        }

        // Pin baseline for trusted hosts; alert on total IP set replacement
        if (DnsSpoofMonitor.isTrustedHost(h) && ok.length) {
          const merged = new IpSet(ok.flatMap((r) => r.ips.toArray()));
          const pin = this._pins.get(h);
          const now = Date.now();
          if (pin && now - pin.ts < DnsSpoofMonitor.#PIN_TTL_MS) {
            const pinned = new IpSet(pin.ips);
            if (pinned.size && merged.size && !pinned.intersects(merged)) {
              reasons.push("pin_break");
              this._cooldown.set(h, now);
              // Refresh pin to new reality but alert once
              this._pins.set(h, { ips: merged.toArray(), ts: now });
              return {
                alert: true,
                severity: "warn",
                title: "Trusted domain IP changed",
                detail: `${h} answers no longer overlap prior pin`,
                reasons,
                resolvers: results.map((r) => ({
                  id: r.id,
                  ok: r.ok,
                  ips: r.ips.toArray(),
                  error: r.error,
                })),
              };
            }
          }
          this._pins.set(h, { ips: merged.toArray(), ts: now });
        }

        this._cooldown.set(h, Date.now());
        return {
          alert: false,
          severity: "warn",
          title: "",
          detail: "",
          reasons: [],
          resolvers: results.map((r) => ({
            id: r.id,
            ok: r.ok,
            ips: r.ips.toArray(),
            error: r.error,
          })),
        };
      } finally {
        this._inflight.delete(h);
      }
    }

    /** Light sampling for non-trusted hosts (1/12). */
    #shouldSample(host) {
      let hash = 0;
      const s = String(host);
      for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
      return hash % 12 === 0;
    }

    clear() {
      if (typeof this._pins.clear === "function") this._pins.clear();
      if (typeof this._cooldown.clear === "function") this._cooldown.clear();
      this._inflight.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Facade / controller
  // ---------------------------------------------------------------------------

  /**
   * Real-time DNS defense engine (tunnel heuristics + spoof consensus).
   */
  class DnsDefenseEngine {
    constructor() {
      this.tunnel = new DnsTunnelScorer();
      this.spoof = new DnsSpoofMonitor();
      /** @type {LruCache<string, number> | Map} */
      this._alertCd = LruCache ? new LruCache(150) : new Map();
      this._stats = {
        observed: 0,
        tunnelAlerts: 0,
        spoofAlerts: 0,
        lastAlertAt: 0,
      };
    }

    /**
     * Observe a request hostname for tunneling patterns (sync, cheap).
     * @param {string} host
     * @returns {null | { kind: "tunnel", title: string, detail: string, host: string, score: number, reasons: string[] }}
     */
    observeHostname(host) {
      this._stats.observed += 1;
      const result = this.tunnel.score(host);
      if (!result?.alert) return null;
      const key = `tunnel:${result.fp.apex}`;
      if (!this.#cooldownOk(key, 60_000)) return null;
      this._stats.tunnelAlerts += 1;
      this._stats.lastAlertAt = Date.now();
      return {
        kind: "tunnel",
        title: "DNS tunneling pattern",
        detail: `${result.fp.host} (score ${result.score}) — ${result.reasons.slice(0, 4).join(", ")}`,
        host: result.fp.host,
        score: result.score,
        reasons: result.reasons,
      };
    }

    /**
     * Async spoof check (main-frame / trusted hosts).
     * @param {string} host
     */
    async checkSpoof(host) {
      const result = await this.spoof.check(host);
      if (!result?.alert) return null;
      const key = `spoof:${HostKey ? HostKey.normalize(host) : host}`;
      if (!this.#cooldownOk(key, 120_000)) return null;
      this._stats.spoofAlerts += 1;
      this._stats.lastAlertAt = Date.now();
      return {
        kind: "spoof",
        title: result.title,
        detail: `${result.detail} — ${result.reasons.slice(0, 4).join(", ")}`,
        host: HostKey ? HostKey.normalize(host) : String(host),
        severity: result.severity,
        reasons: result.reasons,
        resolvers: result.resolvers,
      };
    }

    status() {
      return {
        ok: true,
        ...this._stats,
        chromeDns:
          typeof chrome !== "undefined" && Boolean(chrome?.dns?.resolve),
      };
    }

    clear() {
      this.tunnel.clear();
      this.spoof.clear();
      if (typeof this._alertCd.clear === "function") this._alertCd.clear();
    }

    /**
     * @param {string} key
     * @param {number} ms
     */
    #cooldownOk(key, ms) {
      const now = Date.now();
      const last = this._alertCd.get(key) || 0;
      if (now - last < ms) return false;
      this._alertCd.set(key, now);
      return true;
    }
  }

  globalThis.AblDnsDefense = Object.freeze({
    RingTimeBuffer,
    SlidingUniqueIndex,
    ShannonEntropy,
    HostnameFingerprint,
    DnsTunnelScorer,
    IpSet,
    MultiResolver,
    DnsSpoofMonitor,
    DnsDefenseEngine,
  });
})();
