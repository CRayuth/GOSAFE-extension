(() => {
  "use strict";

  /**
   * Local page technology probe — no secrets, no form values, no storage values.
   * Used as input for GOSAFE AI page analysis.
   */
  class PageTechProbe {
    static collect() {
      const url = String(location.href || "");
      const host = (location.hostname || "").replace(/^www\./, "").toLowerCase();
      const title = String(document.title || "").slice(0, 180);
      const meta = PageTechProbe.#meta();
      const scripts = PageTechProbe.#scripts(host);
      const links = PageTechProbe.#stylesheetHosts(host);
      const globals = PageTechProbe.#clientGlobals();
      const markers = PageTechProbe.#domMarkers();
      const forms = PageTechProbe.#forms();
      const resources = PageTechProbe.#resourceHosts(host);
      const security = PageTechProbe.#securityHints();

      return {
        url: url.slice(0, 500),
        host,
        title,
        protocol: location.protocol,
        meta,
        clientSignals: globals,
        domMarkers: markers,
        scripts: scripts.slice(0, 40),
        stylesheetHosts: links.slice(0, 20),
        thirdPartyHosts: resources.thirdParty.slice(0, 40),
        cdnHints: resources.cdnHints.slice(0, 20),
        forms,
        security,
        counts: {
          scripts: document.scripts.length,
          iframes: document.querySelectorAll("iframe").length,
          images: document.images.length,
          links: document.links.length,
          cookies: (() => {
            try {
              return document.cookie ? document.cookie.split(";").length : 0;
            } catch {
              return 0;
            }
          })(),
        },
        collectedAt: Date.now(),
      };
    }

    static #meta() {
      const get = (sel, attr = "content") =>
        String(document.querySelector(sel)?.getAttribute(attr) || "").slice(0, 200);
      return {
        generator: get('meta[name="generator" i]'),
        applicationName: get('meta[name="application-name" i]'),
        framework: get('meta[name="framework" i]'),
        viewport: get('meta[name="viewport" i]'),
        description: get('meta[name="description" i]').slice(0, 240),
        ogSiteName: get('meta[property="og:site_name" i]'),
        ogType: get('meta[property="og:type" i]'),
        twitterCard: get('meta[name="twitter:card" i]'),
        themeColor: get('meta[name="theme-color" i]'),
        robots: get('meta[name="robots" i]'),
        htmlLang: String(document.documentElement?.lang || "").slice(0, 32),
        charset: document.characterSet || "",
      };
    }

    static #scripts(pageHost) {
      const out = [];
      for (const s of document.querySelectorAll("script[src]")) {
        try {
          const u = new URL(s.src, location.href);
          const h = u.hostname.replace(/^www\./, "").toLowerCase();
          out.push({
            host: h,
            path: u.pathname.slice(0, 120),
            thirdParty: Boolean(h && h !== pageHost && !h.endsWith(`.${pageHost}`)),
            async: s.async,
            defer: s.defer,
            type: String(s.type || "").slice(0, 40),
          });
        } catch {
          // ignore
        }
        if (out.length >= 50) break;
      }
      return out;
    }

    static #stylesheetHosts(pageHost) {
      const hosts = new Set();
      for (const l of document.querySelectorAll('link[rel~="stylesheet" i][href]')) {
        try {
          const h = new URL(l.href, location.href).hostname.replace(/^www\./, "").toLowerCase();
          if (h && (h !== pageHost || true)) hosts.add(h);
        } catch {
          // ignore
        }
      }
      return [...hosts];
    }

    static #clientGlobals() {
      const g = typeof window !== "undefined" ? window : {};
      const has = (k) => {
        try {
          return k in g;
        } catch {
          return false;
        }
      };
      const hits = [];
      const map = [
        ["React", "React"],
        ["ReactDOM", "ReactDOM"],
        ["__NEXT_DATA__", "Next.js"],
        ["next", "Next.js"],
        ["__NUXT__", "Nuxt"],
        ["Vue", "Vue"],
        ["angular", "Angular"],
        ["ng", "Angular"],
        ["Ember", "Ember"],
        ["Backbone", "Backbone"],
        ["jQuery", "jQuery"],
        ["$", "jQuery/$"],
        ["Shopify", "Shopify"],
        ["Webflow", "Webflow"],
        ["__webpack_require__", "Webpack"],
        ["webpackChunk", "Webpack"],
        ["parcelRequire", "Parcel"],
        ["__SENTRY__", "Sentry"],
        ["gtag", "Google Analytics / gtag"],
        ["ga", "Google Analytics"],
        ["dataLayer", "GTM / dataLayer"],
        ["fbq", "Meta Pixel"],
        ["ttq", "TikTok Pixel"],
        ["analytics", "analytics global"],
        ["Stripe", "Stripe"],
        ["paypal", "PayPal"],
        ["Intercom", "Intercom"],
        ["__CF$cv$params", "Cloudflare"],
        ["Turnstile", "Cloudflare Turnstile"],
        ["grecaptcha", "reCAPTCHA"],
        ["hljs", "Highlight.js"],
        ["monaco", "Monaco Editor"],
        ["THREE", "Three.js"],
        ["gsap", "GSAP"],
        ["Alpine", "Alpine.js"],
        ["htmx", "htmx"],
        ["Livewire", "Livewire"],
        ["Stimulus", "Stimulus"],
      ];
      for (const [key, label] of map) {
        if (has(key)) hits.push(label);
      }
      // DOM attribute clues
      if (document.querySelector("[data-reactroot], [data-reactid], #__next, [data-nextjs-scroll-focus-boundary]")) {
        hits.push("React/Next DOM");
      }
      if (document.querySelector("[data-v-], [ng-version], app-root")) {
        hits.push("Vue/Angular DOM");
      }
      if (document.documentElement?.getAttribute("data-wf-domain") || document.querySelector("[data-wf-page]")) {
        hits.push("Webflow");
      }
      if (document.querySelector('script[src*="shopify"], link[href*="shopify"]')) {
        hits.push("Shopify assets");
      }
      if (document.querySelector('script[src*="wp-"], link[href*="wp-content"]') || /\/wp-content\//i.test(document.documentElement?.innerHTML?.slice(0, 5000) || "")) {
        hits.push("WordPress");
      }
      return [...new Set(hits)].slice(0, 30);
    }

    static #domMarkers() {
      const markers = [];
      if (document.getElementById("__NEXT_DATA__")) markers.push("script#__NEXT_DATA__");
      if (document.querySelector("astro-island, [data-astro-cid]")) markers.push("Astro");
      if (document.querySelector("svelte-component, [class*='svelte-']")) markers.push("Svelte-ish");
      if (document.querySelector("wix-iframe, #SITE_CONTAINER")) markers.push("Wix");
      if (document.querySelector("[data-framer-component], #__framer-badge-container")) markers.push("Framer");
      if (document.querySelector("amp-analytics, html[amp], html[⚡]")) markers.push("AMP");
      const generator = document.querySelector('meta[name="generator" i]')?.content || "";
      if (generator) markers.push(`generator:${generator.slice(0, 80)}`);
      return markers.slice(0, 20);
    }

    static #forms() {
      const forms = [...document.forms].slice(0, 12).map((f) => {
        const inputs = [...f.querySelectorAll("input, textarea, select")];
        return {
          method: String(f.method || "get").toLowerCase(),
          actionHost: (() => {
            try {
              return f.action ? new URL(f.action, location.href).hostname : hostOrEmpty();
            } catch {
              return "";
            }
          })(),
          passwordFields: inputs.filter((el) => el.type === "password").length,
          emailFields: inputs.filter((el) => /email/i.test(el.type) || /email/i.test(el.name || "") || /email/i.test(el.id || "")).length,
          inputCount: inputs.length,
          autocomplete: String(f.autocomplete || "").slice(0, 40),
        };
      });
      function hostOrEmpty() {
        return (location.hostname || "").replace(/^www\./, "");
      }
      return {
        count: document.forms.length,
        samples: forms,
        hasPassword: Boolean(document.querySelector('input[type="password"]')),
        hasFileUpload: Boolean(document.querySelector('input[type="file"]')),
      };
    }

    static #resourceHosts(pageHost) {
      const third = new Set();
      const cdnHints = new Set();
      const cdnRe =
        /cdn|cloudflare|cloudfront|akamai|fastly|jsdelivr|unpkg|googleapis|gstatic|fbcdn|twimg|shopify|webflow|website-files|azureedge|azurefd|imgix|cloudinary/i;
      try {
        const entries = performance.getEntriesByType?.("resource") || [];
        for (const e of entries.slice(0, 200)) {
          try {
            const h = new URL(e.name).hostname.replace(/^www\./, "").toLowerCase();
            if (!h) continue;
            if (h !== pageHost && !h.endsWith(`.${pageHost}`)) third.add(h);
            if (cdnRe.test(h) || cdnRe.test(e.name)) cdnHints.add(h);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      return { thirdParty: [...third], cdnHints: [...cdnHints] };
    }

    static #securityHints() {
      return {
        mixedContent: location.protocol === "https:" && Boolean(document.querySelector('img[src^="http:"], script[src^="http:"], iframe[src^="http:"]')),
        serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
        crossOriginIsolated: Boolean(crossOriginIsolated),
        cookieCount: (() => {
          try {
            return document.cookie ? document.cookie.split(";").filter(Boolean).length : 0;
          } catch {
            return 0;
          }
        })(),
        localStorageKeys: (() => {
          try {
            return localStorage.length;
          } catch {
            return -1;
          }
        })(),
        sessionStorageKeys: (() => {
          try {
            return sessionStorage.length;
          } catch {
            return -1;
          }
        })(),
      };
    }
  }

  globalThis.GosafePageTechProbe = PageTechProbe;
})();
