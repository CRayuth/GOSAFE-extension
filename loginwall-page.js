(() => {
  "use strict";

  // MAIN world — dismiss signup / login walls so users can peek at public content.

  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return true;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-adblock-lite-loginwall") !== "off";
    }
  }

  class SiteContext {
    static host() {
      return (location.hostname || "").replace(/^www\./, "").toLowerCase();
    }

    static isAuthDestination() {
      const host = SiteContext.host();
      if (
        /^(accounts|login|signin|auth|sso|id|oauth|passport)\./i.test(host) ||
        /\.(auth0|okta|onelogin|microsoftonline)\./i.test(host)
      ) {
        return true;
      }
      const path = (location.pathname || "").toLowerCase();
      if (/^\/(login|signin|signup|register|join)\/?$/i.test(path)) {
        if (host === "facebook.com" || host === "fb.com" || host.endsWith(".facebook.com")) {
          return true;
        }
      }
      return false;
    }

    static isQuora() {
      return SiteContext.host() === "quora.com" || SiteContext.host().endsWith(".quora.com");
    }

    static isFacebook() {
      const h = SiteContext.host();
      return h === "facebook.com" || h === "fb.com" || h.endsWith(".facebook.com") || h === "fb.watch";
    }

    static isX() {
      const h = SiteContext.host();
      return h === "x.com" || h === "twitter.com" || h.endsWith(".twitter.com");
    }
  }

  class EventBus {
    static #lastAt = 0;

    static emit(title, detail = "") {
      const now = Date.now();
      if (now - EventBus.#lastAt < 4000) return;
      EventBus.#lastAt = now;
      try {
        window.postMessage(
          {
            source: "adblock-lite",
            type: "log",
            entry: {
              kind: "login_wall",
              title,
              detail,
              host: SiteContext.host(),
              ts: now,
            },
          },
          "*"
        );
      } catch {
        // ignore
      }
    }
  }

  /**
   * Quora: `?share=1` is the reliable guest-read flag; then strip any leftover wall/blur.
   */
  class QuoraBypass {
    static #SHARE_KEY = "ablQuoraShare";

    /** Force share=1 once per navigation (Quora's built-in guest mode). */
    static ensureShareParam() {
      if (!SiteContext.isQuora() || !FeatureGate.on()) return false;
      try {
        const url = new URL(location.href);
        if (url.searchParams.get("share") === "1") return false;
        // Avoid loops
        if (sessionStorage.getItem(QuoraBypass.#SHARE_KEY) === url.pathname + url.search) {
          return false;
        }
        url.searchParams.set("share", "1");
        sessionStorage.setItem(QuoraBypass.#SHARE_KEY, url.pathname + url.search);
        location.replace(url.toString());
        return true;
      } catch {
        return false;
      }
    }

    /**
     * Hide Quora auth cards even when they are normal in-flow layout (homepage gate).
     * @returns {number}
     */
    static neutralizeDom() {
      if (!SiteContext.isQuora()) return 0;
      let n = 0;

      // Scroll-lock / wall classes Quora toggles on <body>/<html>
      for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        for (const cls of [...el.classList]) {
          if (/signup|login|wall|prevent_scroll|modal|overflow/i.test(cls)) {
            el.classList.remove(cls);
            n += 1;
          }
        }
      }

      const markers =
        /continue with google|continue with facebook|sign up with email|forgot password|a place to share knowledge|your email|your password/i;

      /** @type {HTMLElement[]} */
      const candidates = [];
      for (const el of document.querySelectorAll("div, section, form, aside, main")) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.dataset.ablLoginwall === "1") continue;
        if (el === document.body || el === document.documentElement) continue;
        const text = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (text.length < 40 || text.length > 2500) continue;
        if (!markers.test(text)) continue;
        const hasPass = Boolean(
          el.querySelector(
            'input[type="password"], input[placeholder*="password" i], input[name="password"]'
          )
        );
        const hasSocial =
          /continue with google/i.test(text) ||
          Boolean(el.querySelector('button, [role="button"], a'));
        if (hasPass || (/continue with google/i.test(text) && /login/i.test(text))) {
          candidates.push(el);
        } else if (hasSocial && /sign up with email/i.test(text) && /login/i.test(text)) {
          candidates.push(el);
        }
      }

      // Prefer smallest matching containers (avoid hiding entire page shell)
      candidates.sort((a, b) => {
        const aa = a.getBoundingClientRect();
        const bb = b.getBoundingClientRect();
        return aa.width * aa.height - bb.width * bb.height;
      });

      const hide = new Set();
      for (const el of candidates) {
        // Skip if an ancestor is already queued
        let skip = false;
        for (const h of hide) {
          if (h.contains(el)) {
            skip = true;
            break;
          }
        }
        if (skip) continue;

        // Climb to a card-sized parent (white login panel) but stop before body
        let target = el;
        let parent = el.parentElement;
        let steps = 0;
        while (parent && parent !== document.body && steps < 6) {
          const pt = (parent.innerText || "").replace(/\s+/g, " ").trim();
          // Parent still mostly the auth UI
          if (pt.length < textLen(el) * 1.8 && markers.test(pt)) {
            target = parent;
            parent = parent.parentElement;
            steps += 1;
            continue;
          }
          break;
        }
        hide.add(target);
      }

      function textLen(node) {
        return ((node.innerText || "").replace(/\s+/g, " ").trim()).length;
      }

      for (const el of hide) {
        // Never hide html/body
        if (el === document.body || el === document.documentElement) continue;
        const r = el.getBoundingClientRect();
        // Avoid nuking a full-viewport shell that also holds real answers
        const hasAnswers = Boolean(
          el.querySelector(
            '.q-box.qu-borderAll, [class*="Answer"], [class*="answer"], .puppeteer_test_answer_content'
          )
        );
        if (hasAnswers && r.height > window.innerHeight * 0.85) {
          // Hide only nested auth forms inside
          for (const form of el.querySelectorAll("form")) {
            if (!(form instanceof HTMLElement)) continue;
            if (/password|continue with google/i.test(form.innerText || "")) {
              WallNeutralizer.hide(form);
              n += 1;
            }
          }
          continue;
        }
        WallNeutralizer.hide(el);
        n += 1;
      }

      // Backdrops / masks
      for (const el of document.querySelectorAll("div")) {
        if (!(el instanceof HTMLElement) || el.dataset.ablLoginwall === "1") continue;
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed") continue;
        const r = el.getBoundingClientRect();
        if (r.width < window.innerWidth * 0.9 || r.height < window.innerHeight * 0.9) continue;
        const bg = cs.backgroundColor;
        const text = (el.innerText || "").trim();
        // Dim overlay with little/no text
        if (text.length < 20 || /continue with google|log\s*in/i.test(text)) {
          const opacity = Number.parseFloat(cs.opacity || "1");
          if (opacity < 1 || /rgba|0\.\d+\)/.test(bg) || text.length < 20) {
            WallNeutralizer.hide(el);
            n += 1;
          }
        }
      }

      ScrollUnlock.apply();
      return n;
    }
  }

  class StyleInjector {
    static #ID = "adblock-lite-loginwall";

    static css() {
      return `
html.abl-loginwall-open,
html.abl-loginwall-open body {
  overflow: auto !important;
  overflow-x: auto !important;
  overflow-y: auto !important;
  height: auto !important;
  max-height: none !important;
  position: static !important;
}
html.abl-loginwall-open body {
  filter: none !important;
}
[data-abl-loginwall="1"] {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  opacity: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
}

/* Quora — modal + homepage gate + blur */
.signup_login_modal,
.modal_signup_dialog,
.NewLoggedOutModalBase,
[class*="SignupModal"],
[class*="LoginModal"],
[class*="signup_wall" i],
[class*="SignupWall"],
div[class*="q-click-wrapper"][class*="Modal"],
div[role="dialog"][aria-modal="true"],
form:has(input[type="password"]):has(button),
div:has(> form input[type="password"]):has(button),
.qu-modal,
.ModalWrapper,
.BaseSignupFormNew,
div.BaseSignupForm {
  display: none !important;
}
body.signup_wall_prevent_scroll,
html.signup_wall_prevent_scroll,
body[class*="signup_wall"],
html[class*="signup_wall"] {
  overflow: auto !important;
  position: static !important;
  height: auto !important;
}
[style*="blur("],
.qu-blur,
[class*="Blurred"],
[class*="content_blur"] {
  filter: none !important;
  -webkit-filter: none !important;
}

/* Facebook */
div[data-testid="cookie-policy-manage-dialog"],
#login_popup_cta_form,
div[data-testid="royal_login_form"],
div[role="dialog"]:has(input[name="email"]):has(input[name="pass"]) {
  display: none !important;
}

/* X */
div[data-testid="sheetDialog"]:has(a[href*="signup"]),
div[data-testid="mask"],
div[data-testid="bottomBar"] {
  display: none !important;
}

/* LinkedIn / Instagram / Reddit */
div.authwall-join-form,
div.authentication-outlet,
section.join-form,
div[class*="join-wall"],
div[role="dialog"]:has(input[name="username"]),
div.XPromoPopup,
div[class*="PremiumModal"] {
  display: none !important;
}
`.trim();
    }

    static inject() {
      if (document.getElementById(StyleInjector.#ID)) return;
      const style = document.createElement("style");
      style.id = StyleInjector.#ID;
      style.textContent = StyleInjector.css();
      (document.documentElement || document.head || document.body).appendChild(style);
    }
  }

  class LoginWallDetector {
    static #CTA =
      /sign\s*up|sign\s*in|log\s*in|log\s*on|create (an )?account|join (now|for free)|continue with (google|facebook|apple)|register|forgot password|sign up with email/i;

    static textSample(el) {
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 600);
    }

    static coversViewport(el) {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      if (r.width < vw * 0.3 || r.height < vh * 0.2) return false;
      return r.width * r.height >= vw * vh * 0.15;
    }

    static looksPositioned(el) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (cs.position === "fixed" || cs.position === "sticky") return true;
      if (cs.position === "absolute") {
        const z = Number.parseInt(cs.zIndex, 10);
        return Number.isFinite(z) && z >= 5;
      }
      return el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true";
    }

    static isLoginWall(el) {
      if (!(el instanceof HTMLElement)) return false;
      if (el.dataset.ablLoginwall === "1") return false;
      if (el.tagName === "HTML" || el.tagName === "BODY" || el.tagName === "MAIN") return false;

      const text = LoginWallDetector.textSample(el);
      if (!text || text.length < 12) return false;
      if (!LoginWallDetector.#CTA.test(text)) return false;

      const hasAuthUi = Boolean(
        el.querySelector(
          'input[type="password"], input[name="pass"], input[name="email"], input[name="username"], input[placeholder*="password" i], input[placeholder*="email" i]'
        )
      );

      const positioned = LoginWallDetector.looksPositioned(el);
      const covers = LoginWallDetector.coversViewport(el);

      // In-flow homepage gates (Quora) — allow without fixed position
      if (!positioned) {
        if (!(hasAuthUi && /continue with google|forgot password|sign up with email/i.test(text))) {
          return false;
        }
        if (text.length > 2200) return false;
      } else if (!covers && el.getAttribute("role") !== "dialog") {
        if (!hasAuthUi) return false;
      }

      return hasAuthUi || /continue with google/i.test(text);
    }

    static findAll() {
      /** @type {HTMLElement[]} */
      const hits = [];
      const nodes = document.querySelectorAll(
        'div, section, form, aside, [role="dialog"], [aria-modal="true"]'
      );
      for (const el of nodes) {
        if (el instanceof HTMLElement && LoginWallDetector.isLoginWall(el)) hits.push(el);
      }
      return hits;
    }
  }

  class ScrollUnlock {
    static apply() {
      document.documentElement?.classList.add("abl-loginwall-open");
      for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        el.style.setProperty("overflow", "auto", "important");
        el.style.setProperty("position", "static", "important");
        el.style.setProperty("height", "auto", "important");
        el.style.setProperty("max-height", "none", "important");
        el.style.setProperty("filter", "none", "important");
      }
      for (const el of document.querySelectorAll("*")) {
        if (!(el instanceof HTMLElement)) continue;
        const cs = getComputedStyle(el);
        if (cs.filter && cs.filter !== "none" && /blur/i.test(cs.filter)) {
          el.style.setProperty("filter", "none", "important");
          el.style.setProperty("-webkit-filter", "none", "important");
        }
      }
    }
  }

  class WallNeutralizer {
    static #ATTR = "data-abl-loginwall";

    static hide(el) {
      if (!(el instanceof HTMLElement)) return;
      el.setAttribute(WallNeutralizer.#ATTR, "1");
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
      el.setAttribute("aria-hidden", "true");
    }

    static sweep() {
      if (!FeatureGate.on() || SiteContext.isAuthDestination()) return 0;
      let n = 0;

      if (SiteContext.isQuora()) {
        n += QuoraBypass.neutralizeDom();
      }

      for (const el of LoginWallDetector.findAll()) {
        if (el.dataset.ablLoginwall === "1") continue;
        WallNeutralizer.hide(el);
        n += 1;
      }

      if (n > 0 || SiteContext.isQuora() || SiteContext.isFacebook() || SiteContext.isX()) {
        ScrollUnlock.apply();
      }
      if (n > 0) {
        EventBus.emit("Dismissed signup / login wall", `${n} layer(s)`);
      }
      return n;
    }
  }

  class LoginWallController {
    constructor() {
      this._timer = 0;
      this._observer = null;
      this._scheduled = false;
    }

    start() {
      if (SiteContext.isAuthDestination()) return;
      if (!FeatureGate.on()) return;

      // Quora guest mode — must run before other logic
      if (QuoraBypass.ensureShareParam()) return;

      StyleInjector.inject();
      const run = () => {
        if (!FeatureGate.on()) return;
        WallNeutralizer.sweep();
      };
      run();
      this._timer = window.setInterval(run, 800);
      this._observer = new MutationObserver(() => this.schedule());
      if (document.documentElement) {
        this._observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "style"],
        });
      }
      document.addEventListener("DOMContentLoaded", run, { once: true });
      window.addEventListener("load", run, { once: true });
    }

    schedule() {
      if (this._scheduled) return;
      this._scheduled = true;
      requestAnimationFrame(() => {
        this._scheduled = false;
        if (FeatureGate.on()) WallNeutralizer.sweep();
      });
    }
  }

  new LoginWallController().start();
})();
