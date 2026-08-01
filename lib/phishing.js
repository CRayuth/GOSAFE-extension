(() => {
  "use strict";

  const { HostKey, EditDistance, LruCache } = globalThis.AblDs;

  /**
   * Weighted heuristic phishing scorer.
   * Algorithm: accumulate signal weights → clamp 0..100; cache by host.
   */
  class PhishingScorer {
    static #BRANDS = Object.freeze([
      "paypal",
      "google",
      "gmail",
      "apple",
      "icloud",
      "microsoft",
      "outlook",
      "office365",
      "amazon",
      "awslogin",
      "facebook",
      "instagram",
      "whatsapp",
      "netflix",
      "spotify",
      "binance",
      "coinbase",
      "metamask",
      "blockchain",
      "kraken",
      "chase",
      "wellsfargo",
      "bankofamerica",
      "dhl",
      "fedex",
      "ups",
      "steamcommunity",
      "discord",
      "tiktok",
      "linkedin",
    ]);

    static #SAFE_SUFFIXES = Object.freeze(
      new Set([
        "google.com",
        "google.co.uk",
        "youtube.com",
        "gmail.com",
        "apple.com",
        "icloud.com",
        "microsoft.com",
        "live.com",
        "office.com",
        "amazon.com",
        "amazonaws.com",
        "facebook.com",
        "instagram.com",
        "whatsapp.com",
        "netflix.com",
        "spotify.com",
        "binance.com",
        "coinbase.com",
        "paypal.com",
        "paypal.me",
        "chase.com",
        "wellsfargo.com",
        "bankofamerica.com",
        "discord.com",
        "discord.gg",
        "linkedin.com",
        "tiktok.com",
        "steamcommunity.com",
        "steampowered.com",
      ])
    );

    static #BAD_TLDS = Object.freeze(
      new Set(["zip", "mov", "tk", "gq", "ml", "cf", "ga", "top", "xyz", "country", "stream", "gdn"])
    );

    constructor() {
      /** @type {LruCache<string, { score: number, reasons: string[] }>} */
      this._cache = new LruCache(500);
    }

    /**
     * @param {string} urlString
     * @returns {{ score: number, reasons: string[], host: string }}
     */
    scoreUrl(urlString) {
      let url;
      try {
        url = new URL(urlString);
      } catch {
        return { score: 0, reasons: [], host: "" };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { score: 0, reasons: [], host: "" };
      }

      const host = HostKey.normalize(url.hostname);
      const cached = this._cache.get(host + url.pathname.slice(0, 32));
      if (cached) return { ...cached, host };

      const reasons = [];
      let score = 0;

      // Exact allow for major brands (suffix match).
      for (const s of HostKey.suffixes(host)) {
        if (PhishingScorer.#SAFE_SUFFIXES.has(s)) {
          const result = { score: 0, reasons: ["trusted_suffix"], host };
          this._cache.set(host + url.pathname.slice(0, 32), result);
          return result;
        }
      }

      if (url.username || url.password || url.href.includes("@")) {
        score += 50;
        reasons.push("userinfo");
      }

      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
        score += 40;
        reasons.push("ip_host");
      }

      if (host.includes("xn--")) {
        score += 30;
        reasons.push("punycode");
      }

      const labels = host.split(".");
      const tld = labels[labels.length - 1] || "";
      if (PhishingScorer.#BAD_TLDS.has(tld)) {
        score += 20;
        reasons.push("risky_tld");
      }

      const hyphenCount = (host.match(/-/g) || []).length;
      if (hyphenCount >= 3) {
        score += 15;
        reasons.push("many_hyphens");
      }

      const digitRatio = (host.replace(/\D/g, "").length || 0) / Math.max(host.length, 1);
      if (digitRatio > 0.25 && host.length > 8) {
        score += 12;
        reasons.push("digit_heavy");
      }

      // Typosquat: registrable label vs brand dictionary.
      const registrable = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
      const brandHit = PhishingScorer.#closestBrand(registrable);
      if (brandHit && brandHit.distance > 0 && brandHit.distance <= 2) {
        score += brandHit.distance === 1 ? 45 : 30;
        reasons.push(`typosquat:${brandHit.brand}`);
      } else if (brandHit && brandHit.distance === 0) {
        // Brand token used as subdomain of unrelated apex (paypal.evil.tld already handled;
        // paypal-secure.evil.com → label contains brand)
        const apex = labels.slice(-2).join(".");
        if (!PhishingScorer.#SAFE_SUFFIXES.has(apex) && labels.length > 2) {
          score += 35;
          reasons.push(`brand_subdomain:${brandHit.brand}`);
        }
      } else {
        for (const brand of PhishingScorer.#BRANDS) {
          if (registrable.includes(brand) && registrable !== brand) {
            score += 28;
            reasons.push(`brand_embed:${brand}`);
            break;
          }
        }
      }

      const pathQ = `${url.pathname}${url.search}`.toLowerCase();
      if (/(login|signin|verify|secure|account|wallet|password|update|confirm|billing)/i.test(pathQ)) {
        score += 18;
        reasons.push("sensitive_path");
      }

      if (
        /(free.?download|crack|keygen|activator|giveaway|airdrop|claim.?prize|verify.?wallet|seed.?phrase|metamask.?support|crypto.?drain|apk.?download|malware|ransomware)/i.test(
          pathQ
        ) ||
        /(free.?download|crack|keygen|giveaway|airdrop|claim.?prize|verify.?wallet)/i.test(host)
      ) {
        score += 22;
        reasons.push("scam_bait");
      }

      if (/\.(apk|exe|msi|scr|bat|cmd|dmg)(?:$|[?#])/i.test(pathQ)) {
        score += 16;
        reasons.push("risky_payload");
      }

      if (host.length > 45) {
        score += 10;
        reasons.push("long_host");
      }

      score = Math.max(0, Math.min(100, score));
      const result = { score, reasons, host };
      this._cache.set(host + url.pathname.slice(0, 32), { score, reasons });
      return result;
    }

    /**
     * @param {string} label
     * @returns {{ brand: string, distance: number } | null}
     */
    static #closestBrand(label) {
      const raw = String(label || "").toLowerCase();
      if (!raw) return null;
      let best = null;
      for (const brand of PhishingScorer.#BRANDS) {
        const d = EditDistance.levenshtein(raw, brand, 2);
        if (d > 2) continue;
        if (!best || d < best.distance) best = { brand, distance: d };
      }
      return best;
    }
  }

  /**
   * Navigation guard — high-score URLs → extension warning page.
   */
  class PhishingNavigationGuard {
    static THRESHOLD = 55;
    static MALWARE_THRESHOLD = 48;

    /**
     * @param {() => Promise<{ enabled: boolean, features: Record<string, boolean> }>} getStatus
     */
    constructor(getStatus) {
      this._getStatus = getStatus;
      this._scorer = new PhishingScorer();
    }

    /**
     * @param {string} url
     * @returns {Promise<{ block: boolean, score: number, reasons: string[], host: string }>}
     */
    async evaluate(url) {
      const status = await this._getStatus();
      const phishingOn = status.enabled && status.features.phishingGuard !== false;
      const malwareOn = status.enabled && status.features.malwareWarn !== false;
      if (!phishingOn && !malwareOn) {
        return { block: false, score: 0, reasons: [], host: "" };
      }
      const result = this._scorer.scoreUrl(url);
      const malwareHit = (result.reasons || []).some((r) =>
        /scam_bait|risky_payload|typosquat|brand_embed|brand_subdomain|userinfo|ip_host/.test(r)
      );
      let threshold = PhishingNavigationGuard.THRESHOLD;
      if (!phishingOn && malwareOn) threshold = PhishingNavigationGuard.MALWARE_THRESHOLD;
      else if (malwareOn && malwareHit) threshold = PhishingNavigationGuard.MALWARE_THRESHOLD;
      return {
        block: result.score >= threshold,
        score: result.score,
        reasons: result.reasons,
        host: result.host,
      };
    }

    warningUrl(targetUrl, score, reasons) {
      const u = new URL(chrome.runtime.getURL("warning/phishing.html"));
      u.searchParams.set("url", targetUrl);
      u.searchParams.set("score", String(score));
      u.searchParams.set("reasons", reasons.join(","));
      return u.href;
    }
  }

  /**
   * GOSAFE Security / Trust Score — invert phishing risk into Safety 0–100.
   * Local signals only (no WHOIS / remote malware DB).
   */
  class TrustScore {
    static LOW_SAFETY = 45;

    /**
     * @param {string} urlString
     * @param {{ thirdPartyScripts?: number }} [hints]
     */
    static evaluate(urlString, hints = {}) {
      const scorer = new PhishingScorer();
      const risk = scorer.scoreUrl(urlString);
      let url;
      try {
        url = new URL(urlString);
      } catch {
        return {
          host: "",
          safety: 0,
          risk: 100,
          checks: [{ ok: false, label: "Invalid URL" }],
          reasons: ["invalid_url"],
          warn: true,
        };
      }

      const host = risk.host || HostKey.normalize(url.hostname);
      const reasons = risk.reasons || [];
      const httpsOk = url.protocol === "https:";
      const trusted = reasons.includes("trusted_suffix");
      const riskyTld = reasons.includes("risky_tld");
      const malwareish = reasons.some((r) =>
        /scam_bait|risky_payload|typosquat|brand_embed|brand_subdomain|userinfo|ip_host|punycode/.test(
          r
        )
      );
      const thirdParty = Number(hints.thirdPartyScripts) || 0;
      const thirdPartyWarn = thirdParty >= 8;

      let safety = trusted ? 96 : Math.max(0, Math.min(100, 100 - (Number(risk.score) || 0)));
      if (!httpsOk) safety = Math.min(safety, 55);
      if (thirdPartyWarn) safety = Math.max(0, safety - 8);
      if (riskyTld && !trusted) safety = Math.min(safety, safety);

      /** @type {{ ok: boolean, label: string }[]} */
      const checks = [];
      checks.push({
        ok: httpsOk,
        label: httpsOk ? "HTTPS" : "Not using HTTPS",
      });
      checks.push({
        ok: trusted || (!riskyTld && !reasons.includes("digit_heavy")),
        label: trusted
          ? "Known trusted domain"
          : riskyTld
            ? "Risky top-level domain"
            : "Ordinary domain (age unknown — local check only)",
      });
      checks.push({
        ok: !malwareish,
        label: malwareish
          ? "Scam / malware patterns detected"
          : "No local malware / scam signals",
      });
      if (thirdParty > 0) {
        checks.push({
          ok: !thirdPartyWarn,
          label: thirdPartyWarn
            ? `Many third-party scripts (${thirdParty})`
            : `Third-party scripts: ${thirdParty}`,
        });
      }
      if (reasons.includes("sensitive_path")) {
        checks.push({ ok: false, label: "Sensitive path (login / wallet / verify)" });
      }

      return {
        host,
        safety,
        risk: Number(risk.score) || 0,
        checks,
        reasons,
        warn: safety < TrustScore.LOW_SAFETY,
      };
    }

    /**
     * @param {string} targetUrl
     * @param {{ safety: number, reasons: string[], checks?: { ok: boolean, label: string }[] }} report
     */
    static warningUrl(targetUrl, report) {
      const u = new URL(chrome.runtime.getURL("warning/phishing.html"));
      u.searchParams.set("url", targetUrl);
      u.searchParams.set("score", String(100 - (report.safety || 0)));
      u.searchParams.set("safety", String(report.safety || 0));
      u.searchParams.set("mode", "trust");
      const labels = (report.checks || [])
        .filter((c) => !c.ok)
        .map((c) => c.label)
        .concat(report.reasons || []);
      u.searchParams.set("reasons", labels.slice(0, 8).join(","));
      return u.href;
    }
  }

  /**
   * On-demand PhishGuard cloud scan (https://www.phishguard.co.in/developer).
   * Requires the user's free API key — never hardcode one.
   */
  class PhishGuardClient {
    static #PRIMARY = "https://phishguard.in/api/analyze-url";
    static #FALLBACK = "https://www.phishguard.co.in/api/analyze-url";
    static #CACHE_MS = 5 * 60 * 1000;

    constructor() {
      /** @type {LruCache<string, { at: number, result: object }>} */
      this._cache = new LruCache(40);
    }

    /**
     * @param {string} urlString
     * @param {string} apiKey
     * @returns {Promise<{
     *   ok: boolean,
     *   riskLevel?: string,
     *   riskScore?: number,
     *   reasons?: string[],
     *   category?: string,
     *   cached?: boolean,
     *   error?: string
     * }>}
     */
    async scan(urlString, apiKey) {
      const key = String(apiKey || "").trim();
      if (!key) return { ok: false, error: "missing_api_key" };
      let url;
      try {
        url = new URL(urlString);
      } catch {
        return { ok: false, error: "invalid_url" };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, error: "unsupported_scheme" };
      }

      const cacheKey = `${HostKey.normalize(url.hostname)}|${url.pathname.slice(0, 80)}`;
      const hit = this._cache.get(cacheKey);
      if (hit && Date.now() - hit.at < PhishGuardClient.#CACHE_MS) {
        return { ...hit.result, cached: true };
      }

      let lastErr = "network_error";
      for (const endpoint of [PhishGuardClient.#PRIMARY, PhishGuardClient.#FALLBACK]) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": key,
            },
            body: JSON.stringify({ url: url.href }),
          });
          if (res.status === 401 || res.status === 403) {
            return { ok: false, error: "invalid_api_key" };
          }
          if (res.status === 429) {
            return { ok: false, error: "rate_limited" };
          }
          if (!res.ok) {
            lastErr = `http_${res.status}`;
            // Try fallback on 5xx / network-ish failures only once primary fails hard
            if (res.status >= 500) continue;
            return { ok: false, error: lastErr };
          }
          const data = await res.json();
          const result = PhishGuardClient.#normalize(data);
          this._cache.set(cacheKey, { at: Date.now(), result });
          return result;
        } catch (err) {
          lastErr = String(err?.message || err || "network_error");
        }
      }
      return { ok: false, error: lastErr };
    }

    /** @param {any} data */
    static #normalize(data) {
      const raw = data && typeof data === "object" ? data : {};
      const level = String(
        raw.risk_level || raw.riskLevel || raw.verdict || raw.status || ""
      )
        .trim()
        .toUpperCase();
      let score = Number(raw.risk_score ?? raw.riskScore ?? raw.score);
      if (!Number.isFinite(score)) score = -1;

      /** @type {string[]} */
      const reasons = [];
      if (raw.category) reasons.push(String(raw.category));
      const signals = raw.signals || raw.reasons || raw.checks || raw.breakdown;
      if (Array.isArray(signals)) {
        for (const s of signals.slice(0, 8)) {
          if (typeof s === "string") reasons.push(s);
          else if (s && typeof s === "object") {
            const label = s.label || s.name || s.reason || s.signal;
            if (label) reasons.push(String(label));
          }
        }
      } else if (signals && typeof signals === "object") {
        for (const [k, v] of Object.entries(signals).slice(0, 8)) {
          if (v === true || v === 1) reasons.push(k);
          else if (typeof v === "string" && v) reasons.push(`${k}: ${v}`);
        }
      }

      const riskLevel =
        level ||
        (score >= 70 ? "HIGH" : score >= 40 ? "SUSPICIOUS" : score >= 0 ? "SAFE" : "UNKNOWN");

      return {
        ok: true,
        riskLevel,
        riskScore: score >= 0 ? Math.max(0, Math.min(100, Math.round(score))) : undefined,
        category: raw.category ? String(raw.category) : undefined,
        reasons,
      };
    }
  }

  globalThis.AblPhishing = {
    PhishingScorer,
    PhishingNavigationGuard,
    TrustScore,
    PhishGuardClient,
  };
})();
