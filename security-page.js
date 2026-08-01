(() => {
  "use strict";

  // MAIN world — clipboard hijack, scriptlets, permission spam.

  class FeatureFlags {
    static masterOn() {
      const root = document.documentElement;
      if (!root) return true;
      return root.getAttribute("data-adblock-lite") !== "off";
    }

    /** @param {string} name */
    static on(name) {
      if (!FeatureFlags.masterOn()) return false;
      const root = document.documentElement;
      if (!root) return true;
      return root.getAttribute(`data-adblock-lite-${name}`) !== "off";
    }
  }

  class GestureClock {
    static #at = 0;

    static install() {
      const mark = () => {
        GestureClock.#at = Date.now();
      };
      for (const type of ["pointerdown", "keydown", "touchstart"]) {
        document.addEventListener(type, mark, true);
      }
    }

    static recent(ms = 2500) {
      return Date.now() - GestureClock.#at < ms;
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Clipboard / crypto hijack guard
  // ---------------------------------------------------------------------------

  class CryptoAddress {
    static #PATTERNS = [
      /\b(bc1[a-z0-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/, // BTC
      /\b0x[a-fA-F0-9]{40}\b/, // ETH / EVM
      /\b[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}\b/, // LTC
      /\b[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93}\b/, // XMR
      /\b[A-Z2-7]{56}\b/, // XLM / near-format
      /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/, // TRX
      /\baddr1[a-z0-9]{50,120}\b/i, // ADA
      /\b(?:r|X)[1-9A-HJ-NP-Za-km-z]{24,34}\b/, // XRP-ish
    ];

    /** @param {string} text */
    static extract(text) {
      const raw = String(text || "");
      for (const re of CryptoAddress.#PATTERNS) {
        const m = raw.match(re);
        if (m) return m[0];
      }
      return "";
    }

    /** @param {string} text */
    static looksLike(text) {
      return Boolean(CryptoAddress.extract(text));
    }
  }

  class ClipboardGuard {
    static #lastUserCopy = "";

    static install() {
      document.addEventListener(
        "copy",
        () => {
          try {
            const sel = String(document.getSelection?.() || "");
            if (CryptoAddress.looksLike(sel)) {
              ClipboardGuard.#lastUserCopy = CryptoAddress.extract(sel);
            }
          } catch {
            // ignore
          }
        },
        true
      );

      const blockWrite = (text) => {
        if (!FeatureFlags.on("clipboard")) return false;
        const addr = CryptoAddress.extract(text);
        if (!addr) return false;
        // Allow if user just copied the same address themselves.
        if (ClipboardGuard.#lastUserCopy && ClipboardGuard.#lastUserCopy === addr) {
          return false;
        }
        // Silent script writes of wallet addresses without a fresh gesture → block.
        if (!GestureClock.recent(3000)) return true;
        // Gesture present but payload is a different wallet than selection → hijack.
        try {
          const sel = String(document.getSelection?.() || "");
          const selectedAddr = CryptoAddress.extract(sel);
          if (selectedAddr && selectedAddr !== addr) return true;
        } catch {
          // ignore
        }
        return false;
      };

      try {
        const proto = Navigator.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "clipboard");
        if (desc?.get) {
          const originalGet = desc.get;
          Object.defineProperty(proto, "clipboard", {
            configurable: true,
            get() {
              const clipboard = originalGet.call(this);
              if (!clipboard || clipboard.__adblockLitePatched) return clipboard;
              const writeText = clipboard.writeText?.bind(clipboard);
              const write = clipboard.write?.bind(clipboard);
              if (writeText) {
                clipboard.writeText = function patchedWriteText(text) {
                  if (blockWrite(text)) {
                    return Promise.reject(
                      new DOMException("Clipboard write blocked by GOSAFE adblock", "NotAllowedError")
                    );
                  }
                  return writeText(text);
                };
              }
              if (write) {
                clipboard.write = async function patchedWrite(items) {
                  try {
                    for (const item of items || []) {
                      if (typeof item?.getType === "function") {
                        const blob = await item.getType("text/plain").catch(() => null);
                        if (blob) {
                          const text = await blob.text();
                          if (blockWrite(text)) {
                            return Promise.reject(
                              new DOMException(
                                "Clipboard write blocked by GOSAFE adblock",
                                "NotAllowedError"
                              )
                            );
                          }
                        }
                      }
                    }
                  } catch {
                    // fall through to original
                  }
                  return write(items);
                };
              }
              try {
                Object.defineProperty(clipboard, "__adblockLitePatched", { value: true });
              } catch {
                clipboard.__adblockLitePatched = true;
              }
              return clipboard;
            },
          });
        }
      } catch {
        // ignore
      }

      try {
        const original = document.execCommand.bind(document);
        document.execCommand = function patchedExec(command, ...rest) {
          if (
            FeatureFlags.on("clipboard") &&
            String(command).toLowerCase() === "copy" &&
            !GestureClock.recent(3000)
          ) {
            const sel = String(document.getSelection?.() || "");
            if (CryptoAddress.looksLike(sel)) return false;
          }
          return original(command, ...rest);
        };
      } catch {
        // ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Scriptlets / anti-anti-adblock (core set)
  // ---------------------------------------------------------------------------

  class ScriptletEngine {
    static install() {
      if (!FeatureFlags.on("scriptlets")) {
        // Still install stubs; enable checks happen inside getters where needed.
      }

      const define = (obj, key, value) => {
        try {
          Object.defineProperty(obj, key, {
            configurable: true,
            get() {
              if (!FeatureFlags.on("scriptlets")) return undefined;
              return typeof value === "function" ? value() : value;
            },
            set() {},
          });
        } catch {
          try {
            obj[key] = typeof value === "function" ? value() : value;
          } catch {
            // ignore
          }
        }
      };

      // Common “is adblock on?” bait.
      define(window, "canRunAds", true);
      define(window, "canShowAds", true);
      define(window, "isAdsDisplayed", true);
      define(window, "adblock", false);
      define(window, "adBlock", false);
      define(window, "adblocker", false);
      define(window, "isAdBlockActive", false);
      define(window, "adsBlocked", false);

      // FuckAdBlock / BlockAdBlock style constructors → inert.
      const inertDetector = function InertAdBlockDetector() {
        this.on = function on(_detected, notDetected) {
          try {
            if (typeof notDetected === "function") setTimeout(notDetected, 1);
          } catch {
            // ignore
          }
          return this;
        };
        this.onDetected = function onDetected() {
          return this;
        };
        this.onNotDetected = function onNotDetected(cb) {
          try {
            if (typeof cb === "function") setTimeout(cb, 1);
          } catch {
            // ignore
          }
          return this;
        };
        this.check = function check() {
          return false;
        };
      };

      try {
        window.FuckAdBlock = inertDetector;
        window.BlockAdBlock = inertDetector;
        window.SniffAdBlock = inertDetector;
        window.fuckAdBlock = new inertDetector();
        window.blockAdBlock = new inertDetector();
      } catch {
        // ignore
      }

      // adsbygoogle stub — stops many “adblock detected” probes.
      try {
        const queue = window.adsbygoogle || [];
        queue.push = function pushNoop() {
          return 0;
        };
        window.adsbygoogle = queue;
      } catch {
        // ignore
      }

      // Abort reads of a few high-noise anti-adblock hooks.
      for (const prop of ["__adblock", "__adBlock", "google_ad_status"]) {
        try {
          Object.defineProperty(window, prop, {
            configurable: true,
            get() {
              if (!FeatureFlags.on("scriptlets")) return undefined;
              throw new ReferenceError(`GOSAFE adblock aborted property: ${prop}`);
            },
            set() {},
          });
        } catch {
          // ignore
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Permission / notification / sensor spam
  // ---------------------------------------------------------------------------

  class PermissionGuard {
    static install() {
      // Notifications
      try {
        if (typeof Notification !== "undefined") {
          Notification.requestPermission = function deniedPermission() {
            if (!FeatureFlags.on("permissions")) {
              return Promise.resolve(Notification.permission);
            }
            return Promise.resolve("denied");
          };
          try {
            Object.defineProperty(Notification, "permission", {
              configurable: true,
              get() {
                return FeatureFlags.on("permissions") ? "denied" : "default";
              },
            });
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }

      // Push
      try {
        if (window.PushManager?.prototype?.subscribe) {
          const original = window.PushManager.prototype.subscribe;
          window.PushManager.prototype.subscribe = function blockedSubscribe(...args) {
            if (!FeatureFlags.on("permissions")) {
              return original.apply(this, args);
            }
            return Promise.reject(
              new DOMException("Push blocked by GOSAFE adblock", "NotAllowedError")
            );
          };
        }
      } catch {
        // ignore
      }

      // Permissions.query — report denied for noisy permissions.
      try {
        if (navigator.permissions?.query) {
          const original = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = function patchedQuery(desc) {
            const name = String(desc?.name || "");
            if (
              FeatureFlags.on("permissions") &&
              /^(notifications|push|camera|microphone|geolocation|clipboard-read|clipboard-write)$/i.test(
                name
              ) &&
              !GestureClock.recent(3000)
            ) {
              return Promise.resolve({ state: "denied", onchange: null });
            }
            return original(desc);
          };
        }
      } catch {
        // ignore
      }

      // getUserMedia — require a recent user gesture.
      try {
        const media = navigator.mediaDevices;
        if (media?.getUserMedia) {
          const original = media.getUserMedia.bind(media);
          media.getUserMedia = function patchedGum(constraints) {
            if (FeatureFlags.on("permissions") && !GestureClock.recent(4000)) {
              return Promise.reject(
                new DOMException("Media blocked by GOSAFE adblock", "NotAllowedError")
              );
            }
            return original(constraints);
          };
        }
      } catch {
        // ignore
      }

      // Geolocation spam without gesture.
      try {
        if (navigator.geolocation) {
          const wrap = (fnName) => {
            const original = navigator.geolocation[fnName].bind(navigator.geolocation);
            navigator.geolocation[fnName] = function patched(success, error, ...rest) {
              if (FeatureFlags.on("permissions") && !GestureClock.recent(4000)) {
                if (typeof error === "function") {
                  error({
                    code: 1,
                    message: "Geolocation blocked by GOSAFE adblock",
                    PERMISSION_DENIED: 1,
                  });
                }
                return;
              }
              return original(success, error, ...rest);
            };
          };
          wrap("getCurrentPosition");
          wrap("watchPosition");
        }
      } catch {
        // ignore
      }
    }
  }

  class SecurityPageApp {
    start() {
      GestureClock.install();
      ScriptletEngine.install();
      ClipboardGuard.install();
      PermissionGuard.install();
    }
  }

  new SecurityPageApp().start();
})();
