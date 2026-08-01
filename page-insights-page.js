(() => {
  "use strict";

  const PI = globalThis.AblPageInsights;
  if (!PI) {
    console.error("GOSAFE Page Insights: lib/page-insights.js missing");
    return;
  }

  const { HostUtil, SubscriptionPatterns, DarkPatternPatterns, HealthScore } = PI;

  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return false;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-gosafe-page-insights") !== "off";
    }
  }

  class PageScan {
    static pageHost() {
      return HostUtil.normalize(location.hostname);
    }

    static visibleText(limit = 80000) {
      try {
        const body = document.body;
        if (!body) return "";
        return String(body.innerText || body.textContent || "").slice(0, limit);
      } catch {
        return "";
      }
    }

    /** @returns {{ host: string, count: number, transferSize: number, types: Set<string> }[]} */
    static thirdPartyResources() {
      const pageHost = PageScan.pageHost();
      /** @type {Map<string, { host: string, count: number, transferSize: number, types: Set<string> }>} */
      const map = new Map();
      try {
        const entries = performance.getEntriesByType("resource") || [];
        for (const e of entries) {
          try {
            const u = new URL(e.name);
            const h = HostUtil.normalize(u.hostname);
            if (!HostUtil.isThirdParty(pageHost, h)) continue;
            let row = map.get(h);
            if (!row) {
              row = { host: h, count: 0, transferSize: 0, types: new Set() };
              map.set(h, row);
            }
            row.count += 1;
            row.transferSize += Number(e.transferSize) || 0;
            if (e.initiatorType) row.types.add(String(e.initiatorType));
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      return [...map.values()].sort(
        (a, b) => b.transferSize - a.transferSize || b.count - a.count
      );
    }

    static scriptThirdPartyCount() {
      const pageHost = PageScan.pageHost();
      let n = 0;
      for (const s of document.querySelectorAll("script[src]")) {
        try {
          const h = HostUtil.normalize(new URL(s.src, location.href).hostname);
          if (HostUtil.isThirdParty(pageHost, h)) n += 1;
        } catch {
          // ignore
        }
      }
      return n;
    }

    static privacyReceipt() {
      const pageHost = PageScan.pageHost();
      const items = [];

      const password = document.querySelectorAll('input[type="password"]').length;
      const email = document.querySelectorAll('input[type="email"], input[autocomplete*="email" i]').length;
      const tel = document.querySelectorAll('input[type="tel"], input[autocomplete*="tel" i]').length;
      const cardish = document.querySelectorAll(
        'input[autocomplete*="cc-" i], input[name*="card" i], input[id*="card" i]'
      ).length;
      const piiFieldCount = password + email + tel + cardish;

      if (password) items.push({ kind: "pii", text: `Password field(s): ${password}` });
      if (email) items.push({ kind: "pii", text: `Email field(s): ${email}` });
      if (tel) items.push({ kind: "pii", text: `Phone field(s): ${tel}` });
      if (cardish) items.push({ kind: "pii", text: `Payment-related field(s): ${cardish}` });

      const offOrigin = [];
      for (const form of document.querySelectorAll("form")) {
        try {
          const action = form.getAttribute("action") || location.href;
          const u = new URL(action, location.href);
          const h = HostUtil.normalize(u.hostname);
          if (HostUtil.isThirdParty(pageHost, h)) offOrigin.push(h);
        } catch {
          // ignore
        }
      }
      if (offOrigin.length) {
        items.push({
          kind: "form",
          text: `Form(s) post off-origin: ${[...new Set(offOrigin)].slice(0, 5).join(", ")}`,
        });
      }

      let cookieCount = 0;
      try {
        cookieCount = document.cookie ? document.cookie.split(";").filter((c) => c.trim()).length : 0;
      } catch {
        cookieCount = 0;
      }
      if (cookieCount) items.push({ kind: "storage", text: `Cookies readable by page: ${cookieCount}` });

      let storageKeys = 0;
      try {
        storageKeys = localStorage.length;
      } catch {
        storageKeys = 0;
      }
      if (storageKeys) items.push({ kind: "storage", text: `localStorage keys: ${storageKeys}` });

      const tp = PageScan.thirdPartyResources();
      if (tp.length) {
        items.push({
          kind: "network",
          text: `Third-party hosts contacted: ${tp.length} (top: ${tp
            .slice(0, 4)
            .map((r) => r.host)
            .join(", ")})`,
        });
      }

      return { items, piiFieldCount, cookieCount, storageKeys, thirdPartyHosts: tp.length, thirdParties: tp };
    }

    static subscription() {
      return SubscriptionPatterns.analyze(PageScan.visibleText());
    }

    /**
     * @returns {{ findings: { kind: string, label: string, el: Element|null }[], count: number }}
     */
    static darkPatterns() {
      const findings = [];
      const seen = new WeakSet();

      const push = (kind, label, el) => {
        if (el && seen.has(el)) return;
        if (el) seen.add(el);
        findings.push({ kind, label, el: el || null });
      };

      for (const el of document.querySelectorAll("button, a, label, span, p, div")) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.closest("#gosafe-page-insights-root")) continue;
        const text = (el.innerText || el.textContent || "").trim().slice(0, 200);
        if (!text || text.length > 160) continue;
        if (DarkPatternPatterns.CONFIRMSHAME.test(text)) {
          push("confirmshame", `Confirmshaming: “${text.slice(0, 80)}”`, el);
        } else if (
          DarkPatternPatterns.COUNTDOWN.test(text) &&
          /buy|order|checkout|claim|offer|deal|sale/i.test(
            (el.closest("section,form,aside,div")?.innerText || "").slice(0, 400)
          )
        ) {
          push("urgency", `Countdown / timer near CTA: “${text.slice(0, 60)}”`, el);
        } else if (DarkPatternPatterns.URGENCY.test(text) && text.length < 80) {
          push("urgency", `Urgency copy: “${text.slice(0, 80)}”`, el);
        }
        if (findings.length >= 40) break;
      }

      for (const input of document.querySelectorAll('input[type="checkbox"]')) {
        if (!(input instanceof HTMLInputElement) || !input.checked) continue;
        if (input.closest("#gosafe-page-insights-root")) continue;
        const labelText = PageScan.#checkboxLabel(input);
        if (DarkPatternPatterns.MARKETING_CB.test(labelText)) {
          push("prechecked", `Pre-checked marketing: “${labelText.slice(0, 80)}”`, input);
        }
      }

      for (const el of document.querySelectorAll("a, button, [role='button']")) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.closest("#gosafe-page-insights-root")) continue;
        const text = (el.innerText || el.getAttribute("aria-label") || "").trim();
        if (!DarkPatternPatterns.SKIP.test(text) || text.length > 40) continue;
        const style = getComputedStyle(el);
        const fontSize = parseFloat(style.fontSize) || 16;
        const opacity = parseFloat(style.opacity) || 1;
        const color = style.color || "";
        const lowContrast =
          opacity < 0.55 ||
          fontSize < 12 ||
          /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0?\.(0|1|2|3)/i.test(color);
        if (lowContrast) {
          push("hidden_exit", `Low-visibility exit control: “${text.slice(0, 40)}”`, el);
        }
      }

      return { findings: findings.slice(0, 25), count: findings.length };
    }

    /** @param {HTMLInputElement} input */
    static #checkboxLabel(input) {
      if (input.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (lab) return (lab.innerText || "").trim();
      }
      const parent = input.closest("label");
      if (parent) return (parent.innerText || "").trim();
      return (input.getAttribute("aria-label") || input.name || "").trim();
    }

    static accessibility() {
      let missingAlt = 0;
      for (const img of document.querySelectorAll("img")) {
        if (!img.hasAttribute("alt") || String(img.getAttribute("alt") || "").trim() === "") {
          if (img.getAttribute("role") === "presentation" || img.getAttribute("aria-hidden") === "true") {
            continue;
          }
          missingAlt += 1;
        }
      }

      let unlabeledInputs = 0;
      for (const input of document.querySelectorAll("input, select, textarea")) {
        if (!(input instanceof HTMLElement)) continue;
        const type = (input.getAttribute("type") || "").toLowerCase();
        if (type === "hidden" || type === "submit" || type === "button" || type === "image") continue;
        const id = input.id;
        const hasLabel =
          Boolean(input.getAttribute("aria-label")) ||
          Boolean(input.getAttribute("aria-labelledby")) ||
          Boolean(input.getAttribute("title")) ||
          (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
          Boolean(input.closest("label"));
        if (!hasLabel) unlabeledInputs += 1;
      }

      let emptyButtons = 0;
      for (const btn of document.querySelectorAll("button")) {
        const text = (btn.innerText || btn.getAttribute("aria-label") || "").trim();
        if (!text && !btn.querySelector("img[alt], svg[aria-label]")) emptyButtons += 1;
      }

      return { missingAlt, unlabeledInputs, emptyButtons };
    }

    static performance() {
      const thirdParties = PageScan.thirdPartyResources();
      const heavy = thirdParties.filter((r) => r.transferSize > 80000 || r.count >= 8);
      let resourceCount = 0;
      try {
        resourceCount = (performance.getEntriesByType("resource") || []).length;
      } catch {
        resourceCount = 0;
      }
      return {
        scriptCount: document.scripts.length,
        resourceCount,
        thirdParties,
        heavyThirdParties: heavy.length,
        heavyHosts: heavy.slice(0, 12).map((r) => ({
          host: r.host,
          count: r.count,
          transferSize: r.transferSize,
        })),
      };
    }

    static async permissionsLocal() {
      const names = ["clipboard-read", "clipboard-write", "geolocation", "camera", "microphone", "notifications"];
      const out = [];
      if (!navigator.permissions?.query) return out;
      for (const name of names) {
        try {
          const status = await navigator.permissions.query({ name: /** @type {PermissionName} */ (name) });
          out.push({ name, state: status.state });
        } catch {
          // unsupported name
        }
      }
      return out;
    }

    /**
     * @param {number|null} trustSafety
     */
    static async fullReport(trustSafety = null) {
      const privacy = PageScan.privacyReceipt();
      const subscription = PageScan.subscription();
      const dark = PageScan.darkPatterns();
      const a11y = PageScan.accessibility();
      const perf = PageScan.performance();
      const https = location.protocol === "https:";
      const passwordOnHttp = !https && document.querySelectorAll('input[type="password"]').length > 0;
      const localPerms = await PageScan.permissionsLocal();

      const health = HealthScore.compute({
        scriptCount: perf.scriptCount,
        resourceCount: perf.resourceCount,
        heavyThirdParties: perf.heavyThirdParties,
        thirdPartyHosts: privacy.thirdPartyHosts,
        piiFieldCount: privacy.piiFieldCount,
        cookieCount: privacy.cookieCount,
        storageKeys: privacy.storageKeys,
        trustSafety,
        https,
        passwordOnHttp,
        missingAlt: a11y.missingAlt,
        unlabeledInputs: a11y.unlabeledInputs,
        emptyButtons: a11y.emptyButtons,
        darkPatternCount: dark.count,
        subscriptionWarn: subscription.level === "warn",
      });

      return {
        host: PageScan.pageHost(),
        url: location.href.slice(0, 500),
        privacy,
        subscription,
        dark: { count: dark.count, findings: dark.findings.map((f) => ({ kind: f.kind, label: f.label })) },
        darkRaw: dark,
        performance: perf,
        accessibility: a11y,
        localPermissions: localPerms,
        health,
        https,
        passwordOnHttp,
        thirdPartyScripts: PageScan.scriptThirdPartyCount(),
        scannedAt: Date.now(),
      };
    }
  }

  class InsightsUi {
    static ROOT_ID = "gosafe-page-insights-root";
    static HL_CLASS = "gosafe-pi-hl";

    constructor() {
      /** @type {ShadowRoot|null} */
      this._shadow = null;
      /** @type {HTMLElement|null} */
      this._host = null;
      this._open = false;
      /** @type {ReturnType<PageScan.fullReport>|null} */
      this._report = null;
      this._highlightOn = false;
      this._scanTimer = 0;
      this._toastTimer = 0;
      this._tab = "overview";
      this._mo = null;
    }

    mount() {
      if (this._host || !document.documentElement) return;
      const host = document.createElement("div");
      host.id = InsightsUi.ROOT_ID;
      host.setAttribute("data-gosafe-pi", "1");
      Object.assign(host.style, {
        all: "initial",
        position: "fixed",
        zIndex: "2147483646",
        bottom: "16px",
        right: "16px",
        pointerEvents: "none",
      });
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = InsightsUi.#styles() + InsightsUi.#markup();
      (document.body || document.documentElement).appendChild(host);
      this._host = host;
      this._shadow = shadow;

      const panel = shadow.getElementById("piPanel");
      if (panel) panel.style.pointerEvents = "auto";

      shadow.getElementById("piClose")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.close();
      });
      shadow.getElementById("piRefresh")?.addEventListener("click", () => this.refresh());
      shadow.getElementById("piHlToggle")?.addEventListener("click", () => this.toggleHighlights());
      shadow.getElementById("piOptimize")?.addEventListener("click", () => this.optimize());
      shadow.querySelectorAll("[data-pi-tab]").forEach((el) => {
        el.addEventListener("click", () => {
          const tab = el.getAttribute("data-pi-tab") || "overview";
          this.setTab(tab);
        });
      });
      shadow.addEventListener("click", (ev) => {
        const t = /** @type {HTMLElement} */ (ev.target);
        const btn = t.closest?.("[data-perm-set]");
        if (btn) {
          const type = btn.getAttribute("data-perm-type") || "";
          const setting = btn.getAttribute("data-perm-set") || "";
          this.setPermission(type, setting);
        }
      });
      this._onKey = (ev) => {
        if (ev.key === "Escape") this.close();
      };
      window.addEventListener("keydown", this._onKey, true);
      this.setTab(this._tab);
    }

    /** @param {string} tab */
    setTab(tab) {
      this._tab = tab;
      const s = this._shadow;
      if (!s) return;
      s.querySelectorAll("[data-pi-tab]").forEach((el) => {
        el.classList.toggle("is-on", el.getAttribute("data-pi-tab") === tab);
      });
      s.querySelectorAll("[data-pi-pane]").forEach((el) => {
        el.hidden = el.getAttribute("data-pi-pane") !== tab;
      });
    }

    unmount() {
      this.clearHighlights();
      if (this._onKey) {
        window.removeEventListener("keydown", this._onKey, true);
        this._onKey = null;
      }
      if (this._mo) {
        this._mo.disconnect();
        this._mo = null;
      }
      clearTimeout(this._scanTimer);
      this._host?.remove();
      this._host = null;
      this._shadow = null;
      this._open = false;
    }

    /** Open the panel (no always-on FAB). */
    open() {
      this.mount();
      this._open = true;
      const panel = this._shadow?.getElementById("piPanel");
      if (panel) panel.hidden = false;
      this.refresh();
    }

    /** Close and remove the panel from the page entirely. */
    close() {
      this._open = false;
      this.clearHighlights();
      this._highlightOn = false;
      this.unmount();
    }

    toggle() {
      if (this._open) this.close();
      else this.open();
    }

    setOpen(open) {
      if (open) this.open();
      else this.close();
    }

    scheduleScan() {
      clearTimeout(this._scanTimer);
      this._scanTimer = setTimeout(() => {
        if (!FeatureGate.on() || !this._open) return;
        this.refresh(false);
      }, 1200);
    }

    /**
     * @param {boolean} [forceTrust]
     */
    async refresh(forceTrust = true) {
      if (!FeatureGate.on() || !this._shadow) return;
      let trustSafety = null;
      if (forceTrust) {
        try {
          const trust = await chrome.runtime.sendMessage({
            type: "getTrustScore",
            url: location.href,
            thirdPartyScripts: PageScan.scriptThirdPartyCount(),
          });
          if (trust?.ok && trust.safety != null) trustSafety = Number(trust.safety);
        } catch {
          // ignore
        }
      } else if (this._report?.health) {
        trustSafety = this._report.health.pillars?.security ?? null;
      }

      const report = await PageScan.fullReport(trustSafety);
      this._report = report;
      this.render(report);
      if (this._highlightOn) this.applyHighlights(report.darkRaw);
      this.#updateFab(report.health.score);
    }

    /** @param {Awaited<ReturnType<PageScan.fullReport>>} report */
    render(report) {
      const s = this._shadow;
      if (!s) return;

      const scoreEl = s.getElementById("piScore");
      if (scoreEl) {
        scoreEl.textContent = String(report.health.score);
        scoreEl.className = `pi-score is-${report.health.verdict}`;
      }
      const hostEl = s.getElementById("piHost");
      if (hostEl) hostEl.textContent = report.host || "—";
      const verdictEl = s.getElementById("piVerdict");
      if (verdictEl) {
        const v = report.health.verdict;
        verdictEl.textContent =
          v === "good" ? "Healthy" : v === "fair" ? "Fair" : "Needs work";
        verdictEl.className = `pi-verdict is-${v}`;
      }

      const pillars = s.getElementById("piPillars");
      if (pillars) {
        const p = report.health.pillars;
        const labels = {
          speed: "Speed",
          privacy: "Privacy",
          security: "Security",
          accessibility: "A11y",
        };
        pillars.innerHTML = ["speed", "privacy", "security", "accessibility"]
          .map((k) => {
            const n = Math.round(p[k]);
            return `<div class="pi-meter">
              <div class="pi-meter-top"><span>${labels[k]}</span><b>${n}</b></div>
              <div class="pi-meter-track"><i style="width:${n}%"></i></div>
            </div>`;
          })
          .join("");
      }

      const issues = s.getElementById("piIssues");
      if (issues) {
        const list = report.health.topIssues || [];
        issues.innerHTML = list.length
          ? list
              .slice(0, 4)
              .map((t) => `<div class="pi-row"><span>${InsightsUi.esc(t)}</span></div>`)
              .join("")
          : `<div class="pi-empty">Nothing major flagged</div>`;
      }

      const receipt = s.getElementById("piReceipt");
      if (receipt) {
        if (!report.privacy.items.length) {
          receipt.innerHTML = `<div class="pi-empty">No personal-data surfaces spotted</div>`;
        } else {
          receipt.innerHTML = report.privacy.items
            .map((i) => {
              const parts = String(i.text).split(/:\s(.+)/);
              if (parts.length >= 2) {
                return `<div class="pi-kv"><span>${InsightsUi.esc(parts[0])}</span><b>${InsightsUi.esc(
                  parts[1]
                )}</b></div>`;
              }
              return `<div class="pi-row"><span>${InsightsUi.esc(i.text)}</span></div>`;
            })
            .join("");
        }
      }

      const sub = s.getElementById("piSub");
      if (sub) {
        if (report.subscription.level) {
          sub.className = `pi-note is-${report.subscription.level}`;
          sub.innerHTML = `<strong>${InsightsUi.esc(report.subscription.title)}</strong><span>${InsightsUi.esc(
            report.subscription.detail
          )}</span>`;
          sub.hidden = false;
        } else {
          sub.hidden = true;
          sub.innerHTML = "";
        }
      }

      const dark = s.getElementById("piDark");
      if (dark) {
        dark.innerHTML = report.dark.findings.length
          ? report.dark.findings
              .map(
                (f) =>
                  `<div class="pi-row"><em class="pi-tag">${InsightsUi.esc(
                    f.kind
                  )}</em><span>${InsightsUi.esc(f.label)}</span></div>`
              )
              .join("")
          : `<div class="pi-empty">No dark-pattern matches</div>`;
      }
      const darkCount = s.getElementById("piDarkCount");
      if (darkCount) darkCount.textContent = String(report.dark.count || 0);

      const perf = s.getElementById("piPerf");
      if (perf) {
        const rows = report.performance.heavyHosts.length
          ? report.performance.heavyHosts
          : report.performance.thirdParties.slice(0, 8).map((r) => ({
              host: r.host,
              count: r.count,
              transferSize: r.transferSize,
            }));
        perf.innerHTML = rows.length
          ? rows
              .map(
                (r) =>
                  `<div class="pi-kv"><span title="${InsightsUi.esc(r.host)}">${InsightsUi.esc(
                    r.host
                  )}</span><b>${r.count} · ${InsightsUi.fmtBytes(r.transferSize)}</b></div>`
              )
              .join("")
          : `<div class="pi-empty">No third-party timing yet</div>`;
      }
      const optBtn = s.getElementById("piOptimize");
      if (optBtn instanceof HTMLButtonElement) {
        const hosts = (report.performance.heavyHosts.length
          ? report.performance.heavyHosts
          : report.performance.thirdParties.slice(0, 8)
        ).map((h) => h.host);
        optBtn.disabled = hosts.length === 0;
        optBtn.dataset.hosts = JSON.stringify(hosts);
      }

      const perms = s.getElementById("piPerms");
      if (perms) this.renderPermissions(perms, report);
    }

    /**
     * @param {HTMLElement} mount
     * @param {Awaited<ReturnType<PageScan.fullReport>>} report
     */
    async renderPermissions(mount, report) {
      mount.innerHTML = `<div class="pi-empty">Loading…</div>`;
      let remote = null;
      try {
        remote = await chrome.runtime.sendMessage({
          type: "getPagePermissions",
          origin: location.origin,
        });
      } catch {
        remote = null;
      }

      const rows = [];
      if (remote?.ok && Array.isArray(remote.permissions)) {
        for (const p of remote.permissions) {
          rows.push(
            `<div class="pi-perm">
              <div class="pi-perm-meta">
                <strong>${InsightsUi.esc(p.label)}</strong>
                <span>${InsightsUi.esc(p.setting)}</span>
              </div>
              <div class="pi-perm-actions">
                <button type="button" data-perm-type="${InsightsUi.esc(p.type)}" data-perm-set="block">Block</button>
                <button type="button" data-perm-type="${InsightsUi.esc(p.type)}" data-perm-set="allow">Allow</button>
              </div>
            </div>`
          );
        }
      }
      for (const p of report.localPermissions || []) {
        if (/^(camera|microphone|notifications)$/i.test(p.name)) continue;
        rows.push(
          `<div class="pi-perm">
            <div class="pi-perm-meta">
              <strong>${InsightsUi.esc(p.name)}</strong>
              <span>${InsightsUi.esc(p.state)} · read-only</span>
            </div>
          </div>`
        );
      }
      mount.innerHTML = rows.join("") || `<div class="pi-empty">Permissions unavailable here</div>`;
    }

    /**
     * @param {string} type
     * @param {string} setting
     */
    async setPermission(type, setting) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "setPagePermission",
          origin: location.origin,
          permission: type,
          setting,
        });
        if (!res?.ok) {
          this.#toast(res?.error || "Could not update permission");
        } else {
          this.#toast(`${type} → ${setting}`);
          this.refresh(false);
        }
      } catch (err) {
        this.#toast(String(err?.message || err));
      }
    }

    async optimize() {
      const btn = this._shadow?.getElementById("piOptimize");
      let hosts = [];
      try {
        hosts = JSON.parse(btn?.dataset.hosts || "[]");
      } catch {
        hosts = [];
      }
      if (!hosts.length && this._report?.performance?.heavyHosts) {
        hosts = this._report.performance.heavyHosts.map((h) => h.host);
      }
      if (!hosts.length) {
        this.#toast("No heavy third parties to block");
        return;
      }
      try {
        const res = await chrome.runtime.sendMessage({
          type: "blockThirdPartiesSession",
          hosts,
          pageHost: PageScan.pageHost(),
        });
        if (res?.ok) {
          this.#toast(`Session-blocked ${res.count || hosts.length} host(s). Reload to apply.`);
        } else {
          this.#toast(res?.error || "Block failed");
        }
      } catch (err) {
        this.#toast(String(err?.message || err));
      }
    }

    toggleHighlights() {
      this._highlightOn = !this._highlightOn;
      const btn = this._shadow?.getElementById("piHlToggle");
      if (btn) {
        btn.textContent = this._highlightOn ? "Clear outlines" : "Outline on page";
        btn.classList.toggle("is-on", this._highlightOn);
      }
      if (this._highlightOn && this._report?.darkRaw) this.applyHighlights(this._report.darkRaw);
      else this.clearHighlights();
    }

    /** @param {{ findings: { el: Element|null, kind: string }[] }} dark */
    applyHighlights(dark) {
      this.clearHighlights();
      for (const f of dark.findings || []) {
        if (!(f.el instanceof HTMLElement)) continue;
        f.el.classList.add(InsightsUi.HL_CLASS);
        f.el.setAttribute("data-gosafe-pi-kind", f.kind);
      }
    }

    clearHighlights() {
      for (const el of document.querySelectorAll(`.${InsightsUi.HL_CLASS}`)) {
        el.classList.remove(InsightsUi.HL_CLASS);
        el.removeAttribute("data-gosafe-pi-kind");
      }
    }

    /** @param {number} _score */
    #updateFab(_score) {
      // No persistent FAB — panel only.
    }

    /** @param {string} msg */
    #toast(msg) {
      const el = this._shadow?.getElementById("piToast");
      if (!el) return;
      el.textContent = msg;
      el.hidden = false;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        el.hidden = true;
      }, 3200);
    }

    static esc(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    static fmtBytes(n) {
      const v = Number(n) || 0;
      if (v < 1024) return `${v} B`;
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
      return `${(v / (1024 * 1024)).toFixed(1)} MB`;
    }

    static #styles() {
      return `<style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .pi-root {
          font-family: "Roboto", "Segoe UI", system-ui, sans-serif;
          -webkit-font-smoothing: antialiased;
          color: #0a1f45;
        }
        .pi-panel {
          position: relative;
          width: min(320px, calc(100vw - 28px));
          max-height: min(68vh, 520px);
          display: flex; flex-direction: column;
          background: #fff; color: #0a1f45;
          border-radius: 12px; border: 1px solid #d0dae8;
          box-shadow: 0 12px 32px rgba(10,31,69,.16);
          overflow: hidden;
          pointer-events: auto;
        }
        .pi-head {
          display: flex; align-items: center; gap: 10px;
          padding: 12px 12px 10px; background: #f4f7fc; border-bottom: 1px solid #d0dae8;
        }
        .pi-score {
          width: 42px; height: 42px; border-radius: 10px; display: grid; place-items: center;
          font-weight: 700; font-size: 16px; color: #fff; flex-shrink: 0; letter-spacing: -0.03em;
        }
        .pi-score.is-good { background: #0058d0; }
        .pi-score.is-fair { background: #b45309; }
        .pi-score.is-poor { background: #c62828; }
        .pi-head-copy { flex: 1; min-width: 0; }
        .pi-head-copy strong { display: block; font-size: 13px; font-weight: 700; letter-spacing: -0.01em; }
        .pi-head-meta { display: flex; align-items: center; gap: 6px; margin-top: 2px; min-width: 0; }
        .pi-head-meta small {
          color: #4a5f80; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pi-verdict {
          flex-shrink: 0; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
          background: #e8eef8; color: #002870;
        }
        .pi-verdict.is-fair { background: #fff4e5; color: #9a3412; }
        .pi-verdict.is-poor { background: #fdecea; color: #b71c1c; }
        .pi-actions { display: flex; gap: 2px; }
        .pi-icon {
          width: 28px; height: 28px; border: none; border-radius: 8px; background: transparent;
          cursor: pointer; color: #4a5f80; font-size: 14px; line-height: 1;
        }
        .pi-icon:hover { background: #e2eaf6; color: #002870; }
        .pi-tabs {
          display: flex; gap: 2px; padding: 8px 8px 0; background: #fff;
          border-bottom: 1px solid #e8eef8;
        }
        .pi-tabs button {
          flex: 1; border: none; background: transparent; color: #7a8aa3;
          font: 600 11px/1 "Roboto", "Segoe UI", sans-serif;
          padding: 8px 4px 9px; cursor: pointer; border-bottom: 2px solid transparent;
        }
        .pi-tabs button.is-on { color: #0058d0; border-bottom-color: #0058d0; }
        .pi-tabs button:hover { color: #002870; }
        .pi-body { overflow: auto; padding: 10px 12px 12px; flex: 1; }
        .pi-body::-webkit-scrollbar { width: 6px; }
        .pi-body::-webkit-scrollbar-thumb { background: #c8d0e0; border-radius: 4px; }
        .pi-meters { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
        .pi-meter-top {
          display: flex; justify-content: space-between; align-items: baseline;
          font-size: 11px; color: #4a5f80; margin-bottom: 3px;
        }
        .pi-meter-top b { color: #0a1f45; font-size: 12px; font-variant-numeric: tabular-nums; }
        .pi-meter-track {
          height: 4px; border-radius: 999px; background: #e8eef8; overflow: hidden;
        }
        .pi-meter-track i {
          display: block; height: 100%; border-radius: inherit; background: #0058d0;
        }
        .pi-sec-label {
          margin: 0 0 6px; font-size: 10px; font-weight: 700; letter-spacing: .04em;
          text-transform: uppercase; color: #7a8aa3;
        }
        .pi-stack { display: flex; flex-direction: column; gap: 1px; }
        .pi-row, .pi-kv {
          display: flex; align-items: flex-start; gap: 8px;
          padding: 7px 0; border-bottom: 1px solid #eef2f8; font-size: 12px; line-height: 1.35;
        }
        .pi-row:last-child, .pi-kv:last-child { border-bottom: none; }
        .pi-kv { justify-content: space-between; gap: 12px; }
        .pi-kv span {
          color: #4a5f80; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pi-kv b {
          color: #0a1f45; font-weight: 600; text-align: right; flex-shrink: 0;
          font-variant-numeric: tabular-nums; max-width: 58%; word-break: break-word; white-space: normal;
        }
        .pi-row span { color: #0a1f45; }
        .pi-tag {
          flex-shrink: 0; font-style: normal; font-size: 9px; font-weight: 700;
          letter-spacing: .03em; text-transform: uppercase; color: #0058d0;
          background: #e8eef8; padding: 2px 5px; border-radius: 4px; margin-top: 1px;
        }
        .pi-empty { padding: 14px 4px; text-align: center; color: #7a8aa3; font-size: 12px; }
        .pi-note {
          display: flex; flex-direction: column; gap: 4px;
          margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.4;
        }
        .pi-note.is-warn { background: #fff4e5; color: #9a3412; }
        .pi-note.is-info { background: #e8eef8; color: #002870; }
        .pi-note strong { font-size: 12px; }
        .pi-note span { opacity: .92; }
        .pi-foot {
          display: flex; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid #eef2f8;
        }
        .pi-btn {
          flex: 1; border: 1px solid #d0dae8; border-radius: 8px; padding: 8px 10px;
          background: #fff; color: #002870; font: 600 11px/1.2 "Roboto", "Segoe UI", sans-serif;
          cursor: pointer;
        }
        .pi-btn:hover { background: #e8eef8; }
        .pi-btn.primary { background: #0058d0; border-color: #0058d0; color: #fff; }
        .pi-btn.primary:hover { background: #0046a8; }
        .pi-btn:disabled { opacity: .4; cursor: not-allowed; }
        .pi-btn.is-on { background: #002870; border-color: #002870; color: #fff; }
        .pi-perm {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          padding: 8px 0; border-bottom: 1px solid #eef2f8;
        }
        .pi-perm:last-child { border-bottom: none; }
        .pi-perm-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .pi-perm-meta strong { font-size: 12px; }
        .pi-perm-meta span { font-size: 11px; color: #7a8aa3; text-transform: capitalize; }
        .pi-perm-actions { display: flex; gap: 4px; flex-shrink: 0; }
        .pi-perm-actions button {
          font: 600 10px/1 "Roboto", "Segoe UI", sans-serif;
          border: 1px solid #d0dae8; background: #f4f7fc; color: #002870;
          border-radius: 6px; padding: 5px 7px; cursor: pointer;
        }
        .pi-perm-actions button:hover { background: #e2eaf6; }
        .pi-toast {
          margin: 0 12px 10px; background: #0a1f45; color: #e8eef8;
          border-radius: 8px; padding: 8px 10px; font-size: 11px;
        }
      </style>`;
    }

    static #markup() {
      return `
        <div class="pi-root">
          <div class="pi-panel" id="piPanel" role="dialog" aria-label="GOSAFE Page Insights">
            <header class="pi-head">
              <div class="pi-score is-fair" id="piScore">—</div>
              <div class="pi-head-copy">
                <strong>Page Insights</strong>
                <div class="pi-head-meta">
                  <small id="piHost">—</small>
                  <span class="pi-verdict" id="piVerdict">—</span>
                </div>
              </div>
              <div class="pi-actions">
                <button type="button" class="pi-icon" id="piRefresh" title="Refresh" aria-label="Refresh">↻</button>
                <button type="button" class="pi-icon" id="piClose" title="Close" aria-label="Close">✕</button>
              </div>
            </header>
            <nav class="pi-tabs" aria-label="Sections">
              <button type="button" data-pi-tab="overview" class="is-on">Score</button>
              <button type="button" data-pi-tab="privacy">Privacy</button>
              <button type="button" data-pi-tab="patterns">Patterns</button>
              <button type="button" data-pi-tab="speed">Speed</button>
              <button type="button" data-pi-tab="perms">Perms</button>
            </nav>
            <div class="pi-body">
              <section data-pi-pane="overview">
                <div class="pi-meters" id="piPillars"></div>
                <div id="piSub" hidden></div>
                <p class="pi-sec-label">Top issues</p>
                <div class="pi-stack" id="piIssues"></div>
              </section>
              <section data-pi-pane="privacy" hidden>
                <p class="pi-sec-label">What this page collects</p>
                <div class="pi-stack" id="piReceipt"></div>
              </section>
              <section data-pi-pane="patterns" hidden>
                <p class="pi-sec-label">Dark patterns · <span id="piDarkCount">0</span></p>
                <div class="pi-stack" id="piDark"></div>
                <div class="pi-foot">
                  <button type="button" class="pi-btn" id="piHlToggle">Outline on page</button>
                </div>
              </section>
              <section data-pi-pane="speed" hidden>
                <p class="pi-sec-label">Heavy third parties</p>
                <div class="pi-stack" id="piPerf"></div>
                <div class="pi-foot">
                  <button type="button" class="pi-btn primary" id="piOptimize">Block for this session</button>
                </div>
              </section>
              <section data-pi-pane="perms" hidden>
                <p class="pi-sec-label">Site permissions</p>
                <div id="piPerms"></div>
              </section>
            </div>
            <div class="pi-toast" id="piToast" hidden></div>
          </div>
        </div>`;
    }
  }

  // Highlight styles in page (outside shadow)
  const pageStyle = document.createElement("style");
  pageStyle.textContent = `
    .gosafe-pi-hl { outline: 2px solid #0058d0 !important; outline-offset: 2px !important; }
    .gosafe-pi-hl[data-gosafe-pi-kind="confirmshame"] { outline-color: #c62828 !important; }
    .gosafe-pi-hl[data-gosafe-pi-kind="prechecked"] { outline-color: #b45309 !important; }
    .gosafe-pi-hl[data-gosafe-pi-kind="hidden_exit"] { outline-color: #002870 !important; }
    .gosafe-pi-hl[data-gosafe-pi-kind="urgency"] { outline-color: #c2410c !important; }
  `;

  class PageInsightsApp {
    constructor() {
      this._ui = new InsightsUi();
      this._enabled = false;
      this._cache = null;
    }

    start() {
      if (!FeatureGate.on()) {
        this.stop();
        return;
      }
      this._enabled = true;
      if (!document.getElementById("gosafe-pi-hl-style")) {
        pageStyle.id = "gosafe-pi-hl-style";
        (document.head || document.documentElement).appendChild(pageStyle);
      }
      // No floating button — only open when requested (popup / message).
    }

    stop() {
      this._enabled = false;
      this._ui.close();
      this._cache = null;
      document.getElementById("gosafe-pi-hl-style")?.remove();
    }

    open() {
      if (!FeatureGate.on()) return { ok: false, disabled: true };
      this.start();
      this._ui.open();
      return { ok: true };
    }

    close() {
      this._ui.close();
      return { ok: true };
    }

    summary() {
      if (this._ui._report) {
        const r = this._ui._report;
        this._cache = r;
        return {
          ok: true,
          health: r.health,
          host: r.host,
          subscription: r.subscription,
          darkCount: r.dark.count,
          thirdPartyHosts: r.privacy.thirdPartyHosts,
          piiFieldCount: r.privacy.piiFieldCount,
        };
      }
      if (this._cache) {
        const r = this._cache;
        return {
          ok: true,
          health: r.health,
          host: r.host,
          subscription: r.subscription,
          darkCount: r.dark.count,
          thirdPartyHosts: r.privacy.thirdPartyHosts,
          piiFieldCount: r.privacy.piiFieldCount,
        };
      }
      return { ok: false };
    }

    async ensureSummary() {
      const current = this.summary();
      if (current.ok) return current;
      let trustSafety = null;
      try {
        const trust = await chrome.runtime.sendMessage({
          type: "getTrustScore",
          url: location.href,
          thirdPartyScripts: PageScan.scriptThirdPartyCount(),
        });
        if (trust?.ok) trustSafety = Number(trust.safety);
      } catch {
        // ignore
      }
      const full = await PageScan.fullReport(trustSafety);
      this._cache = full;
      return {
        ok: true,
        health: full.health,
        host: full.host,
        subscription: full.subscription,
        darkCount: full.dark.count,
        thirdPartyHosts: full.privacy.thirdPartyHosts,
        piiFieldCount: full.privacy.piiFieldCount,
      };
    }
  }

  const app = new PageInsightsApp();

  function sync() {
    if (FeatureGate.on()) app.start();
    else app.stop();
  }

  const boot = () => sync();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  const attrMo = new MutationObserver(() => sync());
  attrMo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-gosafe-page-insights", "data-adblock-lite"],
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "openPageInsights") {
      sendResponse(app.open());
      return false;
    }
    if (message?.type === "closePageInsights") {
      sendResponse(app.close());
      return false;
    }
    if (message?.type === "getPageInsightsSummary") {
      if (!FeatureGate.on()) {
        sendResponse({ ok: false, disabled: true });
        return false;
      }
      app.ensureSummary().then(sendResponse);
      return true;
    }
    return false;
  });
})();
