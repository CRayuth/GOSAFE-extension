(() => {
  "use strict";

  // MAIN world — spoof navigator.userAgent / userAgentData to match HTTP header.

  class UaJsSpoof {
    static #ATTR = "data-adblock-lite-ua";
    static #FLAG = "data-adblock-lite-randomua";
    static #applied = "";

    static enabled() {
      const root = document.documentElement;
      if (!root) return false;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      // Require explicit "on" — missing attribute must not spoof (breaks NVIDIA/Meta/Gmail).
      return root.getAttribute(UaJsSpoof.#FLAG) === "on";
    }

    static currentUa() {
      return document.documentElement?.getAttribute(UaJsSpoof.#ATTR) || "";
    }

    static parse(ua) {
      const out = {
        ua: String(ua || ""),
        browser: "Chrome",
        version: "120",
        fullVersion: "120.0.0.0",
        platform: "Windows",
        platformVersion: "10.0.0",
        mobile: false,
      };
      if (/Firefox\/([\d.]+)/i.test(out.ua)) {
        out.browser = "Firefox";
        out.fullVersion = RegExp.$1;
      } else if (/Edg\/([\d.]+)/i.test(out.ua)) {
        out.browser = "Edge";
        out.fullVersion = RegExp.$1;
      } else if (/Version\/([\d.]+).*Safari/i.test(out.ua) && !/Chrome|Chromium|Edg/i.test(out.ua)) {
        out.browser = "Safari";
        out.fullVersion = RegExp.$1;
      } else if (/Chrome\/([\d.]+)/i.test(out.ua)) {
        out.browser = "Chrome";
        out.fullVersion = RegExp.$1;
      }
      out.version = out.fullVersion.split(".")[0];

      if (/Android/i.test(out.ua)) {
        out.platform = "Android";
        out.mobile = true;
      } else if (/iPhone|iPad/i.test(out.ua)) {
        out.platform = "iOS";
        out.mobile = true;
      } else if (/Mac OS X/i.test(out.ua)) {
        out.platform = "macOS";
      } else if (/Linux/i.test(out.ua)) {
        out.platform = "Linux";
      } else {
        out.platform = "Windows";
      }
      return out;
    }

    static apply(ua) {
      if (!ua || ua === UaJsSpoof.#applied) return;
      if (!UaJsSpoof.enabled()) return;
      UaJsSpoof.#applied = ua;
      const info = UaJsSpoof.parse(ua);

      const define = (obj, key, value) => {
        try {
          Object.defineProperty(obj, key, {
            configurable: true,
            get() {
              return value;
            },
          });
        } catch {
          try {
            obj[key] = value;
          } catch {
            // ignore
          }
        }
      };

      define(Navigator.prototype, "userAgent", ua);
      define(Navigator.prototype, "appVersion", ua.replace(/^Mozilla\//, ""));
      define(Navigator.prototype, "vendor", info.browser === "Firefox" ? "" : "Google Inc.");

      let platform = "Win32";
      if (info.platform === "macOS") platform = "MacIntel";
      else if (info.platform === "Linux") platform = "Linux x86_64";
      else if (info.platform === "Android") platform = "Linux armv8l";
      else if (info.platform === "iOS") platform = "iPhone";
      define(Navigator.prototype, "platform", platform);

      // Client Hints
      try {
        const brands =
          info.browser === "Firefox"
            ? [{ brand: "Firefox", version: info.version }]
            : info.browser === "Edge"
              ? [
                  { brand: "Not)A;Brand", version: "99" },
                  { brand: "Microsoft Edge", version: info.version },
                  { brand: "Chromium", version: info.version },
                ]
              : info.browser === "Safari"
                ? [{ brand: "Safari", version: info.version }]
                : [
                    { brand: "Not)A;Brand", version: "99" },
                    { brand: "Google Chrome", version: info.version },
                    { brand: "Chromium", version: info.version },
                  ];

        const uad = {
          brands,
          mobile: info.mobile,
          platform: info.platform,
          getHighEntropyValues(hints) {
            const want = Array.isArray(hints) ? hints : [];
            const data = {
              brands,
              mobile: info.mobile,
              platform: info.platform,
            };
            if (want.includes("architecture")) data.architecture = "x86";
            if (want.includes("bitness")) data.bitness = "64";
            if (want.includes("model")) data.model = "";
            if (want.includes("platformVersion")) {
              data.platformVersion =
                info.platform === "Windows" ? "10.0.0" : info.platform === "macOS" ? "14.5.0" : "6.5.0";
            }
            if (want.includes("uaFullVersion") || want.includes("fullVersionList")) {
              data.uaFullVersion = info.fullVersion;
              data.fullVersionList = brands.map((b) => ({
                brand: b.brand,
                version: b.brand.includes("Not") ? "10.0.0.0" : info.fullVersion,
              }));
            }
            return Promise.resolve(data);
          },
          toJSON() {
            return { brands, mobile: info.mobile, platform: info.platform };
          },
        };

        define(Navigator.prototype, "userAgentData", uad);
      } catch {
        // ignore
      }
    }

    static sync() {
      const ua = UaJsSpoof.currentUa();
      if (ua && UaJsSpoof.enabled()) UaJsSpoof.apply(ua);
    }

    static install() {
      UaJsSpoof.sync();
      const root = document.documentElement;
      if (!root) return;
      const obs = new MutationObserver(() => UaJsSpoof.sync());
      obs.observe(root, {
        attributes: true,
        attributeFilter: [UaJsSpoof.#ATTR, UaJsSpoof.#FLAG, "data-adblock-lite"],
      });
    }
  }

  UaJsSpoof.install();
})();
