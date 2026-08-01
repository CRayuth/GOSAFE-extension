(() => {
  "use strict";

  /**
   * Session-seeded PRNG (xorshift32) + fingerprint noise injectors.
   * Keeps noise stable within a tab session (less uniquely random than per-call noise).
   */
  class XorShift32 {
    /** @param {number} seed */
    constructor(seed) {
      this._s = seed || 0x9e3779b9;
    }

    next() {
      let x = this._s >>> 0;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this._s = x >>> 0;
      return (this._s >>> 0) / 0xffffffff;
    }

    /** @param {number} min @param {number} max */
    range(min, max) {
      return min + (max - min) * this.next();
    }

    /** @param {number} n */
    int(n) {
      return Math.floor(this.next() * n);
    }
  }

  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return true;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-adblock-lite-fingerprint") !== "off";
    }
  }

  class SessionSeed {
    static read() {
      try {
        const key = "abl.fp.seed";
        let raw = sessionStorage.getItem(key);
        if (!raw) {
          const buf = new Uint32Array(1);
          crypto.getRandomValues(buf);
          raw = String(buf[0] || Date.now());
          sessionStorage.setItem(key, raw);
        }
        return Number(raw) || Date.now();
      } catch {
        return Date.now();
      }
    }
  }

  class CanvasNoise {
    /** @param {XorShift32} rng */
    constructor(rng) {
      this._rng = rng;
    }

    install() {
      const rng = this._rng;
      const hook = (proto, method) => {
        const original = proto[method];
        if (typeof original !== "function") return;
        proto[method] = function patched(...args) {
          const result = original.apply(this, args);
          if (!FeatureGate.on()) return result;
          try {
            if (typeof result === "string" && result.startsWith("data:image")) {
              // Stable tiny perturbation via re-encode after pixel nudge.
              const ctx = this.getContext?.("2d");
              if (ctx) {
                const { width, height } = this;
                if (width > 0 && height > 0) {
                  const x = rng.int(Math.max(1, width));
                  const y = rng.int(Math.max(1, height));
                  const img = ctx.getImageData(x, y, 1, 1);
                  img.data[0] = (img.data[0] + (rng.int(3) - 1) + 256) % 256;
                  ctx.putImageData(img, x, y);
                  return original.apply(this, args);
                }
              }
            }
          } catch {
            // ignore
          }
          return result;
        };
      };

      hook(HTMLCanvasElement.prototype, "toDataURL");
      hook(HTMLCanvasElement.prototype, "toBlob");
    }
  }

  class AudioNoise {
    /** @param {XorShift32} rng */
    constructor(rng) {
      this._rng = rng;
    }

    install() {
      const rng = this._rng;
      try {
        const Original = window.AudioContext || window.webkitAudioContext;
        if (!Original) return;
        const Handler = {
          construct(Target, args) {
            const ctx = new Target(...args);
            if (!FeatureGate.on()) return ctx;
            try {
              const original = ctx.createAnalyser.bind(ctx);
              ctx.createAnalyser = function patchedCreateAnalyser() {
                const analyser = original();
                const getFloat = analyser.getFloatFrequencyData.bind(analyser);
                analyser.getFloatFrequencyData = function patched(array) {
                  getFloat(array);
                  if (FeatureGate.on() && array?.length) {
                    for (let i = 0; i < array.length; i += 32) {
                      array[i] += rng.range(-0.01, 0.01);
                    }
                  }
                };
                return analyser;
              };
            } catch {
              // ignore
            }
            return ctx;
          },
        };
        const Proxied = new Proxy(Original, Handler);
        if (window.AudioContext) window.AudioContext = Proxied;
        if (window.webkitAudioContext) window.webkitAudioContext = Proxied;
      } catch {
        // ignore
      }
    }
  }

  class WebGlNoise {
    /** @param {XorShift32} rng */
    constructor(rng) {
      this._rng = rng;
    }

    install() {
      const rng = this._rng;
      const patch = (proto) => {
        if (!proto?.getParameter) return;
        const original = proto.getParameter;
        proto.getParameter = function patchedGetParameter(pname) {
          const value = original.apply(this, [pname]);
          if (!FeatureGate.on()) return value;
          try {
            // UNMASKED_VENDOR_WEBGL / RENDERER
            if (pname === 0x9245 || pname === 0x9246) {
              if (typeof value === "string" && value.length) {
                return `${value} `;
              }
            }
          } catch {
            // ignore
          }
          return value;
        };
      };

      try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        const gl2 = canvas.getContext("webgl2");
        if (gl) patch(Object.getPrototypeOf(gl));
        if (gl2) patch(Object.getPrototypeOf(gl2));
      } catch {
        // ignore
      }
      void rng;
    }
  }

  class FingerprintGuardApp {
    start() {
      const rng = new XorShift32(SessionSeed.read());
      new CanvasNoise(rng).install();
      new AudioNoise(rng).install();
      new WebGlNoise(rng).install();
    }
  }

  new FingerprintGuardApp().start();
})();
