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
        const brandHit = PageSecurityScanner.#closestBrand(host);
        if (brandHit && brandHit.distance > 0 && brandHit.distance <= 2) {
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
        } else if ([...actionHosts].some((h) => h && h !== host && !host.endsWith(`.${h}`) && !h.endsWith(`.${host}`))) {
          watch.push({
            level: "warn",
            title: "Login form posts off-site",
            detail: `Form may send credentials to ${[...actionHosts].join(", ")}`,
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

    static #closestBrand(host) {
      const label = String(host || "").split(".")[0] || "";
      let best = null;
      for (const brand of PageSecurityScanner.#BRANDS) {
        if (label === brand) return { brand, distance: 0 };
        const d = PageSecurityScanner.#lev(label, brand, 2);
        if (d > 2) continue;
        if (!best || d < best.distance) best = { brand, distance: d };
      }
      // brand embedded: paypal-secure.evil.com style on registrable
      const registrable = host.split(".").slice(-2, -1)[0] || label;
      for (const brand of PageSecurityScanner.#BRANDS) {
        if (registrable.includes(brand) && registrable !== brand) {
          return { brand, distance: 1 };
        }
      }
      return best;
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "scanSecurityPage") return false;
    try {
      sendResponse({ ok: true, report: PageSecurityScanner.scan() });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false;
  });
})();
