(() => {
  "use strict";

  class UaOptionsPage {
    constructor() {
      this.enabled = document.getElementById("uaEnabled");
      this.currentUa = document.getElementById("currentUa");
      this.updatedAt = document.getElementById("updatedAt");
      this.renewBtn = document.getElementById("renewBtn");
      this.renewMins = document.getElementById("renewMins");
      this.renewStartup = document.getElementById("renewStartup");
      this.browsers = {
        chrome: document.getElementById("brChrome"),
        firefox: document.getElementById("brFirefox"),
        edge: document.getElementById("brEdge"),
        safari: document.getElementById("brSafari"),
      };
      this.os = {
        windows: document.getElementById("osWindows"),
        linux: document.getElementById("osLinux"),
        macos: document.getElementById("osMac"),
      };
      this._saving = false;
    }

    async send(type, payload = {}) {
      return chrome.runtime.sendMessage({ type, ...payload });
    }

    /** @param {any} data */
    render(data) {
      const settings = data.uaSettings || {};
      this.enabled.checked = Boolean(data.featureOn);
      this.currentUa.textContent = settings.current || "No user-agent yet — click Renew";
      this.renewMins.value = String(settings.autoRenewMinutes ?? 10);
      this.renewStartup.checked = settings.renewOnStartup !== false;

      for (const [key, input] of Object.entries(this.browsers)) {
        input.checked = settings.browsers?.[key] !== false && Boolean(settings.browsers?.[key] ?? key !== "safari");
        if (settings.browsers && key in settings.browsers) {
          input.checked = Boolean(settings.browsers[key]);
        }
      }
      for (const [key, input] of Object.entries(this.os)) {
        if (settings.os && key in settings.os) {
          input.checked = Boolean(settings.os[key]);
        } else {
          input.checked = key !== "macos";
        }
      }

      if (settings.updatedAt) {
        this.updatedAt.textContent = `Updated ${new Date(settings.updatedAt).toLocaleString()}`;
      } else {
        this.updatedAt.textContent = "Not renewed yet";
      }

      const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", theme);
      const logo = document.getElementById("brandLogo");
      if (logo) {
        logo.src =
          theme === "dark"
            ? "../icons/logo_whenturntodarkmode.png"
            : "../icons/default_logo.png";
      }
    }

    collectSettings() {
      return {
        browsers: {
          chrome: this.browsers.chrome.checked,
          firefox: this.browsers.firefox.checked,
          edge: this.browsers.edge.checked,
          safari: this.browsers.safari.checked,
        },
        os: {
          windows: this.os.windows.checked,
          linux: this.os.linux.checked,
          macos: this.os.macos.checked,
        },
        autoRenewMinutes: Number(this.renewMins.value) || 0,
        renewOnStartup: this.renewStartup.checked,
      };
    }

    async refresh() {
      const data = await this.send("getUaStatus");
      this.render(data);
      return data;
    }

    async persist(renew = false) {
      if (this._saving) return;
      this._saving = true;
      try {
        await this.send("setFeature", {
          key: "randomUa",
          value: this.enabled.checked,
        });
        const result = await this.send("setUaSettings", {
          settings: this.collectSettings(),
          renew,
        });
        if (result?.uaSettings) {
          this.render({
            featureOn: this.enabled.checked,
            uaSettings: result.uaSettings,
          });
        } else {
          await this.refresh();
        }
      } finally {
        this._saving = false;
      }
    }

    bind() {
      this.enabled.addEventListener("change", () => this.persist(false));
      this.renewBtn.addEventListener("click", async () => {
        await this.persist(true);
      });
      this.renewMins.addEventListener("change", () => this.persist(false));
      this.renewStartup.addEventListener("change", () => this.persist(false));

      for (const input of [
        ...Object.values(this.browsers),
        ...Object.values(this.os),
      ]) {
        input.addEventListener("change", () => this.persist(true));
      }

      this.aiApiKey = document.getElementById("aiApiKey");
      this.aiSaveKey = document.getElementById("aiSaveKey");
      this.aiClearKey = document.getElementById("aiClearKey");
      this.aiKeyStatus = document.getElementById("aiKeyStatus");

      this.aiSaveKey?.addEventListener("click", async () => {
        const key = String(this.aiApiKey?.value || "").trim();
        if (!key) return;
        await this.send("setAiSettings", { apiKey: key, enabled: true });
        if (this.aiApiKey) this.aiApiKey.value = "";
        await this.refreshAiStatus();
      });
      this.aiClearKey?.addEventListener("click", async () => {
        await this.send("setAiSettings", { clearKey: true, apiKey: "", enabled: false });
        if (this.aiApiKey) this.aiApiKey.value = "";
        await this.refreshAiStatus();
      });
    }

    async refreshAiStatus() {
      if (!this.aiKeyStatus) return;
      try {
        const ai = await this.send("getAiSettings");
        this.aiKeyStatus.textContent = ai?.hasKey
          ? `On · quiz & tips use ${ai.model || "glm"}`
          : "Off — no key saved";
      } catch {
        this.aiKeyStatus.textContent = "";
      }
    }

    async start() {
      this.bind();
      const data = await this.refresh();
      await this.refreshAiStatus();
      if (!data?.uaSettings?.current) {
        await this.persist(true);
      }
    }
  }

  new UaOptionsPage().start();
})();
