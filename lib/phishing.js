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

    /** Distilled from saidutta69/PhishTrap (see scripts/build_phishtrap_signals.py). */
    static #trap() {
      return globalThis.AblPhishTrap || null;
    }

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

      score += PhishingScorer.#phishTrapBonus(url, host, tld, labels, reasons);

      score = Math.max(0, Math.min(100, score));
      const result = { score, reasons, host };
      this._cache.set(host + url.pathname.slice(0, 32), { score, reasons });
      return result;
    }

    /**
     * Extra points from PhishTrap-distilled thresholds (URL features only).
     * @param {URL} url
     * @param {string} host
     * @param {string} tld
     * @param {string[]} labels
     * @param {string[]} reasons
     */
    static #phishTrapBonus(url, host, tld, labels, reasons) {
      const trap = PhishingScorer.#trap();
      if (!trap?.thresholds || !trap?.weights) return 0;
      const th = trap.thresholds;
      const w = trap.weights;
      let bonus = 0;

      const entropy = PhishingScorer.#shannon(host);
      if (entropy >= Number(th.entropy_ge || 99)) {
        bonus += Number(w.entropy_ge) || 0;
        reasons.push("pt_entropy");
      }
      const hyphens = (host.match(/-/g) || []).length;
      if (hyphens >= Number(th.hyphen_count_ge || 99)) {
        bonus += Number(w.hyphen_count_ge) || 0;
        reasons.push("pt_hyphens");
      }
      const subdomains = Math.max(0, labels.length - 2);
      if (subdomains >= Number(th.subdomain_count_ge || 99)) {
        bonus += Number(w.subdomain_count_ge) || 0;
        reasons.push("pt_subdomains");
      }
      if (host.length >= Number(th.domain_length_ge || 999)) {
        bonus += Number(w.domain_length_ge) || 0;
        reasons.push("pt_domain_len");
      }
      if (url.href.length >= Number(th.url_length_ge || 9999)) {
        bonus += Number(w.url_length_ge) || 0;
        reasons.push("pt_url_len");
      }
      const pathDepth = url.pathname.split("/").filter(Boolean).length;
      if (pathDepth >= Number(th.path_depth_ge || 99)) {
        bonus += Number(w.path_depth_ge) || 0;
        reasons.push("pt_path_depth");
      }
      const qCount = [...url.searchParams.keys()].length;
      if (qCount >= Number(th.query_param_count_ge || 99)) {
        bonus += Number(w.query_param_count_ge) || 0;
        reasons.push("pt_query");
      }
      const specials = (url.href.match(/[^a-zA-Z0-9:\/\.\-_]/g) || []).length;
      if (specials >= Number(th.special_char_count_ge || 99)) {
        bonus += Number(w.special_char_count_ge) || 0;
        reasons.push("pt_specials");
      }
      const digits = (host.match(/\d/g) || []).length;
      if (digits >= Number(th.digit_count_ge || 99)) {
        bonus += Number(w.digit_count_ge) || 0;
        reasons.push("pt_digits");
      }
      if (tld.length >= Number(th.tld_length_ge || 99)) {
        bonus += Number(w.tld_length_ge) || 0;
        reasons.push("pt_tld_len");
      }
      if (url.href.includes("://") && url.href.indexOf("//", 8) !== -1) {
        bonus += Number(w.has_double_slash_redirect) || 0;
        reasons.push("pt_dbl_slash");
      }
      const risky = Array.isArray(trap.risky_tlds) ? trap.risky_tlds : [];
      if (risky.includes(tld) && !PhishingScorer.#BAD_TLDS.has(tld)) {
        bonus += 12;
        reasons.push("pt_risky_tld");
      }

      // Cap so PhishTrap cannot dominate brand/path heuristics alone.
      return Math.min(35, bonus);
    }

    /** @param {string} s */
    static #shannon(s) {
      const raw = String(s || "");
      if (!raw) return 0;
      const freq = new Map();
      for (const ch of raw) freq.set(ch, (freq.get(ch) || 0) + 1);
      let h = 0;
      const n = raw.length;
      for (const c of freq.values()) {
        const p = c / n;
        h -= p * Math.log2(p);
      }
      return h;
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
   * Optionally short-circuits on live supplemental feed hits (list updater).
   */
  class PhishingNavigationGuard {
    static THRESHOLD = 55;
    static MALWARE_THRESHOLD = 48;

    /**
     * @param {() => Promise<{ enabled: boolean, features: Record<string, boolean> }>} getStatus
     * @param {(host: string) => "phishing_feed" | "nrd" | null} [listLookup]
     */
    constructor(getStatus, listLookup = null) {
      this._getStatus = getStatus;
      this._listLookup = typeof listLookup === "function" ? listLookup : null;
      this._scorer = new PhishingScorer();
    }

    /**
     * @param {string} url
     * @returns {Promise<{ block: boolean, score: number, reasons: string[], host: string, listHit?: string|null }>}
     */
    async evaluate(url) {
      const status = await this._getStatus();
      const phishingOn = status.enabled && status.features.phishingGuard !== false;
      const malwareOn = status.enabled && status.features.malwareWarn !== false;
      if (!phishingOn && !malwareOn) {
        return { block: false, score: 0, reasons: [], host: "", listHit: null };
      }

      const result = this._scorer.scoreUrl(url);
      const host = result.host || "";
      const listHit =
        phishingOn && this._listLookup && host ? this._listLookup(host) : null;

      if (listHit === "phishing_feed") {
        return {
          block: true,
          score: Math.max(result.score, 95),
          reasons: ["list:phishing_feed", ...(result.reasons || [])],
          host,
          listHit,
        };
      }
      if (listHit === "nrd" && (phishingOn || malwareOn)) {
        const reasons = ["list:nrd", ...(result.reasons || [])];
        const score = Math.max(result.score, 70);
        return {
          block: score >= PhishingNavigationGuard.MALWARE_THRESHOLD,
          score,
          reasons,
          host,
          listHit,
        };
      }

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
        host,
        listHit: null,
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
   * Local signals + optional live-list / page hints (no WHOIS / remote malware DB).
   */
  class TrustScore {
    static LOW_SAFETY = 45;

    /**
     * @param {string} urlString
     * @param {{ thirdPartyScripts?: number, listHit?: string|null }} [hints]
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
          reasonLabels: ["Invalid URL"],
          verdict: "block",
          warn: true,
          listHit: null,
        };
      }

      const host = risk.host || HostKey.normalize(url.hostname);
      const reasons = [...(risk.reasons || [])];
      const listHit = hints.listHit || null;
      if (listHit === "phishing_feed" && !reasons.includes("list:phishing_feed")) {
        reasons.unshift("list:phishing_feed");
      } else if (listHit === "nrd" && !reasons.includes("list:nrd")) {
        reasons.unshift("list:nrd");
      }

      const httpsOk = url.protocol === "https:";
      const trusted = reasons.includes("trusted_suffix") && !listHit;
      const riskyTld = reasons.includes("risky_tld");
      const malwareish =
        Boolean(listHit) ||
        reasons.some((r) =>
          /scam_bait|risky_payload|typosquat|brand_embed|brand_subdomain|userinfo|ip_host|punycode|list:/.test(
            r
          )
        );
      const thirdParty = Number(hints.thirdPartyScripts) || 0;
      const thirdPartyWarn = thirdParty >= 8;

      let safety = trusted ? 96 : Math.max(0, Math.min(100, 100 - (Number(risk.score) || 0)));
      if (listHit === "phishing_feed") safety = Math.min(safety, 12);
      else if (listHit === "nrd") safety = Math.min(safety, 35);
      if (!httpsOk) safety = Math.min(safety, 55);
      if (thirdPartyWarn) safety = Math.max(0, safety - 8);

      /** @type {{ ok: boolean, label: string }[]} */
      const checks = [];
      checks.push({
        ok: httpsOk,
        label: httpsOk ? "HTTPS" : "Not using HTTPS",
      });
      checks.push({
        ok: trusted || (!riskyTld && !reasons.includes("digit_heavy") && !listHit),
        label: listHit
          ? listHit === "phishing_feed"
            ? "Listed on live phishing feed"
            : "Listed on newly-registered domain feed"
          : trusted
            ? "Known trusted domain"
            : riskyTld
              ? "Risky top-level domain"
              : "Ordinary domain (age unknown — local check only)",
      });
      checks.push({
        ok: !malwareish,
        label: malwareish
          ? "Scam / malware / list signals detected"
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

      const verdict =
        safety >= 75 ? "safe" : safety >= TrustScore.LOW_SAFETY ? "caution" : "block";
      const reasonLabels = TrustScore.#labelReasons(reasons);

      return {
        host,
        safety,
        risk: Number(risk.score) || 0,
        checks,
        reasons,
        reasonLabels,
        verdict,
        warn: safety < TrustScore.LOW_SAFETY,
        listHit,
      };
    }

    /** @param {string[]} reasons */
    static #labelReasons(reasons) {
      const map = {
        trusted_suffix: "Known trusted domain",
        userinfo: "Credentials embedded in URL",
        ip_host: "Raw IP address host",
        punycode: "Internationalized (punycode) host",
        risky_tld: "Risky top-level domain",
        many_hyphens: "Many hyphens in hostname",
        digit_heavy: "Digit-heavy hostname",
        sensitive_path: "Login / verify / wallet path",
        scam_bait: "Scam / giveaway bait wording",
        risky_payload: "Risky file download path",
        long_host: "Unusually long hostname",
        "list:phishing_feed": "Live phishing / malware feed hit",
        "list:nrd": "Newly registered domain feed hit",
        pt_entropy: "High domain entropy (PhishTrap)",
        pt_hyphens: "Hyphen pattern (PhishTrap)",
        pt_subdomains: "Deep subdomains (PhishTrap)",
        pt_domain_len: "Long domain (PhishTrap)",
        pt_url_len: "Long URL (PhishTrap)",
        pt_path_depth: "Deep path (PhishTrap)",
        pt_query: "Many query params (PhishTrap)",
        pt_specials: "Special characters (PhishTrap)",
        pt_digits: "Many digits (PhishTrap)",
        pt_tld_len: "Odd TLD length (PhishTrap)",
        pt_dbl_slash: "Double-slash redirect pattern",
        pt_risky_tld: "PhishTrap risky TLD",
        invalid_url: "Invalid URL",
        site_block: "Blocked by site rule",
      };
      const out = [];
      for (const r of reasons || []) {
        if (map[r]) {
          out.push(map[r]);
          continue;
        }
        if (r.startsWith("typosquat:")) out.push(`Possible typosquat of ${r.slice(10)}`);
        else if (r.startsWith("brand_subdomain:")) out.push(`Brand as subdomain: ${r.slice(16)}`);
        else if (r.startsWith("brand_embed:")) out.push(`Brand embedded in name: ${r.slice(12)}`);
        else out.push(r);
      }
      return out;
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
        .slice(0, 6);
      if (labels.length) u.searchParams.set("reasons", labels.join(" · "));
      else if (report.reasons?.length) u.searchParams.set("reasons", report.reasons.join(","));
      return u.href;
    }
  }

  globalThis.AblPhishing = { PhishingScorer, PhishingNavigationGuard, TrustScore };
})();
