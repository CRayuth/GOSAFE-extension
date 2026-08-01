(() => {
  "use strict";

  class Theme {
    static #LOGO_LIGHT = "../icons/default_logo.png";
    static #LOGO_DARK = "../icons/logo_whenturntodarkmode.png";

    static apply(theme) {
      const next = theme === "dark" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      const logo = document.getElementById("brandLogo");
      if (logo) {
        logo.src = next === "dark" ? Theme.#LOGO_DARK : Theme.#LOGO_LIGHT;
      }
    }
  }

  class SecurityUi {
    constructor() {
      this.host = document.getElementById("secHost");
      this.watchHero = document.getElementById("watchHero");
      this.watchHeroTitle = document.getElementById("watchHeroTitle");
      this.watchHeroBody = document.getElementById("watchHeroBody");
      this.watchList = document.getElementById("watchList");
      this.watchEmpty = document.getElementById("watchEmpty");
      this.attackList = document.getElementById("attackList");
      this.attackEmpty = document.getElementById("attackEmpty");
      this.fwHost = document.getElementById("fwHost");
      this.fwList = document.getElementById("fwList");
      this.devList = document.getElementById("devList");
      this.devEmpty = document.getElementById("devEmpty");
      this.devMode = document.getElementById("devMode");
      this.tabDeveloper = document.getElementById("tabDeveloper");
      this.status = document.getElementById("secStatus");
      this.version = document.getElementById("secVersion");
      this.tabs = [...document.querySelectorAll(".sec-tab")];
      this.panels = {
        watch: document.getElementById("panelWatch"),
        attacks: document.getElementById("panelAttacks"),
        firewall: document.getElementById("panelFirewall"),
        developer: document.getElementById("panelDeveloper"),
      };
      this.version.textContent = `v${chrome.runtime.getManifest().version}`;
    }

    setTab(name) {
      for (const tab of this.tabs) {
        tab.classList.toggle("is-active", tab.dataset.tab === name);
      }
      for (const [key, panel] of Object.entries(this.panels)) {
        const on = key === name;
        panel.hidden = !on;
        panel.classList.toggle("is-active", on);
      }
    }

    setDevMode(on) {
      this.tabDeveloper.hidden = !on;
      if (!on && this.panels.developer.classList.contains("is-active")) {
        this.setTab("watch");
      }
    }

    renderList(el, emptyEl, items) {
      el.replaceChildren();
      const list = Array.isArray(items) ? items : [];
      emptyEl.hidden = list.length > 0;
      for (const item of list) {
        const li = document.createElement("li");
        li.className =
          item.level === "bad" ? "is-bad" : item.level === "ok" ? "is-ok" : "is-warn";
        const title = document.createElement("strong");
        title.textContent = item.title || "Signal";
        const detail = document.createElement("small");
        detail.textContent = item.detail || "";
        const wrap = document.createElement("div");
        wrap.append(title, detail);
        const mark = document.createElement("em");
        mark.textContent = item.level === "ok" ? "✓" : "⚠";
        li.append(wrap, mark);
        el.append(li);
      }
    }

    renderWatch(report, alerts) {
      const watch = [...(report?.watch || [])];
      const critical = watch.find((w) => w.level === "bad") || alerts.find((a) => a.level === "bad");
      if (critical) {
        this.watchHero.hidden = false;
        this.watchHeroTitle.textContent = critical.title;
        this.watchHeroBody.textContent = critical.detail || "";
      } else {
        this.watchHero.hidden = true;
      }
      this.renderList(this.watchList, this.watchEmpty, watch);
    }

    renderAttacks(report, alerts) {
      const merged = [...(report?.attacks || []), ...alerts];
      this.renderList(this.attackList, this.attackEmpty, merged);
    }

    renderFirewall(host, fw) {
      this.fwHost.textContent = host || "—";
      this.fwList.replaceChildren();
      const rows = [
        { ok: true, label: "Main website", mark: "✓" },
        {
          ok: false,
          label: `${fw.trackers || 0} trackers blocked`,
          mark: "✗",
          show: true,
        },
        {
          ok: (fw.learned || 0) === 0,
          label: `${fw.learned || 0} learned trackers (Badger-style)`,
          mark: (fw.learned || 0) > 0 ? "✗" : "✓",
          show: true,
        },
        {
          ok: false,
          label: `${fw.fingerprint || 0} fingerprint attempts noticed`,
          mark: "✗",
          show: true,
        },
        {
          ok: false,
          label: `${fw.suspicious || 0} suspicious APIs / scripts blocked`,
          mark: "✗",
          show: true,
        },
        {
          ok: (fw.attacks || 0) === 0,
          label:
            (fw.attacks || 0) > 0
              ? `${fw.attacks} attack signals`
              : "No attack signals this session",
          mark: (fw.attacks || 0) > 0 ? "⚠" : "✓",
          show: true,
        },
      ];
      for (const row of rows) {
        if (row.show === false) continue;
        const li = document.createElement("li");
        li.className = row.ok ? "is-ok" : "is-bad";
        const span = document.createElement("span");
        span.textContent = row.label;
        const em = document.createElement("em");
        em.textContent = row.mark;
        li.append(span, em);
        this.fwList.append(li);
      }
    }

    renderDeveloper(report) {
      this.renderList(this.devList, this.devEmpty, report?.developer || []);
    }
  }

  class SecurityController {
    constructor() {
      this.ui = new SecurityUi();
      this._tabId = null;
      this._host = "";
    }

    async init() {
      const { theme } = await chrome.storage.local.get({ theme: "light" });
      Theme.apply(theme);
      const { securityDevMode } = await chrome.storage.local.get({ securityDevMode: false });
      this.ui.devMode.checked = Boolean(securityDevMode);
      this.ui.setDevMode(Boolean(securityDevMode));

      this.ui.tabs.forEach((tab) => {
        tab.addEventListener("click", () => this.ui.setTab(tab.dataset.tab || "watch"));
      });
      this.ui.devMode.addEventListener("change", async () => {
        const on = this.ui.devMode.checked;
        await chrome.storage.local.set({ securityDevMode: on });
        this.ui.setDevMode(on);
        if (on) this.ui.setTab("developer");
        await this.refresh();
      });
      document.getElementById("secRefresh")?.addEventListener("click", () => this.refresh());
      document.getElementById("secClose")?.addEventListener("click", () => window.close());

      await this.refresh();
    }

    async refresh() {
      this.ui.status.textContent = "Scanning…";
      try {
        const params = new URLSearchParams(location.search);
        const forcedTabId = Number(params.get("tabId")) || 0;
        const forcedUrl = params.get("url") || "";

        let tab = null;
        if (forcedTabId) {
          try {
            tab = await chrome.tabs.get(forcedTabId);
          } catch {
            tab = null;
          }
        }
        if (!tab) {
          const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
          tab =
            tabs.find(
              (t) =>
                t.id &&
                t.url &&
                /^https?:/i.test(t.url) &&
                !t.url.startsWith(chrome.runtime.getURL(""))
            ) || null;
        }

        this._tabId = tab?.id || null;
        let url = tab?.url || forcedUrl || "";
        if (!/^https?:/i.test(url)) {
          this.ui.host.textContent = "Open an http(s) page to scan";
          this.ui.status.textContent = "No page";
          this.ui.renderWatch(null, []);
          this.ui.renderAttacks(null, []);
          this.ui.renderFirewall("—", {});
          this.ui.renderDeveloper(null);
          return;
        }

        let host = "";
        try {
          host = new URL(url).hostname.replace(/^www\./, "");
        } catch {
          host = "";
        }
        this._host = host;
        this.ui.host.textContent = host || url;

        let report = null;
        try {
          if (this._tabId) {
            report = (
              await chrome.tabs.sendMessage(this._tabId, { type: "scanSecurityPage" })
            )?.report;
          }
        } catch {
          report = null;
        }

        const fw = await chrome.runtime.sendMessage({
          type: "getSecurityFirewall",
          host,
        });
        let learn = { blocked: 0 };
        try {
          learn = (await chrome.runtime.sendMessage({ type: "getTrackerLearnStatus" })) || learn;
        } catch {
          // ignore
        }
        const alerts = Array.isArray(fw?.alerts) ? fw.alerts : [];

        this.ui.renderWatch(report, alerts.filter((a) => a.kind === "watch"));
        this.ui.renderAttacks(
          report,
          alerts
            .filter((a) => a.kind !== "watch")
            .map((a) => ({
              level: "bad",
              title: a.title,
              detail: a.detail,
            }))
        );
        this.ui.renderFirewall(host, {
          ...(fw?.stats || {}),
          learned: learn?.blocked || 0,
        });
        this.ui.renderDeveloper(report);
        this.ui.status.textContent = report
          ? `Live · ${learn?.blocked || 0} learned trackers`
          : "Partial (reload page)";
      } catch (err) {
        this.ui.status.textContent = "Scan failed";
        console.warn(err);
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    new SecurityController().init();
  });
})();
