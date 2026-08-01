(() => {
  "use strict";

  /**
   * Isolated-world page security scan — forms, brand bait, XSS hints, secrets, third parties.
   */
  class PageSecurityScanner {
    static #BRANDS = Object.freeze([
      "paypal",
      "google",
      "gmail",
      "apple",
      "icloud",
      "microsoft",
      "outlook",
      "amazon",
      "facebook",
      "instagram",
      "netflix",
      "binance",
      "coinbase",
      "metamask",
      "chase",
      "wellsfargo",
      "steam",
      "discord",
    ]);

    static #SOCIAL =
      /verify (your )?account|confirm (your )?identity|unusual (sign-?in|activity)|suspend(ed)? (your )?account|click here (immediately|now)|update (your )?payment|seed phrase|recovery phrase|wallet connect|limited time|act now|password.*(expire|reset)/i;

    static #SECRET =
      /(?:AIza[0-9A-Za-z_-]{20,}|sk_live_[0-9a-zA-Z]{20,}|sk_test_[0-9a-zA-Z]{20,}|AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{30,}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN (?:RSA )?PRIVATE KEY-----)/g;

    static #XSS_HINT =
      /javascript:|onerror\s*=|onload\s*=|document\.cookie|eval\s*\(|\.innerHTML\s*=|fromCharCode\s*\(/i;

    static hostname() {
      return (location.hostname || "").replace(/^www\./, "").toLowerCase();
    }

    static scan() {
      const host = PageSecurityScanner.hostname();
      const watch = [];
      const attacks = [];
      const developer = [];
      const https = location.protocol === "https:";

      // Password forms / fake login
      const forms = [...document.querySelectorAll("form")];
      const passwordInputs = [...document.querySelectorAll('input[type="password"]')];
      if (passwordInputs.length) {
        const actionHosts = new Set();
        for (const form of forms) {
          try {
            const action = form.getAttribute("action") || location.href;
            const u = new URL(action, location.href);
            actionHosts.add(u.hostname.replace(/^www\./, "").toLowerCase());
          } catch {
            // ignore
          }
        }
        const academic = PageSecurityScanner.#isAcademicHost(host);
        const brandHit = academic ? null : PageSecurityScanner.#closestBrandStrict(host);
        if (brandHit && brandHit.distance === 1) {
          watch.push({
            level: "bad",
            title: `You are about to enter a fake login page`,
            detail: `The design / host copies ${brandHit.brand}. Do not enter your password.`,
          });
        } else if (!https) {
          watch.push({
            level: "bad",
            title: "Password field on an insecure page",
            detail: "This page uses HTTP. Do not enter credentials.",
          });
        } else if (
          [...actionHosts].some(
            (h) => h && h !== host && !host.endsWith(`.${h}`) && !h.endsWith(`.${host}`)
          )
        ) {
          watch.push({
            level: "warn",
            title: "Login form posts off-site",
            detail: `Form may send credentials to ${[...actionHosts].join(", ")}`,
          });
        } else if (academic) {
          watch.push({
            level: "ok",
            title: "School / LMS login",
            detail: "Education host over HTTPS — looks safe to fill.",
          });
        } else {
          watch.push({
            level: "ok",
            title: "Login form detected",
            detail: "HTTPS looks fine — still verify the address bar brand.",
          });
        }
      }

      // Social engineering copy
      const bodyText = (document.body?.innerText || "").slice(0, 12000);
      if (PageSecurityScanner.#SOCIAL.test(bodyText)) {
        watch.push({
          level: "warn",
          title: "Social-engineering language on page",
          detail: "Urgency / verify-account wording often used in phishing.",
        });
      }

      // Fake browser update
      if (
        /update (your )?browser|chrome is out of date|download.*chrome.*(exe|dmg)|your flash player|install this extension to continue/i.test(
          bodyText
        )
      ) {
        attacks.push({
          level: "bad",
          title: "Fake browser / extension update lure",
          detail: "Page urges a browser update or extension install — treat as hostile.",
        });
      }

      // Suspicious inline / javascript: links
      let xssHits = 0;
      for (const a of document.querySelectorAll("a[href^='javascript:']")) {
        xssHits += 1;
        if (xssHits <= 3) {
          attacks.push({
            level: "warn",
            title: "javascript: link found",
            detail: (a.getAttribute("href") || "").slice(0, 120),
          });
        }
      }
      for (const el of document.querySelectorAll("[onclick], [onerror], [onload]")) {
        const blob = `${el.getAttribute("onclick") || ""}${el.getAttribute("onerror") || ""}`;
        if (PageSecurityScanner.#XSS_HINT.test(blob)) {
          xssHits += 1;
          if (xssHits <= 5) {
            attacks.push({
              level: "warn",
              title: "Suspicious inline handler",
              detail: blob.slice(0, 120),
            });
          }
        }
      }

      // Scripts + drive-by hints
      const thirdParty = [];
      const seenTp = new Set();
      for (const s of document.querySelectorAll("script[src]")) {
        const src = s.src || "";
        try {
          const u = new URL(src, location.href);
          const h = u.hostname.replace(/^www\./, "").toLowerCase();
          if (h && h !== host && !h.endsWith(`.${host}`)) {
            if (!seenTp.has(h)) {
              seenTp.add(h);
              thirdParty.push(h);
            }
          }
          if (/\.(exe|msi|dmg|apk|scr|bat)(?:$|[?#])/i.test(u.pathname)) {
            attacks.push({
              level: "bad",
              title: "Suspicious script execution",
              detail: "This script URL attempts to download an executable file.",
            });
          }
          if (/coinhive|cryptoloot|webmine|miner|authedmine|jsecoin/i.test(h + u.pathname)) {
            attacks.push({
              level: "bad",
              title: "Cryptojacking script pattern",
              detail: src.slice(0, 140),
            });
          }
        } catch {
          // ignore
        }
      }

      // Developer: secrets in HTML
      const html = document.documentElement?.innerHTML?.slice(0, 400000) || "";
      const secrets = html.match(PageSecurityScanner.#SECRET) || [];
      const uniqueSecrets = [...new Set(secrets)].slice(0, 8);
      for (const secret of uniqueSecrets) {
        const kind = /^AIza/.test(secret)
          ? "Google / Firebase-style API key"
          : /^sk_/.test(secret)
            ? "Stripe secret key"
            : /^AKIA/.test(secret)
              ? "AWS access key"
              : /PRIVATE KEY/.test(secret)
                ? "Private key material"
                : "Exposed secret";
        developer.push({
          level: "bad",
          title: `${kind} exposed`,
          detail: `${secret.slice(0, 12)}… visible in page source`,
        });
      }

      // CSP meta
      const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
      if (!cspMeta) {
        developer.push({
          level: "warn",
          title: "No CSP meta tag",
          detail: "A Content-Security-Policy header may still exist — meta CSP not found.",
        });
      } else {
        developer.push({
          level: "ok",
          title: "CSP meta present",
          detail: (cspMeta.getAttribute("content") || "").slice(0, 120),
        });
      }

      // Cookies (non-HttpOnly only)
      const cookies = (document.cookie || "")
        .split(";")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cookies.length) {
        const weak = cookies.filter((c) => !/secure|httponly|samesite/i.test(c));
        developer.push({
          level: weak.length ? "warn" : "ok",
          title: `${cookies.length} readable cookie(s)`,
          detail: weak.length
            ? "Some cookies are visible to page JS (HttpOnly not set for these)."
            : "Cookie names visible to scripts.",
        });
      }

      for (const h of thirdParty.slice(0, 20)) {
        developer.push({
          level: "ok",
          title: `Third-party script · ${h}`,
          detail: "Loaded from another origin",
        });
      }

      if (!https) {
        developer.push({
          level: "bad",
          title: "Insecure transport",
          detail: "Page is not HTTPS",
        });
      }

      return {
        host,
        url: location.href,
        https,
        watch,
        attacks,
        developer,
        thirdPartyCount: thirdParty.length,
        passwordFields: passwordInputs.length,
        formCount: forms.length,
      };
    }

    static #isAcademicHost(host) {
      const h = String(host || "").toLowerCase();
      if (/\.(edu|ac)(\.[a-z]{2,3})?$/i.test(h) || /\.edu\.[a-z]{2,3}$/i.test(h)) return true;
      if (/^(moodle|canvas|blackboard|brightspace|schoology|classroom|elearning|lms)\./i.test(h)) {
        return true;
      }
      return /moodle|elearning|canvas|blackboard|university|campus|\.edu\./i.test(h);
    }

    /**
     * Stricter than raw Levenshtein-2 (moodle≈google was a false positive).
     * @param {string} host
     */
    static #closestBrandStrict(host) {
      const label = String(host || "").split(".")[0] || "";
      if (!label || label.length < 4) return null;
      let best = null;
      for (const brand of PageSecurityScanner.#BRANDS) {
        const d = PageSecurityScanner.#lev(label, brand, 2);
        if (d > 2) continue;
        if (d === 0) return { brand, distance: 0 };
        if (d === 1) {
          if (!best || d < best.distance) best = { brand, distance: d };
          continue;
        }
        // d === 2: require 3-char shared affix (blocks moodle↔google on "le")
        if (
          Math.abs(label.length - brand.length) <= 1 &&
          (label.slice(0, 3) === brand.slice(0, 3) || label.slice(-3) === brand.slice(-3))
        ) {
          if (!best || d < best.distance) best = { brand, distance: d };
        }
      }
      return best;
    }

    static #closestBrand(host) {
      return PageSecurityScanner.#closestBrandStrict(host);
    }

    static #lev(a, b, max = 2) {
      if (Math.abs(a.length - b.length) > max) return max + 1;
      const m = a.length;
      const n = b.length;
      const prev = new Uint16Array(n + 1);
      const cur = new Uint16Array(n + 1);
      for (let j = 0; j <= n; j += 1) prev[j] = j;
      for (let i = 1; i <= m; i += 1) {
        cur[0] = i;
        let rowMin = cur[0];
        for (let j = 1; j <= n; j += 1) {
          const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
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
   * Floating GOSAFE badge near password fields (does NOT wrap inputs — SPA-safe).
   */
  class LoginSafeBadge {
    static #ATTR = "data-gosafe-login-badge";
    static #STYLE_ID = "gosafe-login-badge-css";
    static #LAYER_ID = "gosafe-login-badge-layer";
    static #SAFE = 75;
    /** @type {WeakMap<HTMLInputElement, HTMLElement>} */
    static #map = new WeakMap();
    /** @type {Set<HTMLInputElement>} */
    static #tracked = new Set();

    static async #extensionOn() {
      try {
        const status = await chrome.runtime.sendMessage({ type: "getStatus" });
        if (!status || status.enabled === false) return false;
        if (status.features && status.features.trustScore === false) return false;
        return true;
      } catch {
        // Fall back to DOM flag if messaging fails
        const root = document.documentElement;
        return root?.getAttribute("data-adblock-lite") !== "off";
      }
    }

    static #injectCss() {
      if (document.getElementById(LoginSafeBadge.#STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = LoginSafeBadge.#STYLE_ID;
      style.textContent = `
#${LoginSafeBadge.#LAYER_ID} {
  position: fixed !important;
  inset: 0 !important;
  width: 0 !important;
  height: 0 !important;
  overflow: visible !important;
  z-index: 2147483646 !important;
  pointer-events: none !important;
}
.gosafe-login-badge {
  position: fixed !important;
  z-index: 2147483647 !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: 5px !important;
  max-width: 200px !important;
  padding: 4px 9px 4px 5px !important;
  border-radius: 999px !important;
  font: 600 11px/1.2 system-ui, Segoe UI, sans-serif !important;
  letter-spacing: 0.01em !important;
  box-shadow: 0 4px 14px rgba(0,0,0,.16) !important;
  pointer-events: auto !important;
  cursor: default !important;
  user-select: none !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
.gosafe-login-badge img {
  width: 16px !important;
  height: 16px !important;
  border-radius: 4px !important;
  flex: 0 0 auto !important;
}
.gosafe-login-badge.is-safe {
  background: #ecf8ef !important;
  color: #146c2e !important;
  border: 1px solid #b7e0c2 !important;
}
.gosafe-login-badge.is-warn {
  background: #fff6e5 !important;
  color: #8a5a00 !important;
  border: 1px solid #f0d59a !important;
}
.gosafe-login-badge.is-bad {
  background: #fdecea !important;
  color: #8f1d1d !important;
  border: 1px solid #f0b4b4 !important;
}
`.trim();
      (document.documentElement || document.head).appendChild(style);
    }

    static #layer() {
      let layer = document.getElementById(LoginSafeBadge.#LAYER_ID);
      if (!(layer instanceof HTMLElement)) {
        layer = document.createElement("div");
        layer.id = LoginSafeBadge.#LAYER_ID;
        (document.documentElement || document.body).appendChild(layer);
      }
      return layer;
    }

    static #findPasswordInputs() {
      const nodes = document.querySelectorAll(
        'input[type="password"], input[name="pass" i], input[name="password" i], input[autocomplete="current-password"], input[autocomplete="new-password"]'
      );
      /** @type {HTMLInputElement[]} */
      const out = [];
      for (const el of nodes) {
        if (!(el instanceof HTMLInputElement)) continue;
        if (el.disabled) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 12) continue;
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        // Visible enough (opacity/visibility)
        try {
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) {
            continue;
          }
        } catch {
          // keep
        }
        out.push(el);
      }
      return out;
    }

    static #localVerdict(scan) {
      if (!scan?.https) return { level: "bad", label: "Not secure", weight: 90 };
      const bad = [...(scan.watch || []), ...(scan.attacks || [])].filter(
        (x) => x.level === "bad"
      );
      if (bad.length) {
        return { level: "bad", label: "Do not fill", weight: 85 };
      }
      const warn = [...(scan.watch || []), ...(scan.attacks || [])].filter(
        (x) => x.level === "warn"
      );
      if (warn.length) {
        return { level: "warn", label: "Check URL", weight: 40 };
      }
      return { level: "safe", label: "Safe to fill", weight: 15 };
    }

    /**
     * @param {{ level: string, label: string, weight: number }} local
     * @param {any} trust
     */
    static #mergeVerdict(local, trust) {
      if (trust?.disabled) {
        return { level: local.level, label: local.label, safety: undefined };
      }
      const safety = Number(trust?.safety);
      const hasTrust = Boolean(trust?.ok && Number.isFinite(safety));

      if (local?.level === "bad") {
        if (hasTrust && safety >= 75 && trust.verdict === "safe") {
          return { level: "safe", label: "Safe to fill", safety };
        }
        return { level: "bad", label: local.label || "Do not fill", safety };
      }
      if (!hasTrust) {
        return { level: local.level, label: local.label, safety: undefined };
      }
      // Known brand / trusted suffix → always prefer safe when HTTPS
      if (trust.verdict === "safe" && safety >= 75) {
        return { level: "safe", label: "Safe to fill", safety };
      }
      if (trust.verdict === "block" || safety < 45) {
        return { level: "bad", label: "Do not fill", safety };
      }
      if (trust.verdict === "caution" || safety < LoginSafeBadge.#SAFE || local.level === "warn") {
        return { level: "warn", label: "Check URL", safety };
      }
      return { level: "safe", label: "Safe to fill", safety };
    }

    /**
     * @param {HTMLInputElement} input
     * @param {{ level: string, label: string, safety?: number }} verdict
     */
    static #mount(input, verdict) {
      LoginSafeBadge.#injectCss();
      const layer = LoginSafeBadge.#layer();
      let badge = LoginSafeBadge.#map.get(input);
      if (!(badge instanceof HTMLElement) || !badge.isConnected) {
        badge = document.createElement("div");
        badge.className = "gosafe-login-badge";
        badge.setAttribute(LoginSafeBadge.#ATTR, "1");
        badge.setAttribute("role", "status");
        const img = document.createElement("img");
        img.alt = "GOSAFE";
        img.width = 16;
        img.height = 16;
        img.src = chrome.runtime.getURL("icons/icon32.png");
        const text = document.createElement("span");
        text.className = "gosafe-login-badge-text";
        badge.append(img, text);
        layer.appendChild(badge);
        LoginSafeBadge.#map.set(input, badge);
      }
      LoginSafeBadge.#tracked.add(input);

      badge.classList.remove("is-safe", "is-warn", "is-bad");
      const level = verdict.level === "safe" ? "safe" : verdict.level === "warn" ? "warn" : "bad";
      badge.classList.add(`is-${level}`);
      const label = badge.querySelector(".gosafe-login-badge-text");
      if (label) {
        const score =
          typeof verdict.safety === "number" && verdict.level === "safe"
            ? ` · ${Math.round(verdict.safety)}`
            : "";
        label.textContent = `${verdict.label}${score}`;
      }
      badge.title =
        verdict.level === "safe"
          ? "GOSAFE: this login page looks safe to fill (still check the address bar)."
          : verdict.level === "warn"
            ? "GOSAFE: be careful — verify the site address before entering your password."
            : "GOSAFE: do not enter your password on this page.";

      LoginSafeBadge.#place(input, badge);
    }

    /**
     * @param {HTMLInputElement} input
     * @param {HTMLElement} badge
     */
    static #place(input, badge) {
      const r = input.getBoundingClientRect();
      // Sit just inside the right edge of the password field
      const top = Math.round(r.top + r.height / 2);
      badge.style.top = `${top}px`;
      badge.style.transform = "translateY(-50%)";
      // Measure after text set
      const bw = badge.offsetWidth || 110;
      let left = Math.round(r.right - bw - 8);
      if (left < r.left + 8) left = Math.round(r.left + 8);
      if (left + bw > window.innerWidth - 4) {
        left = Math.max(4, window.innerWidth - bw - 4);
      }
      badge.style.left = `${left}px`;
      badge.style.display = r.width > 0 ? "inline-flex" : "none";
    }

    static #repositionAll() {
      for (const input of [...LoginSafeBadge.#tracked]) {
        if (!input.isConnected) {
          LoginSafeBadge.#tracked.delete(input);
          const b = LoginSafeBadge.#map.get(input);
          b?.remove();
          continue;
        }
        const badge = LoginSafeBadge.#map.get(input);
        if (badge) LoginSafeBadge.#place(input, badge);
      }
    }

    static #clearAll() {
      for (const el of document.querySelectorAll(`[${LoginSafeBadge.#ATTR}]`)) {
        el.remove();
      }
      LoginSafeBadge.#tracked.clear();
    }

    static async refresh() {
      if (!(await LoginSafeBadge.#extensionOn())) {
        LoginSafeBadge.#clearAll();
        return;
      }
      const passwords = LoginSafeBadge.#findPasswordInputs();
      if (!passwords.length) {
        LoginSafeBadge.#clearAll();
        return;
      }

      let scan;
      try {
        scan = PageSecurityScanner.scan();
      } catch {
        scan = { https: location.protocol === "https:", watch: [], attacks: [] };
      }
      const local = LoginSafeBadge.#localVerdict(scan);

      let trust = null;
      try {
        trust = await chrome.runtime.sendMessage({
          type: "getTrustScore",
          url: location.href.split("#")[0],
          thirdPartyScripts: Number(scan.thirdPartyCount) || 0,
        });
      } catch {
        trust = null;
      }

      if (trust?.disabled) {
        LoginSafeBadge.#clearAll();
        return;
      }

      const verdict = LoginSafeBadge.#mergeVerdict(local, trust);
      const keep = new Set(passwords);
      for (const input of [...LoginSafeBadge.#tracked]) {
        if (!keep.has(input)) {
          LoginSafeBadge.#tracked.delete(input);
          LoginSafeBadge.#map.get(input)?.remove();
        }
      }
      for (const input of passwords) {
        LoginSafeBadge.#mount(input, verdict);
      }
    }

    static start() {
      let scheduled = false;
      const run = () => {
        LoginSafeBadge.refresh().catch(() => {});
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          run();
        });
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, { once: true });
      } else {
        run();
      }
      window.addEventListener("load", run, { once: true });
      window.addEventListener("scroll", () => LoginSafeBadge.#repositionAll(), true);
      window.addEventListener("resize", () => LoginSafeBadge.#repositionAll());
      setInterval(run, 2000);
      try {
        new MutationObserver(schedule).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      } catch {
        // ignore
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "scanSecurityPage") return false;
    try {
      sendResponse({ ok: true, report: PageSecurityScanner.scan() });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false;
  });

  LoginSafeBadge.start();
})();
