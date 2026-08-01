(() => {
  "use strict";

  /**
   * Built-in User-Agent pool (Chrome / Firefox / Edge on Windows & Linux).
   * MacOS is off by default — spoofed Mac UAs break Ctrl vs ⌘ shortcuts on many sites
   * (same caveat as https://github.com/tarampampam/random-user-agent).
   */
  const CHROME_VERS = ["120.0.0.0", "121.0.0.0", "122.0.0.0", "123.0.0.0", "124.0.0.0", "125.0.0.0", "126.0.0.0", "127.0.0.0", "128.0.0.0", "129.0.0.0", "130.0.0.0", "131.0.0.0"];
  const FF_VERS = ["120.0", "121.0", "122.0", "123.0", "124.0", "125.0", "126.0", "127.0", "128.0", "129.0", "130.0", "131.0"];
  const EDGE_VERS = ["120.0.0.0", "122.0.0.0", "124.0.0.0", "126.0.0.0", "128.0.0.0", "130.0.0.0"];

  const OS_TOKENS = {
    windows: [
      "Windows NT 10.0; Win64; x64",
      "Windows NT 10.0; WOW64",
      "Windows NT 11.0; Win64; x64",
    ],
    linux: [
      "X11; Linux x86_64",
      "X11; Ubuntu; Linux x86_64",
      "X11; Fedora; Linux x86_64",
    ],
    macos: [
      "Macintosh; Intel Mac OS X 10_15_7",
      "Macintosh; Intel Mac OS X 13_6_0",
      "Macintosh; Intel Mac OS X 14_5_0",
    ],
  };

  class UaGenerator {
    static defaults() {
      return {
        browsers: { chrome: true, firefox: true, edge: true, safari: false },
        os: { windows: true, linux: true, macos: false },
        autoRenewMinutes: 10,
        renewOnStartup: true,
      };
    }

    static sanitizeSettings(raw) {
      const d = UaGenerator.defaults();
      const src = raw && typeof raw === "object" ? raw : {};
      const browsers = { ...d.browsers, ...(src.browsers || {}) };
      const os = { ...d.os, ...(src.os || {}) };
      for (const k of Object.keys(browsers)) browsers[k] = Boolean(browsers[k]);
      for (const k of Object.keys(os)) os[k] = Boolean(os[k]);
      let mins = Number(src.autoRenewMinutes);
      if (!Number.isFinite(mins) || mins < 0) mins = d.autoRenewMinutes;
      if (mins > 0 && mins < 1) mins = 1;
      return {
        browsers,
        os,
        autoRenewMinutes: Math.min(1440, Math.floor(mins)),
        renewOnStartup: src.renewOnStartup !== false,
        current: typeof src.current === "string" ? src.current : "",
        updatedAt: Number(src.updatedAt) || 0,
      };
    }

    static #pick(list) {
      return list[Math.floor(Math.random() * list.length)];
    }

    static #activeOs(settings) {
      return Object.keys(OS_TOKENS).filter((k) => settings.os[k]);
    }

    static #activeBrowsers(settings) {
      return Object.keys(settings.browsers).filter((k) => settings.browsers[k]);
    }

    /** Parse rough browser/os hints from a UA string for Client Hints spoofing. */
    static parse(ua) {
      const out = {
        ua: String(ua || ""),
        browser: "Chrome",
        version: "120",
        fullVersion: "120.0.0.0",
        platform: "Windows",
        platformVersion: "10.0.0",
        arch: "x86",
        bitness: "64",
        mobile: false,
      };
      if (/Firefox\/([\d.]+)/i.test(out.ua)) {
        out.browser = "Firefox";
        out.fullVersion = RegExp.$1;
        out.version = out.fullVersion.split(".")[0];
      } else if (/Edg\/([\d.]+)/i.test(out.ua)) {
        out.browser = "Edge";
        out.fullVersion = RegExp.$1;
        out.version = out.fullVersion.split(".")[0];
      } else if (/Version\/([\d.]+).*Safari/i.test(out.ua) && !/Chrome|Chromium|Edg/i.test(out.ua)) {
        out.browser = "Safari";
        out.fullVersion = RegExp.$1;
        out.version = out.fullVersion.split(".")[0];
      } else if (/Chrome\/([\d.]+)/i.test(out.ua)) {
        out.browser = "Chrome";
        out.fullVersion = RegExp.$1;
        out.version = out.fullVersion.split(".")[0];
      }

      if (/Android/i.test(out.ua)) {
        out.platform = "Android";
        out.mobile = true;
      } else if (/iPhone|iPad/i.test(out.ua)) {
        out.platform = "iOS";
        out.mobile = true;
      } else if (/Mac OS X/i.test(out.ua)) {
        out.platform = "macOS";
        const m = out.ua.match(/Mac OS X (\d+)[_.](\d+)/);
        if (m) out.platformVersion = `${m[1]}.${m[2]}.0`;
      } else if (/Linux/i.test(out.ua)) {
        out.platform = "Linux";
      } else {
        out.platform = "Windows";
        out.platformVersion = /Windows NT 11/i.test(out.ua) ? "15.0.0" : "10.0.0";
      }
      return out;
    }

    /** @param {ReturnType<typeof UaGenerator.sanitizeSettings>} settings */
    static generate(settings) {
      const cfg = UaGenerator.sanitizeSettings(settings);
      let browsers = UaGenerator.#activeBrowsers(cfg);
      let osList = UaGenerator.#activeOs(cfg);
      if (!browsers.length) browsers = ["chrome"];
      if (!osList.length) osList = ["windows"];

      const browser = UaGenerator.#pick(browsers);
      const osKey = UaGenerator.#pick(osList);
      const osToken = UaGenerator.#pick(OS_TOKENS[osKey]);

      if (browser === "firefox") {
        const ver = UaGenerator.#pick(FF_VERS);
        return `Mozilla/5.0 (${osToken}; rv:${ver}) Gecko/20100101 Firefox/${ver}`;
      }

      if (browser === "safari") {
        const ver = UaGenerator.#pick(["16.6", "17.0", "17.4", "17.5", "18.0"]);
        const webkit = UaGenerator.#pick(["605.1.15", "605.1.15"]);
        const mac = osKey === "macos" ? osToken : "Macintosh; Intel Mac OS X 14_5_0";
        return `Mozilla/5.0 (${mac}) AppleWebKit/${webkit} (KHTML, like Gecko) Version/${ver} Safari/${webkit}`;
      }

      if (browser === "edge") {
        const ver = UaGenerator.#pick(EDGE_VERS);
        return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36 Edg/${ver}`;
      }

      const ver = UaGenerator.#pick(CHROME_VERS);
      return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
    }
  }

  globalThis.UaGenerator = UaGenerator;
})();
