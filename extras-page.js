(() => {
  "use strict";

  // MAIN world — cookie decline, anti-adblock, autoplay, popup/tab under block.

  class Gate {
    static on(name) {
      const root = document.documentElement;
      if (!root) return true;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      if (root.getAttribute("data-adblock-lite-quiet") === "on" && name === "tips") {
        return false;
      }
      return root.getAttribute(`data-adblock-lite-${name}`) !== "off";
    }
  }

  class EventBus {
    static #lastKey = "";
    static #lastAt = 0;

    static emit(entry) {
      if (!Gate.on("tips") && entry?.kind === "system") return;
      try {
        const key = `${entry.kind}|${entry.title}`;
        const now = Date.now();
        if (key === EventBus.#lastKey && now - EventBus.#lastAt < 4000) return;
        EventBus.#lastKey = key;
        EventBus.#lastAt = now;
        window.postMessage(
          {
            source: "adblock-lite",
            type: "log",
            entry: {
              kind: entry.kind,
              title: entry.title,
              detail: entry.detail || "",
              host: (location.hostname || "").replace(/^www\./, ""),
              ts: now,
            },
          },
          "*"
        );
        if (Gate.on("adaptive") && entry?.learn !== false) {
          window.postMessage(
            {
              source: "adblock-lite",
              type: "learn",
              entry: {
                kind: entry.kind || "dismiss",
                title: entry.title || "",
                detail: entry.detail || "",
                selector: entry.selector || "",
                host: (location.hostname || "").replace(/^www\./, ""),
              },
            },
            "*"
          );
        }
      } catch {
        // ignore
      }
    }
  }

  class CookieConsentGuard {
    /** Locale packs — reject / essential-only labels by region. */
    static #LOCALE_RE = Object.freeze({
      en: /^(reject|decline|deny|refuse|disagree|reject all|decline all|only necessary|necessary only|essential only|save without|continue without|reject non|opt.?out)/i,
      de: /^(ablehnen|alles ablehnen|nur notwendige|einstellungen|nein|widersprechen|ablehnen alle)/i,
      fr: /^(refuser|tout refuser|continuer sans accepter|uniquement n[eé]cessaires|refuser tout|je refuse)/i,
      es: /^(rechazar|rechazar todo|solo necesarias|rechazar todas|no aceptar|denegar)/i,
      it: /^(rifiuta|rifiuta tutto|solo necessari|nega|non accettare)/i,
      pt: /^(rejeitar|rejeitar tudo|apenas necess[aá]rios|recusar|negar)/i,
      nl: /^(weigeren|alles weigeren|alleen noodzakelijk|weiger)/i,
      pl: /^(odrzu[cć]|odrzuć wszystkie|tylko niezb[eę]dne|nie zgadzam)/i,
      ru: /^(отклонить|отклонить все|только необходимые|отказ)/i,
      ja: /(拒否|すべて拒否|必要最小限|同意しない)/,
      ko: /(거부|모두 거부|필수만|동의 안 함)/,
      zh: /(拒绝|全部拒绝|仅必要|不同意|拒绝全部)/,
      th: /(ปฏิเสธ|ปฏิเสธทั้งหมด|จำเป็นเท่านั้น)/,
      vi: /(t[uừ] ch[oố]i|ch[iỉ] c[aầ]n thi[eế]t|không đồng ý)/i,
      km: /(បដិសេធ|បដិសេធទាំងអស់|ចាំបាច់តែប៉ុណ្ណោះ|មិនយល់ព្រម)/,
      id: /(tolak|tolak semua|hanya yang diperlukan|tidak setuju)/i,
      ar: /(رفض|رفض الكل|الضرورية فقط)/,
    });

    static #TEXT =
      /reject all|decline all|only (use )?necessary|necessary cookies only|essential only|refuse|disagree|do not sell|opt out|reject non-essential|reject optional|ablehnen|refuser tout|rechazar todo|rifiuta tutto|nur notwendige|uniquement n[eé]cessaires|solo necesarias|tylko niezb|только необходим|すべて拒否|모두 거부|全部拒绝|ปฏิเสธทั้งหมด|từ chối|បដិសេធ|tolak semua/i;

    static #langs() {
      const list = [];
      try {
        for (const l of navigator.languages || []) list.push(String(l).toLowerCase());
      } catch {
        // ignore
      }
      try {
        list.push(String(navigator.language || "").toLowerCase());
      } catch {
        // ignore
      }
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
        if (/Phnom_Penh|Bangkok/i.test(tz)) list.push("km", "th");
        if (/Ho_Chi_Minh|Saigon/i.test(tz)) list.push("vi");
        if (/Jakarta/i.test(tz)) list.push("id");
        if (/Shanghai|Hong_Kong|Taipei/i.test(tz)) list.push("zh");
        if (/Tokyo/i.test(tz)) list.push("ja");
        if (/Seoul/i.test(tz)) list.push("ko");
      } catch {
        // ignore
      }
      list.push("en");
      return [...new Set(list.map((l) => l.split("-")[0]).filter(Boolean))];
    }

    static #matches(label) {
      if (CookieConsentGuard.#TEXT.test(label)) return true;
      for (const code of CookieConsentGuard.#langs()) {
        const re = CookieConsentGuard.#LOCALE_RE[code];
        if (re && re.test(label)) return true;
      }
      // Fallback: any pack (sites often show English buttons abroad)
      for (const re of Object.values(CookieConsentGuard.#LOCALE_RE)) {
        if (re.test(label)) return true;
      }
      return false;
    }

    static tick() {
      if (!Gate.on("cookie")) return;
      const buttons = document.querySelectorAll(
        "button, [role='button'], a, input[type='button'], input[type='submit']"
      );
      for (const el of buttons) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.dataset.ablCookieTried === "1") continue;
        const label = (
          el.getAttribute("aria-label") ||
          el.innerText ||
          el.value ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        if (!label || label.length > 60) continue;
        if (!CookieConsentGuard.#matches(label)) continue;
        el.dataset.ablCookieTried = "1";
        try {
          el.click();
          EventBus.emit({
            kind: "system",
            title: "Declined cookie banner",
            detail: label.slice(0, 60),
            selector: "[class*='cookie' i],[id*='cookie' i],[class*='consent' i]",
          });
          break;
        } catch {
          // ignore
        }
      }
    }
  }

  class AntiAdblockGuard {
    static #STYLE_ID = "adblock-lite-antiadblock";

    static #SELECTORS = [
      "[class*='adblock-modal' i]",
      "[class*='adblock_modal' i]",
      "[class*='adblock-detected' i]",
      "[class*='adb-enabled' i]",
      "[class*='please-disable-adblock' i]",
      "[id*='adblock-modal' i]",
      "[id*='adblock_detected' i]",
      "[class*='disable-adblock' i]",
      "[class*='adblocker-detected' i]",
      "[data-nosnippet][class*='adblock' i]",
      "[class*='adb-warning' i]",
      "[class*='no-adblock' i]",
      "[id*='block-adb' i]",
      "[id*='adb-enabled' i]",
    ];

    static #WALL_RE =
      /please disable (your )?ad.?block|adblock(er)? (detected|found)|turn off (your )?ad.?block|to watch.{0,48}ad.?block|whitelist this site|allow ads on this|disable.{0,20}ad.?block.{0,20}(to|continue|watch|stream)|ad.?block.{0,24}(detected|found|enabled)|stop.{0,12}ad.?block/i;

    static isStreamPage() {
      const root = document.documentElement;
      if (root?.getAttribute("data-adblock-lite-stream") === "on") return true;
      const host = (location.hostname || "").toLowerCase();
      const path = (location.pathname || "").toLowerCase();
      return (
        /stream|sport|soccer|football|live|liveru|livetv|fight|nba|nfl|movie|film|khhd|anime|rpmvip|rbtv|rbtvplus|superabbit/i.test(
          host
        ) || /\/(soccer|football|live|match|stream|watch|movie|episode|play)\b/i.test(path)
      );
    }

    static injectCss() {
      if (document.getElementById(AntiAdblockGuard.#STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = AntiAdblockGuard.#STYLE_ID;
      style.textContent = `${AntiAdblockGuard.#SELECTORS.join(",")}{display:none!important;visibility:hidden!important;pointer-events:none!important;}`;
      (document.documentElement || document.head).appendChild(style);
    }

    static softenDetection() {
      try {
        const bait = document.createElement("div");
        bait.className =
          "adsbox ad-banner adsbygoogle pub_300x250 pub_300x250m pub_728x90 text-ad textAd text_ad text_ads text-ads text-ad-links";
        bait.id = "adblock-lite-bait";
        bait.setAttribute("data-adblockkey", "true");
        Object.assign(bait.style, {
          height: "1px",
          width: "1px",
          position: "absolute",
          left: "-9999px",
          top: "-9999px",
          display: "block",
        });
        (document.documentElement || document.body)?.appendChild(bait);

        // Common stream-site probes expect these globals to look "healthy".
        if (AntiAdblockGuard.isStreamPage()) {
          try {
            window.canRunAds = true;
            window.canShowAds = true;
            window.isAdBlockActive = false;
            window.adsbygoogle = window.adsbygoogle || [];
            window.adsbygoogle.loaded = true;
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    static tick() {
      if (!Gate.on("antiadblock")) return;
      AntiAdblockGuard.injectCss();
      const kill = [];
      const root = document.body || document.documentElement;
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (!(el instanceof HTMLElement)) continue;
        if (el.closest?.("video, audio, .jwplayer, .plyr, .video-js, #movie_player")) {
          continue;
        }
        const text = (el.innerText || "").trim();
        if (!text || text.length > 280) continue;
        if (!AntiAdblockGuard.#WALL_RE.test(text)) continue;
        // Prefer a card/overlay ancestor; fall back to the text node itself.
        let card =
          el.closest(
            "[role='dialog'], dialog, .modal, .popup, [class*='modal' i], [class*='overlay' i], [class*='adblock' i], [class*='adb' i]"
          ) || el;
        if (!(card instanceof HTMLElement) || card === document.body || card === document.documentElement) {
          continue;
        }
        // On stream pages, also hide fixed full-screen dimmers that only carry the wall text.
        if (AntiAdblockGuard.isStreamPage()) {
          const cs = getComputedStyle(card);
          if (
            (cs.position === "fixed" || cs.position === "absolute") &&
            card.getBoundingClientRect().height > window.innerHeight * 0.2
          ) {
            kill.push(card);
            continue;
          }
        }
        kill.push(card);
      }
      for (const el of kill) {
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("pointer-events", "none", "important");
        EventBus.emit({
          kind: "system",
          title: "Hid anti-adblock wall",
          detail: (el.className || el.id || "modal").toString().slice(0, 80),
          selector: "[class*='adblock' i],[class*='adblocker' i]",
        });
      }
      try {
        if (
          AntiAdblockGuard.isStreamPage() ||
          !/\/(title|watch|movie|embed|player)\b/i.test(location.pathname || "")
        ) {
          // Stream walls often lock scroll; unlock carefully.
          if (AntiAdblockGuard.isStreamPage()) {
            document.documentElement.style.setProperty("overflow", "auto", "important");
            document.body?.style.setProperty("overflow", "auto", "important");
          }
        }
      } catch {
        // ignore
      }
    }
  }

  class AutoplayGuard {
    static #patched = false;
    static #gestureUntil = 0;

    static #PLAYER_UI =
      "video, audio, iframe, .plyr, .jwplayer, .video-js, .artplayer, .dplayer, [class*='player'], [id*='player'], [class*='vjs'], [class*='volume'], [class*='control'], media-controller, [role='slider'], input[type='range']";

    static #hadGesture() {
      return Date.now() <= AutoplayGuard.#gestureUntil;
    }

    static #markUserMedia(root) {
      const scope = root instanceof Element ? root : document;
      for (const media of scope.querySelectorAll?.("video, audio") || []) {
        media.dataset.ablUserPlay = "1";
        delete media.dataset.ablForcePause;
      }
      // Also mark page-level media when interacting with any player chrome.
      for (const media of document.querySelectorAll("video, audio")) {
        media.dataset.ablUserPlay = "1";
        delete media.dataset.ablForcePause;
      }
    }

    static install() {
      if (AutoplayGuard.#patched) return;
      AutoplayGuard.#patched = true;
      const proto = HTMLMediaElement.prototype;
      const origPlay = proto.play;
      if (typeof origPlay !== "function") return;
      proto.play = function patchedPlay(...args) {
        if (Gate.on("autoplay") && this instanceof HTMLMediaElement) {
          if (this.dataset.ablUserPlay === "1" || AutoplayGuard.#hadGesture()) {
            this.dataset.ablUserPlay = "1";
            delete this.dataset.ablForcePause;
            return origPlay.apply(this, args);
          }
          // Only block true autoplay (attribute / prior forced pause) — never unmuted playback alone.
          const looksAuto =
            this.autoplay ||
            this.hasAttribute("autoplay") ||
            this.dataset.ablForcePause === "1";
          if (looksAuto) {
            try {
              this.pause();
              this.muted = true;
              this.dataset.ablForcePause = "1";
            } catch {
              // ignore
            }
            return Promise.resolve();
          }
        }
        return origPlay.apply(this, args);
      };

      const markGesture = (event) => {
        AutoplayGuard.#gestureUntil = Date.now() + 5000;
        const t = event.target;
        if (!(t instanceof Element)) return;
        if (t.closest(AutoplayGuard.#PLAYER_UI) || t.closest("button, [role='button']")) {
          AutoplayGuard.#markUserMedia(t.closest(AutoplayGuard.#PLAYER_UI) || document);
        }
        const media = t.closest?.("video, audio");
        if (media) {
          media.dataset.ablUserPlay = "1";
          delete media.dataset.ablForcePause;
        }
      };
      for (const type of ["pointerdown", "keydown", "touchstart"]) {
        document.addEventListener(type, markGesture, true);
      }
    }

    static tick() {
      if (!Gate.on("autoplay")) return;
      // Only elements still marked autoplay — do not pause normal unmuted players.
      for (const media of document.querySelectorAll("video[autoplay], audio[autoplay]")) {
        if (!(media instanceof HTMLMediaElement)) continue;
        if (media.dataset.ablUserPlay === "1") continue;
        if (media.paused) continue;
        try {
          media.pause();
          media.muted = true;
          media.dataset.ablForcePause = "1";
        } catch {
          // ignore
        }
      }
    }
  }

  class PopupTabGuard {
    static #patched = false;

    static install() {
      if (PopupTabGuard.#patched) return;
      PopupTabGuard.#patched = true;
      const origOpen = window.open;
      window.open = function guardedOpen(url, name, specs) {
        if (Gate.on("popup")) {
          const href = String(url || "");
          // Block empty/nameless popunders and known junk targets.
          if (!href || href === "about:blank" || /doubleclick|popads|popcash|propeller|spinreward|conversions_tracking=|zone_id=/i.test(href)) {
            EventBus.emit({
              kind: "hijack",
              title: "Blocked popup / tab-under",
              detail: href.slice(0, 120),
            });
            return null;
          }
          // Without a recent user gesture, treat as hostile.
          if (!PopupTabGuard.#hadGesture()) {
            EventBus.emit({
              kind: "hijack",
              title: "Blocked background popup",
              detail: href.slice(0, 120),
            });
            return null;
          }
        }
        return origOpen.call(window, url, name, specs);
      };
      for (const type of ["pointerdown", "keydown", "touchstart"]) {
        document.addEventListener(type, () => PopupTabGuard.#markGesture(), true);
      }
    }

    static #gestureUntil = 0;
    static #markGesture() {
      PopupTabGuard.#gestureUntil = Date.now() + 2500;
    }
    static #hadGesture() {
      return Date.now() <= PopupTabGuard.#gestureUntil;
    }
  }

  class VideoPipGuard {
    static #STYLE_ID = "gosafe-video-pip-css";
    static #BTN = "gosafe-pip-btn";
    /** @type {WeakMap<HTMLVideoElement, HTMLButtonElement>} */
    static #btns = new WeakMap();
    /** @type {Set<HTMLButtonElement>} */
    static #allBtns = new Set();
    static #listening = false;

    /** Short-form / social feeds — many stacked <video>s; PiP logos spam the UI. */
    static #SHORT_FORM =
      /(^|\.)(tiktok\.com|douyin\.com|instagram\.com|threads\.net|facebook\.com|fb\.com|youtube\.com|youtu\.be|snapchat\.com|likee\.video|capcut\.com|lemon8-app\.com|triller\.co|rumble\.com)$/i;

    static #isShortFormHost() {
      const h = (location.hostname || "").replace(/^www\./, "").toLowerCase();
      if (VideoPipGuard.#SHORT_FORM.test(h)) return true;
      // YouTube Shorts path
      if (/youtube\.com$/i.test(h) && /\/shorts\b/i.test(location.pathname || "")) return true;
      return false;
    }

    static #injectCss() {
      let style = document.getElementById(VideoPipGuard.#STYLE_ID);
      if (!(style instanceof HTMLStyleElement)) {
        style = document.createElement("style");
        style.id = VideoPipGuard.#STYLE_ID;
        (document.documentElement || document.head).appendChild(style);
      }
      style.textContent = `
.${VideoPipGuard.#BTN} {
  z-index: 2147483000 !important;
  width: 36px !important;
  height: 36px !important;
  min-width: 36px !important;
  border: 0 !important;
  border-radius: 999px !important;
  background: #fff !important;
  color: #002870 !important;
  padding: 0 !important;
  margin: 0 6px !important;
  cursor: pointer !important;
  box-shadow: 0 4px 14px rgba(0,40,112,0.35) !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  overflow: hidden !important;
  flex: 0 0 auto !important;
  vertical-align: middle !important;
  pointer-events: auto !important;
  opacity: 1 !important;
}
.${VideoPipGuard.#BTN} img {
  width: 28px !important;
  height: 28px !important;
  object-fit: contain !important;
  display: block !important;
  pointer-events: none !important;
}
.${VideoPipGuard.#BTN}.is-fixed {
  position: fixed !important;
  margin: 0 !important;
}
.${VideoPipGuard.#BTN}.is-bar {
  position: relative !important;
}
.${VideoPipGuard.#BTN}.is-hidden {
  display: none !important;
}
.gosafe-video-ad-hide {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
`.trim();
    }

    static #ensureListen() {
      if (VideoPipGuard.#listening) return;
      VideoPipGuard.#listening = true;
      const reposition = () => VideoPipGuard.#repositionAll();
      window.addEventListener("scroll", reposition, true);
      window.addEventListener("resize", reposition, true);
    }

    static #hideAllButtons() {
      for (const btn of VideoPipGuard.#allBtns) {
        try {
          btn.classList.add("is-hidden");
          btn.style.display = "none";
        } catch {
          // ignore
        }
      }
    }

    /** Largest on-screen video (prefer playing). */
    static #primaryVideo() {
      /** @type {HTMLVideoElement | null} */
      let best = null;
      let bestScore = 0;
      for (const video of document.querySelectorAll("video")) {
        if (!(video instanceof HTMLVideoElement)) continue;
        if (video.closest("audio, [aria-hidden='true']")) continue;
        const r = video.getBoundingClientRect();
        if (r.width < 200 || r.height < 120) continue;
        const visW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
        const visH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
        if (visW < 160 || visH < 90) continue;
        const area = visW * visH;
        const playing = !video.paused && !video.ended ? 1.35 : 1;
        const score = area * playing;
        if (score > bestScore) {
          bestScore = score;
          best = video;
        }
      }
      return best;
    }

    /** @param {HTMLVideoElement} video */
    static #findControlBar(video) {
      const root =
        video.closest(
          ".plyr, .jwplayer, .video-js, .artplayer, .dplayer, media-controller, [class*='player' i], [id*='player' i]"
        ) || video.parentElement;
      if (!(root instanceof HTMLElement)) return null;
      // Avoid social-feed chrome (action bars / avatar columns) — only real player bars.
      const bar = root.querySelector(
        ".plyr__controls, .vjs-control-bar, .jw-controls, .jw-controlbar, .ytp-left-controls, .ytp-chrome-controls, .shaka-controls-button-panel, .vp-controls"
      );
      return bar instanceof HTMLElement ? bar : null;
    }

    /** @param {HTMLVideoElement} video */
    static #makeBtn(video) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = VideoPipGuard.#BTN;
      btn.title = "GOSAFE Picture in picture";
      btn.setAttribute("aria-label", "Picture in picture");
      const iconUrl = document.documentElement.getAttribute("data-gosafe-icon-url") || "";
      if (iconUrl) {
        const img = document.createElement("img");
        img.src = iconUrl;
        img.alt = "GOSAFE";
        img.width = 28;
        img.height = 28;
        btn.appendChild(img);
      } else {
        btn.textContent = "PiP";
      }
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          if (document.pictureInPictureElement === video) {
            await document.exitPictureInPicture();
          } else {
            if (video.paused) {
              try {
                video.dataset.ablUserPlay = "1";
                await video.play();
              } catch {
                // ignore
              }
            }
            await video.requestPictureInPicture();
            EventBus.emit({
              kind: "system",
              title: "Picture-in-picture",
              detail: location.hostname || "",
              learn: false,
            });
          }
        } catch {
          // PiP unsupported or blocked
        }
      });
      VideoPipGuard.#allBtns.add(btn);
      return btn;
    }

    /** @param {HTMLVideoElement} video @param {HTMLButtonElement} btn */
    static #placeNearPlay(video, btn) {
      const bar = VideoPipGuard.#findControlBar(video);
      if (bar) {
        const play =
          bar.querySelector(
            ".ytp-play-button, .vjs-play-control, .plyr__control--overlaid, .plyr__controls__item[data-plyr='play'], button[aria-label*='Play' i], button[title*='Play' i], .jw-icon-playback"
          ) || bar.firstElementChild;
        btn.classList.add("is-bar");
        btn.classList.remove("is-fixed", "is-hidden");
        btn.style.left = "";
        btn.style.top = "";
        if (play && play.parentElement === bar) {
          play.insertAdjacentElement("afterend", btn);
        } else if (!bar.contains(btn)) {
          bar.insertBefore(btn, bar.firstChild);
        }
        btn.style.display = "";
        return;
      }

      btn.classList.add("is-fixed");
      btn.classList.remove("is-bar", "is-hidden");
      if (btn.parentElement !== document.documentElement && btn.parentElement !== document.body) {
        (document.documentElement || document.body).appendChild(btn);
      } else if (!btn.isConnected) {
        (document.documentElement || document.body).appendChild(btn);
      }
      const r = video.getBoundingClientRect();
      const onScreen =
        r.width >= 200 &&
        r.height >= 120 &&
        r.bottom > 40 &&
        r.top < window.innerHeight - 20 &&
        r.right > 40 &&
        r.left < window.innerWidth - 20;
      if (!onScreen || video.ended) {
        btn.classList.add("is-hidden");
        btn.style.display = "none";
        return;
      }
      btn.style.display = "inline-flex";
      // Bottom-left of the video, clear of typical social action columns on the right.
      const left = Math.max(8, Math.min(window.innerWidth - 44, r.left + 12));
      const top = Math.max(8, Math.min(window.innerHeight - 44, r.bottom - 52));
      btn.style.left = `${Math.round(left)}px`;
      btn.style.top = `${Math.round(top)}px`;
    }

    static #repositionAll() {
      if (!Gate.on("pip") || VideoPipGuard.#isShortFormHost()) {
        VideoPipGuard.#hideAllButtons();
        return;
      }
      const primary = VideoPipGuard.#primaryVideo();
      for (const video of document.querySelectorAll("video")) {
        if (!(video instanceof HTMLVideoElement)) continue;
        const btn = VideoPipGuard.#btns.get(video);
        if (!btn) continue;
        if (video !== primary) {
          btn.classList.add("is-hidden");
          btn.style.display = "none";
          continue;
        }
        VideoPipGuard.#placeNearPlay(video, btn);
      }
    }

    /** @param {HTMLVideoElement} video */
    static #attach(video) {
      if (!(video instanceof HTMLVideoElement)) return;
      if (video.closest("audio, [aria-hidden='true']")) return;
      const rect = video.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 120) return;

      let btn = VideoPipGuard.#btns.get(video);
      if (!btn) {
        btn = VideoPipGuard.#makeBtn(video);
        VideoPipGuard.#btns.set(video, btn);
        video.dataset.gosafePip = "1";
      }
      VideoPipGuard.#placeNearPlay(video, btn);
    }

    /** Hide ad-like overlays sitting on top of video players (skip social feeds). */
    static #scrubOverlays() {
      if (VideoPipGuard.#isShortFormHost()) return;
      const videos = document.querySelectorAll("video");
      for (const video of videos) {
        if (!(video instanceof HTMLVideoElement)) continue;
        const box =
          video.closest(
            ".plyr, .jwplayer, .video-js, .artplayer, .dplayer, media-controller"
          ) || null;
        if (!(box instanceof HTMLElement)) continue;
        for (const el of box.querySelectorAll(
          "[class*='overlay-ad' i], [class*='vjs-overlay' i], [class*='ima-' i], .ad-container, .adsbox, .jw-ads"
        )) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.contains(video) || el === video) continue;
          if (el.classList.contains(VideoPipGuard.#BTN)) continue;
          if (el.querySelector("video")) continue;
          el.classList.add("gosafe-video-ad-hide");
        }
      }
    }

    static tick() {
      if (!Gate.on("pip")) {
        VideoPipGuard.#hideAllButtons();
        return;
      }
      if (!document.pictureInPictureEnabled) return;
      if (VideoPipGuard.#isShortFormHost()) {
        VideoPipGuard.#hideAllButtons();
        return;
      }
      VideoPipGuard.#injectCss();
      VideoPipGuard.#ensureListen();
      const primary = VideoPipGuard.#primaryVideo();
      // Hide every previous button first so orphans never linger.
      VideoPipGuard.#hideAllButtons();
      if (primary) VideoPipGuard.#attach(primary);
      VideoPipGuard.#scrubOverlays();
    }
  }

  class ExtrasApp {
    static #scheduled = false;

    static isSoftPageExempt() {
      const host = (location.hostname || "").replace(/^www\./, "").toLowerCase();
      if (host === "gmail.com" || host.endsWith(".gmail.com")) return true;
      if (host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")) return true;
      if (
        (host === "google.com" || host.endsWith(".google.com")) &&
        /^(mail|accounts|docs|drive|calendar|meet|chat|contacts|photos|sheets|slides|classroom|keep|script|sites|admin|myaccount|workspace|ogs|hangouts|inbox|tasks|news|play)\./i.test(
          host
        )
      ) {
        return true;
      }
      if (
        host === "facebook.com" ||
        host.endsWith(".facebook.com") ||
        host === "fb.com" ||
        host.endsWith(".fb.com") ||
        host === "messenger.com" ||
        host.endsWith(".messenger.com") ||
        host === "instagram.com" ||
        host.endsWith(".instagram.com") ||
        host === "meta.com" ||
        host.endsWith(".meta.com") ||
        host === "threads.net" ||
        host.endsWith(".threads.net") ||
        host === "whatsapp.com" ||
        host.endsWith(".whatsapp.com")
      ) {
        return true;
      }
      if (
        host === "nvidia.com" ||
        host.endsWith(".nvidia.com") ||
        host === "nvidiagrid.net" ||
        host.endsWith(".nvidiagrid.net") ||
        host === "auth0.com" ||
        host.endsWith(".auth0.com")
      ) {
        return true;
      }
      if (/\.edu(\.[a-z]{2})?$/i.test(host) || /\.ac\.[a-z]{2}$/i.test(host)) return true;
      if (
        /^(moodle|canvas|blackboard|brightspace|schoology|classroom|elearning|e-learning|lms)\./i.test(
          host
        )
      ) {
        return true;
      }
      if (/moodle|elearning|instructure\.com|blackboard|brightspace|schoology/i.test(host)) {
        return true;
      }
      return false;
    }

    start() {
      if (ExtrasApp.isSoftPageExempt()) return;
      PopupTabGuard.install();
      AutoplayGuard.install();
      if (Gate.on("antiadblock")) AntiAdblockGuard.softenDetection();

      const run = () => {
        CookieConsentGuard.tick();
        AntiAdblockGuard.tick();
        AutoplayGuard.tick();
        VideoPipGuard.tick();
      };
      setInterval(run, 1200);
      document.addEventListener("DOMContentLoaded", run, { once: true });
      new MutationObserver(() => {
        if (ExtrasApp.#scheduled) return;
        ExtrasApp.#scheduled = true;
        requestAnimationFrame(() => {
          ExtrasApp.#scheduled = false;
          run();
        });
      }).observe(document.documentElement, { childList: true, subtree: true });
      run();
    }
  }

  new ExtrasApp().start();
})();
