(() => {
  "use strict";

  /**
   * Facebook: inject Add Friend when Professional / creator profiles only show Follow.
   */
  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return false;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      // Missing attribute = on (content.js may race)
      return root.getAttribute("data-gosafe-fb-add-friend") !== "off";
    }
  }

  class FbHost {
    static ok() {
      const h = (location.hostname || "").replace(/^www\./, "").toLowerCase();
      return (
        h === "facebook.com" ||
        h.endsWith(".facebook.com") ||
        h === "fb.com" ||
        h.endsWith(".fb.com")
      );
    }

    static isProfilePage() {
      const path = location.pathname || "";
      const q = location.search || "";
      if (/profile\.php/i.test(path) && /[?&]id=\d+/i.test(q)) return true;
      if (/\/people\/[^/]+\/\d+/i.test(path)) return true;
      if (/\/user\/\d+/i.test(path)) return true;
      // Vanity profile with Follow CTA
      if (path.length > 1 && !/^\/(watch|marketplace|groups|gaming|reel|stories|friends|messages|settings|notifications)\b/i.test(path)) {
        return Boolean(AddFriendUi.findFollowButton());
      }
      return false;
    }
  }

  class FbTokens {
    static dtsg() {
      const input = document.querySelector('input[name="fb_dtsg"]');
      if (input instanceof HTMLInputElement && input.value) return input.value;
      try {
        const html = document.documentElement?.innerHTML || "";
        const m =
          /"DTSGInitialData"[^>]*>\s*\{"token":"([^"]+)"/.exec(html) ||
          /"dtsg"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/.exec(html) ||
          /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html) ||
          /fb_dtsg"?\s*[:=]\s*"([^"]+)"/.exec(html);
        if (m) return m[1];
      } catch {
        // ignore
      }
      return "";
    }

    static viewerId() {
      const m = /(?:^|;\s*)c_user=(\d+)/.exec(document.cookie || "");
      if (m) return m[1];
      try {
        const html = document.documentElement?.innerHTML || "";
        const u =
          /"USER_ID":"(\d+)"/.exec(html) ||
          /"userID":"(\d+)"/.exec(html) ||
          /"actorID":"(\d+)"/.exec(html);
        if (u) return u[1];
      } catch {
        // ignore
      }
      return "";
    }

    static lsd() {
      const input = document.querySelector('input[name="lsd"]');
      if (input instanceof HTMLInputElement && input.value) return input.value;
      try {
        const m = /"LSD"[^>]*>\s*\{"token":"([^"]+)"/.exec(
          document.documentElement?.innerHTML || ""
        );
        if (m) return m[1];
      } catch {
        // ignore
      }
      return "";
    }
  }

  class ProfileId {
    static fromUrl(href = location.href) {
      try {
        const u = new URL(href);
        const id = u.searchParams.get("id");
        if (id && /^\d{5,}$/.test(id)) return id;
        const people = u.pathname.match(/\/people\/[^/]+\/(\d{5,})/i);
        if (people) return people[1];
        const user = u.pathname.match(/\/user\/(\d{5,})\/?/i);
        if (user) return user[1];
      } catch {
        // ignore
      }
      return ProfileId.fromDom();
    }

    static fromDom() {
      const viewer = FbTokens.viewerId();
      for (const el of document.querySelectorAll(
        'meta[property="al:android:url"], meta[property="al:ios:url"], a[href*="profile.php?id="], a[href*="/user/"]'
      )) {
        const raw = el.getAttribute("content") || el.getAttribute("href") || "";
        const m =
          /[?&]id=(\d{5,})/.exec(raw) ||
          /\/user\/(\d{5,})/.exec(raw) ||
          /facebook\.com\/(\d{5,})/.exec(raw);
        if (m && m[1] !== viewer) return m[1];
      }
      try {
        const html = document.documentElement?.innerHTML?.slice(0, 800000) || "";
        const patterns = [
          /"profile_owner"\s*:\s*\{\s*"id"\s*:\s*"(\d{5,})"/,
          /"userID"\s*:\s*"(\d{5,})"/,
          /"profile_id"\s*:\s*"(\d{5,})"/,
          /"user_id"\s*:\s*"(\d{5,})"/,
        ];
        for (const re of patterns) {
          const m = re.exec(html);
          if (m && m[1] !== viewer) return m[1];
        }
      } catch {
        // ignore
      }
      return "";
    }
  }

  class FriendApi {
    static async send(friendId) {
      const dtsg = FbTokens.dtsg();
      const viewer = FbTokens.viewerId();
      if (!friendId) return { ok: false, detail: "No profile id" };
      if (!dtsg) return { ok: false, detail: "Not logged in (missing token)" };
      if (viewer && viewer === friendId) return { ok: false, detail: "This is your profile" };

      const legacy = await FriendApi.#legacy(friendId, dtsg, viewer);
      if (legacy.ok) return legacy;
      const gql = await FriendApi.#graphql(friendId, dtsg, viewer);
      if (gql.ok) return gql;
      return {
        ok: false,
        detail: gql.detail || legacy.detail || "Request failed — try the ▼ menu",
      };
    }

    static async #legacy(friendId, dtsg, viewer) {
      try {
        const body = new URLSearchParams();
        body.set("to_friend", friendId);
        body.set("action", "add_friend");
        body.set("how_found", "profile_button");
        body.set("ref_param", "none");
        body.set("fb_dtsg", dtsg);
        body.set("__a", "1");
        if (viewer) body.set("__user", viewer);
        const lsd = FbTokens.lsd();
        if (lsd) body.set("lsd", lsd);

        const res = await fetch("/ajax/add_friend/action.php?dpr=1", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: body.toString(),
        });
        const text = await res.text();
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
        if (/"error"\s*:\s*[1-9]/.test(text)) {
          return { ok: false, detail: "Facebook returned an error" };
        }
        if (/checkpoint/i.test(text)) return { ok: false, detail: "Facebook checkpoint" };
        if (text.length > 10) return { ok: true };
        return { ok: false, detail: "Empty response" };
      } catch (err) {
        return { ok: false, detail: String(err?.message || err) };
      }
    }

    static async #graphql(friendId, dtsg, viewer) {
      try {
        if (!viewer) return { ok: false, detail: "Not logged in" };
        const body = new URLSearchParams();
        body.set("fb_dtsg", dtsg);
        body.set("fb_api_caller_class", "RelayModern");
        body.set("fb_api_req_friendly_name", "FriendingCometFriendRequestSendMutation");
        body.set(
          "variables",
          JSON.stringify({
            input: {
              friend_requestee_ids: [friendId],
              friending_channel: "PROFILE_BUTTON",
              warn_ack_for_ids: [],
              actor_id: viewer,
              client_mutation_id: String(Date.now()),
            },
            scale: 1,
          })
        );
        body.set("doc_id", "24974393785534352");
        body.set("server_timestamps", "true");
        body.set("__user", viewer);
        const lsd = FbTokens.lsd();
        if (lsd) body.set("lsd", lsd);

        const res = await fetch("/api/graphql/", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-FB-Friendly-Name": "FriendingCometFriendRequestSendMutation",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: body.toString(),
        });
        const text = await res.text();
        if (!res.ok) return { ok: false, detail: `GraphQL HTTP ${res.status}` };
        if (/checkpoint/i.test(text)) return { ok: false, detail: "Facebook checkpoint" };
        if (/"errors"\s*:\s*\[/.test(text) && !/friend_request/i.test(text)) {
          return { ok: false, detail: "GraphQL error" };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: String(err?.message || err) };
      }
    }
  }

  class AddFriendUi {
    static #BTN_ID = "gosafe-fb-add-friend";
    static #STYLE_ID = "gosafe-fb-add-friend-css";
    static #busy = false;

    static #injectCss() {
      if (document.getElementById(AddFriendUi.#STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = AddFriendUi.#STYLE_ID;
      style.textContent = `
#${AddFriendUi.#BTN_ID} {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  min-width: 110px !important;
  min-height: 36px !important;
  padding: 0 16px !important;
  margin: 0 8px 0 0 !important;
  border: 0 !important;
  border-radius: 6px !important;
  background: #0866ff !important;
  color: #fff !important;
  font: 600 15px/1.2 "Segoe UI", Helvetica, Arial, sans-serif !important;
  cursor: pointer !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.18) !important;
  z-index: 2147483000 !important;
  position: relative !important;
  visibility: visible !important;
  opacity: 1 !important;
  pointer-events: auto !important;
}
#${AddFriendUi.#BTN_ID}.gosafe-fb-float {
  position: fixed !important;
  top: 72px !important;
  right: 18px !important;
  margin: 0 !important;
  min-height: 40px !important;
  padding: 0 18px !important;
  box-shadow: 0 6px 20px rgba(8,102,255,0.45) !important;
}
#${AddFriendUi.#BTN_ID}:hover { filter: brightness(1.06); }
#${AddFriendUi.#BTN_ID}:disabled { opacity: 0.75 !important; cursor: default !important; }
#${AddFriendUi.#BTN_ID}[data-state="sent"] {
  background: #e4e6eb !important;
  color: #050505 !important;
  box-shadow: none !important;
}
#${AddFriendUi.#BTN_ID}[data-state="err"] {
  background: #fce8e6 !important;
  color: #b32d00 !important;
}
`.trim();
      (document.head || document.documentElement).appendChild(style);
    }

    static #labelOf(el) {
      return `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`
        .replace(/\s+/g, " ")
        .trim();
    }

    /**
     * Facebook often keeps "Add friend" in the ▼ overflow menu (role=none wrappers),
     * not as a visible header button next to Follow.
     * @returns {Element[]}
     */
    static findAddFriendNodes() {
      /** @type {Element[]} */
      const nodes = [];
      const seen = new Set();
      for (const span of document.querySelectorAll("span")) {
        const t = (span.textContent || "").replace(/\s+/g, " ").trim();
        if (!/^add friend$/i.test(t)) continue;
        let el = span.parentElement;
        for (let i = 0; i < 10 && el; i += 1) {
          const aria = (el.getAttribute("aria-label") || "").trim();
          const role = el.getAttribute("role") || "";
          const isBtn =
            role === "button" ||
            el.tagName === "BUTTON" ||
            /^add friend$/i.test(aria) ||
            (role === "none" &&
              el.querySelector('[data-visualcompletion="ignore"]') &&
              el.getBoundingClientRect().width > 40);
          if (isBtn && !seen.has(el)) {
            seen.add(el);
            nodes.push(el);
            break;
          }
          el = el.parentElement;
        }
      }
      for (const el of document.querySelectorAll('[aria-label]')) {
        const aria = (el.getAttribute("aria-label") || "").trim();
        if (!/^add friend$/i.test(aria)) continue;
        if (seen.has(el)) continue;
        seen.add(el);
        nodes.push(el);
      }
      return nodes;
    }

    /**
     * True only if Add Friend is already a visible header action beside Follow/Message.
     * @param {Element|null} follow
     */
    static hasVisibleHeaderAddFriend(follow) {
      const nodes = AddFriendUi.findAddFriendNodes();
      if (!nodes.length) return false;
      const fr = follow?.getBoundingClientRect?.();
      for (const el of nodes) {
        if (el.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="list"]')) {
          continue;
        }
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 48 || r.height < 24) continue;
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (Number.parseFloat(cs.opacity || "1") < 0.3) continue;
        // Must sit in the profile header action band (same row as Follow when present)
        if (fr) {
          if (Math.abs(r.top - fr.top) > 48) continue;
          if (r.left < fr.left - 420 || r.left > fr.right + 80) continue;
        } else if (r.top > window.innerHeight * 0.7) {
          continue;
        }
        return true;
      }
      return false;
    }

    static findFollowButton() {
      /** @type {Element|null} */
      let best = null;
      let bestScore = 0;
      for (const el of document.querySelectorAll('[role="button"], button')) {
        if (!(el instanceof Element) || el.id === AddFriendUi.#BTN_ID) continue;
        const aria = (el.getAttribute("aria-label") || "").trim();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        const label = `${aria} ${text}`;
        if (!/\bfollow\b/i.test(label)) continue;
        if (/\b(following|unfollow|followers|follow back)\b/i.test(label)) continue;
        const exact = /^follow$/i.test(aria) || /^follow$/i.test(text);
        const r = el.getBoundingClientRect();
        if (r.width < 28 || r.height < 20) continue;
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        const score = (exact ? 100 : 40) + Math.min(r.width, 200) / 10 - r.top / 100;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return best;
    }

    /** @param {Element|null} follow */
    static #findMoreChevron(follow) {
      const root = follow?.closest("div")?.parentElement || document;
      const candidates = root.querySelectorAll
        ? root.querySelectorAll('[role="button"], button')
        : document.querySelectorAll('[role="button"], button');
      const fr = follow?.getBoundingClientRect?.();
      for (const el of candidates) {
        if (!(el instanceof Element) || el.id === AddFriendUi.#BTN_ID) continue;
        const aria = (el.getAttribute("aria-label") || "").trim();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) continue;
        if (
          /see (more|options)|more|profile settings|available options|see options/i.test(aria) ||
          (!text && /chevron|down|caret/i.test(el.innerHTML || "") && aria)
        ) {
          if (fr && Math.abs(r.top - fr.top) < 40) return el;
          if (!fr) return el;
        }
        // Icon-only gray button to the right of Follow/Search
        if (fr && !text && r.width >= 28 && r.width <= 48 && Math.abs(r.top - fr.top) < 30 && r.left > fr.right) {
          return el;
        }
      }
      // Broader: last small button in Follow's action row
      if (follow) {
        let row = follow.parentElement;
        for (let i = 0; i < 8 && row; i += 1) {
          const btns = [...row.querySelectorAll('[role="button"], button')].filter(
            (b) => b !== follow && b.id !== AddFriendUi.#BTN_ID
          );
          if (btns.length >= 2) {
            const last = btns[btns.length - 1];
            const r = last.getBoundingClientRect();
            if (r.width <= 56) return last;
          }
          row = row.parentElement;
        }
      }
      return null;
    }

    /** Direct child of row that contains follow (for safe insertBefore). */
    static #childContaining(row, node) {
      let el = node;
      while (el && el.parentElement !== row) el = el.parentElement;
      return el;
    }

    static #mountNearFollow(btn, follow) {
      try {
        let row = follow.parentElement;
        for (let i = 0; i < 10 && row; i += 1) {
          const kids = row.querySelectorAll('[role="button"], button');
          if (kids.length >= 2) break;
          row = row.parentElement;
        }
        if (!row) {
          follow.parentElement?.insertBefore(btn, follow);
          return true;
        }
        const anchor = AddFriendUi.#childContaining(row, follow) || follow;
        if (anchor.parentElement === row) {
          row.insertBefore(btn, anchor);
          return true;
        }
        row.appendChild(btn);
        return true;
      } catch {
        return false;
      }
    }

    static ensure() {
      if (!FeatureGate.on() || !FbHost.ok()) {
        document.getElementById(AddFriendUi.#BTN_ID)?.remove();
        return;
      }

      const follow = AddFriendUi.findFollowButton();
      const onProfile = FbHost.isProfilePage() || Boolean(follow) || Boolean(ProfileId.fromUrl());
      if (!onProfile) {
        document.getElementById(AddFriendUi.#BTN_ID)?.remove();
        return;
      }

      // Only skip if Add Friend is already visible in the header row (not buried in ▼)
      if (AddFriendUi.hasVisibleHeaderAddFriend(follow)) {
        document.getElementById(AddFriendUi.#BTN_ID)?.remove();
        return;
      }

      if (!follow && !ProfileId.fromUrl()) return;

      AddFriendUi.#injectCss();
      let btn = document.getElementById(AddFriendUi.#BTN_ID);
      if (!(btn instanceof HTMLButtonElement)) {
        btn = document.createElement("button");
        btn.id = AddFriendUi.#BTN_ID;
        btn.type = "button";
        btn.setAttribute("aria-label", "Add friend");
        btn.textContent = "Add friend";
        btn.addEventListener(
          "click",
          (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            AddFriendUi.#onClick(btn);
          },
          true
        );
      }

      let placed = false;
      if (follow) {
        btn.classList.remove("gosafe-fb-float");
        placed = AddFriendUi.#mountNearFollow(btn, follow);
      }
      if (!placed || !btn.isConnected) {
        btn.classList.add("gosafe-fb-float");
        (document.body || document.documentElement).appendChild(btn);
      }
    }

    static #sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    /** Prefer clicking Facebook's own Add friend control (often under ▼). */
    static async #clickNativeAddFriend(follow) {
      // Already in DOM (menu closed) — open chevron then click
      let nodes = AddFriendUi.findAddFriendNodes();
      const visible = nodes.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 12;
      });
      if (visible && !visible.closest('[role="menu"]')) {
        // Might still be off-screen / overflow — try click anyway after opening menu
      }

      const more = AddFriendUi.#findMoreChevron(follow);
      if (more instanceof HTMLElement) {
        more.click();
        await AddFriendUi.#sleep(350);
      }

      nodes = AddFriendUi.findAddFriendNodes();
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (el instanceof HTMLElement) {
          el.click();
          return true;
        }
      }
      // Try clicking the span's parent chain
      for (const span of document.querySelectorAll("span")) {
        if (!/^add friend$/i.test((span.textContent || "").trim())) continue;
        const r = span.getBoundingClientRect();
        if (r.width < 4) continue;
        let el = span;
        for (let i = 0; i < 6 && el; i += 1) {
          if (el instanceof HTMLElement) {
            el.click();
            return true;
          }
          el = el.parentElement;
        }
      }
      return false;
    }

    /** @param {HTMLButtonElement} btn */
    static async #onClick(btn) {
      if (AddFriendUi.#busy) return;
      AddFriendUi.#busy = true;
      btn.disabled = true;
      btn.dataset.state = "";
      btn.textContent = "Sending…";

      const follow = AddFriendUi.findFollowButton();
      let ok = false;
      let detail = "";
      try {
        ok = await AddFriendUi.#clickNativeAddFriend(follow);
      } catch (err) {
        detail = String(err?.message || err);
      }

      if (!ok) {
        const friendId = ProfileId.fromUrl();
        if (!friendId) {
          AddFriendUi.#busy = false;
          btn.disabled = false;
          btn.dataset.state = "err";
          btn.textContent = "No profile id";
          return;
        }
        const res = await FriendApi.send(friendId);
        ok = Boolean(res.ok);
        detail = res.detail || "";
      }

      AddFriendUi.#busy = false;
      if (ok) {
        btn.dataset.state = "sent";
        btn.textContent = "Request sent";
        btn.disabled = true;
      } else {
        btn.disabled = false;
        btn.dataset.state = "err";
        btn.title = detail || "Failed";
        btn.textContent = "Failed — try ▼";
        setTimeout(() => {
          if (btn.dataset.state === "err") btn.textContent = "Add friend";
        }, 2500);
      }
    }
  }

  class App {
    static #timer = 0;
    static #started = false;
    static #lastHref = "";

    static start() {
      if (App.#started) return;
      if (window !== window.top) return;
      if (!FbHost.ok()) return;
      App.#started = true;

      const tick = () => {
        if (!FeatureGate.on()) {
          document.getElementById("gosafe-fb-add-friend")?.remove();
          return;
        }
        if (location.href !== App.#lastHref) {
          App.#lastHref = location.href;
          document.getElementById("gosafe-fb-add-friend")?.remove();
        }
        try {
          AddFriendUi.ensure();
        } catch {
          // ignore
        }
      };

      tick();
      setInterval(tick, 900);
      document.addEventListener("DOMContentLoaded", tick, { once: true });
      try {
        new MutationObserver(() => {
          clearTimeout(App.#timer);
          App.#timer = setTimeout(tick, 250);
        }).observe(document.documentElement, { childList: true, subtree: true });
      } catch {
        // ignore
      }
    }
  }

  App.start();
})();
