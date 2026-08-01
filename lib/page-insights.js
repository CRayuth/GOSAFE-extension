(() => {
  "use strict";

  /**
   * Shared Page Insights helpers (content script + service worker).
   * No DOM access here — callers pass scan payloads.
   */
  class HostUtil {
    /** @param {string} host */
    static normalize(host) {
      return String(host || "")
        .replace(/^www\./i, "")
        .toLowerCase();
    }

    /**
     * @param {string} pageHost
     * @param {string} otherHost
     */
    static isThirdParty(pageHost, otherHost) {
      const a = HostUtil.normalize(pageHost);
      const b = HostUtil.normalize(otherHost);
      if (!a || !b) return false;
      if (a === b) return false;
      if (b.endsWith(`.${a}`) || a.endsWith(`.${b}`)) return false;
      return true;
    }
  }

  class SubscriptionPatterns {
    static TRIAL =
      /\b(free\s+trial|try\s+(it\s+)?free|start\s+(your\s+)?(free\s+)?trial|\d+\s*[-–]?\s*day\s+(free\s+)?trial)\b/i;
    static AUTO_RENEW =
      /\b(auto[- ]?renew(s|al|ed)?|automatically\s+(renew|bill|charge)|billed\s+automatically|recurring\s+(billing|payment|charge)|subscription\s+(continues|will\s+continue)|unless\s+(you\s+)?cancel)\b/i;
    static SUBSCRIBE =
      /\b(subscribe\s+now|monthly\s+subscription|annual\s+plan|membership\s+fee|cancel\s+anytime|after\s+(the\s+)?trial)\b/i;

    /**
     * @param {string} text
     * @returns {{ level: "warn"|"info"|null, title: string, detail: string, hits: string[] }}
     */
    static analyze(text) {
      const sample = String(text || "").slice(0, 120000);
      const hits = [];
      const trial = SubscriptionPatterns.TRIAL.test(sample);
      const renew = SubscriptionPatterns.AUTO_RENEW.test(sample);
      const sub = SubscriptionPatterns.SUBSCRIBE.test(sample);
      if (trial) hits.push("free trial language");
      if (renew) hits.push("auto-renew / recurring billing");
      if (sub) hits.push("subscription / membership copy");

      if (trial && renew) {
        return {
          level: "warn",
          title: "Free trial likely auto-renews",
          detail:
            "This page mentions a free trial and automatic renewal or recurring billing. Cancel before the trial ends if you do not want to be charged.",
          hits,
        };
      }
      if (trial || renew || sub) {
        return {
          level: "info",
          title: "Subscription language detected",
          detail: hits.join("; ") + ".",
          hits,
        };
      }
      return { level: null, title: "", detail: "", hits: [] };
    }
  }

  class DarkPatternPatterns {
    static CONFIRMSHAME =
      /\b(no\s+thanks[,\s]+i\s+(hate|don'?t\s+want|prefer\s+to\s+pay)|i\s+don'?t\s+want\s+to\s+save|i'?ll\s+pay\s+full\s+price|no[,\s]+i\s+like\s+(paying|overpaying)|continue\s+without\s+(saving|discount))\b/i;
    static URGENCY =
      /\b(only\s+\d+\s+left|hurry[!.]?|limited\s+time|ends?\s+(in|tonight|today|soon)|offer\s+expires|act\s+now|last\s+chance|selling\s+fast)\b/i;
    static COUNTDOWN = /\b\d{1,2}\s*:\s*\d{2}\s*:\s*\d{2}\b|\b\d{1,2}\s*(hrs?|hours?|mins?|minutes?|secs?|seconds?)\s+left\b/i;
    static SKIP =
      /\b(skip|not\s+now|no\s+thanks|maybe\s+later|continue\s+without|dismiss|close)\b/i;
    static MARKETING_CB =
      /\b(newsletter|marketing|promotional|special\s+offers?|partner\s+offers?|email\s+updates?|receive\s+(emails?|offers?))\b/i;
  }

  /**
   * Composite page health 0–100.
   * Weights: speed 25, privacy 25, security 30, accessibility 20.
   */
  class HealthScore {
    static WEIGHTS = Object.freeze({
      speed: 25,
      privacy: 25,
      security: 30,
      accessibility: 20,
    });

    /**
     * @param {{
     *   scriptCount?: number,
     *   resourceCount?: number,
     *   heavyThirdParties?: number,
     *   thirdPartyHosts?: number,
     *   piiFieldCount?: number,
     *   cookieCount?: number,
     *   storageKeys?: number,
     *   trustSafety?: number|null,
     *   https?: boolean,
     *   passwordOnHttp?: boolean,
     *   missingAlt?: number,
     *   unlabeledInputs?: number,
     *   emptyButtons?: number,
     *   darkPatternCount?: number,
     *   subscriptionWarn?: boolean,
     * }} input
     */
    static compute(input = {}) {
      const deductions = [];

      let speed = 100;
      const scripts = Number(input.scriptCount) || 0;
      const resources = Number(input.resourceCount) || 0;
      const heavy = Number(input.heavyThirdParties) || 0;
      if (scripts > 40) {
        speed -= 25;
        deductions.push({ pillar: "speed", label: `Many scripts (${scripts})`, points: 25 });
      } else if (scripts > 20) {
        speed -= 12;
        deductions.push({ pillar: "speed", label: `Elevated script count (${scripts})`, points: 12 });
      }
      if (resources > 120) {
        speed -= 20;
        deductions.push({ pillar: "speed", label: `Heavy resource load (${resources})`, points: 20 });
      } else if (resources > 60) {
        speed -= 10;
        deductions.push({ pillar: "speed", label: `Many resources (${resources})`, points: 10 });
      }
      if (heavy > 5) {
        speed -= 20;
        deductions.push({ pillar: "speed", label: `${heavy} heavy third-party hosts`, points: 20 });
      } else if (heavy > 2) {
        speed -= 10;
        deductions.push({ pillar: "speed", label: `${heavy} heavy third-party hosts`, points: 10 });
      }
      speed = Math.max(0, speed);

      let privacy = 100;
      const tp = Number(input.thirdPartyHosts) || 0;
      const pii = Number(input.piiFieldCount) || 0;
      const cookies = Number(input.cookieCount) || 0;
      const storage = Number(input.storageKeys) || 0;
      if (tp > 25) {
        privacy -= 30;
        deductions.push({ pillar: "privacy", label: `${tp} third-party hosts`, points: 30 });
      } else if (tp > 12) {
        privacy -= 18;
        deductions.push({ pillar: "privacy", label: `${tp} third-party hosts`, points: 18 });
      } else if (tp > 5) {
        privacy -= 8;
        deductions.push({ pillar: "privacy", label: `${tp} third-party hosts`, points: 8 });
      }
      if (pii > 0) {
        const pts = Math.min(25, 8 + pii * 4);
        privacy -= pts;
        deductions.push({
          pillar: "privacy",
          label: `Collects personal data (${pii} field${pii === 1 ? "" : "s"})`,
          points: pts,
        });
      }
      if (cookies > 20) {
        privacy -= 12;
        deductions.push({ pillar: "privacy", label: `Many cookies (${cookies})`, points: 12 });
      } else if (cookies > 8) {
        privacy -= 6;
        deductions.push({ pillar: "privacy", label: `Cookies present (${cookies})`, points: 6 });
      }
      if (storage > 30) {
        privacy -= 8;
        deductions.push({ pillar: "privacy", label: `Large local storage (${storage} keys)`, points: 8 });
      }
      if (input.subscriptionWarn) {
        privacy -= 10;
        deductions.push({
          pillar: "privacy",
          label: "Trial / auto-renew language",
          points: 10,
        });
      }
      privacy = Math.max(0, privacy);

      let security = 100;
      if (input.trustSafety != null && Number.isFinite(Number(input.trustSafety))) {
        security = Math.max(0, Math.min(100, Number(input.trustSafety)));
        if (security < 75) {
          deductions.push({
            pillar: "security",
            label: `Trust score ${Math.round(security)}`,
            points: Math.round(100 - security),
          });
        }
      } else {
        if (input.https === false) {
          security -= 40;
          deductions.push({ pillar: "security", label: "Not HTTPS", points: 40 });
        }
        if (input.passwordOnHttp) {
          security -= 35;
          deductions.push({ pillar: "security", label: "Password field on HTTP", points: 35 });
        }
      }
      if (Number(input.darkPatternCount) > 0) {
        const dp = Math.min(15, Number(input.darkPatternCount) * 5);
        security = Math.max(0, security - dp);
        deductions.push({
          pillar: "security",
          label: `Dark patterns (${input.darkPatternCount})`,
          points: dp,
        });
      }
      security = Math.max(0, security);

      let accessibility = 100;
      const missingAlt = Number(input.missingAlt) || 0;
      const unlabeled = Number(input.unlabeledInputs) || 0;
      const emptyBtns = Number(input.emptyButtons) || 0;
      if (missingAlt > 10) {
        accessibility -= 25;
        deductions.push({
          pillar: "accessibility",
          label: `${missingAlt} images missing alt`,
          points: 25,
        });
      } else if (missingAlt > 3) {
        accessibility -= 12;
        deductions.push({
          pillar: "accessibility",
          label: `${missingAlt} images missing alt`,
          points: 12,
        });
      } else if (missingAlt > 0) {
        accessibility -= 5;
        deductions.push({
          pillar: "accessibility",
          label: `${missingAlt} image(s) missing alt`,
          points: 5,
        });
      }
      if (unlabeled > 5) {
        accessibility -= 20;
        deductions.push({
          pillar: "accessibility",
          label: `${unlabeled} unlabeled inputs`,
          points: 20,
        });
      } else if (unlabeled > 0) {
        accessibility -= Math.min(15, unlabeled * 4);
        deductions.push({
          pillar: "accessibility",
          label: `${unlabeled} unlabeled input(s)`,
          points: Math.min(15, unlabeled * 4),
        });
      }
      if (emptyBtns > 3) {
        accessibility -= 15;
        deductions.push({
          pillar: "accessibility",
          label: `${emptyBtns} empty buttons`,
          points: 15,
        });
      } else if (emptyBtns > 0) {
        accessibility -= emptyBtns * 4;
        deductions.push({
          pillar: "accessibility",
          label: `${emptyBtns} empty button(s)`,
          points: emptyBtns * 4,
        });
      }
      accessibility = Math.max(0, accessibility);

      const w = HealthScore.WEIGHTS;
      const score = Math.round(
        (speed * w.speed + privacy * w.privacy + security * w.security + accessibility * w.accessibility) /
          100
      );
      const pillars = { speed, privacy, security, accessibility };
      deductions.sort((a, b) => b.points - a.points);
      const topIssues = deductions.slice(0, 5).map((d) => d.label);
      let verdict = "good";
      if (score < 45) verdict = "poor";
      else if (score < 70) verdict = "fair";

      return {
        score: Math.max(0, Math.min(100, score)),
        pillars,
        deductions,
        topIssues,
        verdict,
      };
    }
  }

  globalThis.AblPageInsights = Object.freeze({
    HostUtil,
    SubscriptionPatterns,
    DarkPatternPatterns,
    HealthScore,
  });
})();
