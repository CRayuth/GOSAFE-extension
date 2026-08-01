(() => {
  "use strict";

  /**
   * User-authored filter lines (AdGuard/uBO subset, MV3-safe):
   *   ||tracker.example^          → block domain
   *   example.com##.ad-banner     → cosmetic hide
   * Lines starting with ! or # (except ##) are comments.
   * No remote JS / scriptlets — cosmetics + domain blocks only.
   */

  const { HostKey } = globalThis.AblDs || {};

  class UserRuleParser {
    static MAX_LINES = 400;
    static MAX_BLOCKS = 80;
    static MAX_COSMETICS = 200;
    static BLOCK_ID_BASE = 9600;

    /**
     * @param {string} text
     * @returns {{ blocks: string[], cosmetics: Record<string, string[]>, errors: string[] }}
     */
    static parse(text) {
      const blocks = [];
      /** @type {Record<string, string[]>} */
      const cosmetics = {};
      const errors = [];
      const seenBlock = new Set();
      const lines = String(text || "").split(/\r?\n/).slice(0, UserRuleParser.MAX_LINES);

      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i].trim();
        if (!raw) continue;
        if (raw.startsWith("!") || raw.startsWith("[Adblock")) continue;
        // Comment `# …` but not cosmetic `##` / `#@#`
        if (raw.startsWith("#") && !raw.includes("##") && !raw.includes("#@#")) continue;

        const cosmetic = UserRuleParser.#parseCosmetic(raw);
        if (cosmetic) {
          if (!cosmetic.host || !cosmetic.selector) {
            errors.push(`L${i + 1}: bad cosmetic`);
            continue;
          }
          if (!cosmetics[cosmetic.host]) cosmetics[cosmetic.host] = [];
          if (cosmetics[cosmetic.host].length >= 40) continue;
          if (!cosmetics[cosmetic.host].includes(cosmetic.selector)) {
            cosmetics[cosmetic.host].push(cosmetic.selector);
          }
          continue;
        }

        const domain = UserRuleParser.#parseNetwork(raw);
        if (domain) {
          if (seenBlock.has(domain) || blocks.length >= UserRuleParser.MAX_BLOCKS) continue;
          seenBlock.add(domain);
          blocks.push(domain);
          continue;
        }

        errors.push(`L${i + 1}: unsupported (${raw.slice(0, 40)})`);
      }

      // Cap total cosmetic hosts
      const hostKeys = Object.keys(cosmetics);
      if (hostKeys.length > UserRuleParser.MAX_COSMETICS) {
        for (const h of hostKeys.slice(UserRuleParser.MAX_COSMETICS)) {
          delete cosmetics[h];
        }
      }

      return { blocks, cosmetics, errors };
    }

    /**
     * @param {string} line
     * @returns {{ host: string, selector: string } | null}
     */
    static #parseCosmetic(line) {
      const m = line.match(/^([a-z0-9.-]*)##(.+)$/i);
      if (!m) return null;
      const host = String(m[1] || "").replace(/^www\./, "").toLowerCase();
      const selector = String(m[2] || "").trim();
      if (!selector || selector.length > 280) return null;
      if (/[{};]|<\/|@import|expression\s*\(/i.test(selector)) return null;
      if (!host) {
        // Generic cosmetic — apply via host "*"
        return { host: "*", selector };
      }
      return { host, selector };
    }

    /**
     * @param {string} line
     * @returns {string} domain or ""
     */
    static #parseNetwork(line) {
      // ||domain^ or ||domain^$third-party (ignore options)
      let m = line.match(/^\|\|([a-z0-9.-]+)\^/i);
      if (m) return UserRuleParser.#normDomain(m[1]);
      // bare domain
      m = line.match(/^([a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})$/i);
      if (m) return UserRuleParser.#normDomain(m[1]);
      return "";
    }

    static #normDomain(d) {
      const host = String(d || "")
        .replace(/^www\./, "")
        .toLowerCase()
        .replace(/^\.+|\.+$/g, "");
      if (!host || host.length > 253) return "";
      if (!/^[a-z0-9.-]+$/.test(host)) return "";
      if (!host.includes(".")) return "";
      return host;
    }
  }

  class UserRuleDnrSync {
    static #TYPES = [
      "main_frame",
      "sub_frame",
      "script",
      "image",
      "xmlhttprequest",
      "ping",
      "media",
      "websocket",
      "other",
    ];

    /**
     * @param {string[]} domains
     */
    static async sync(domains) {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const removeRuleIds = existing
        .filter(
          (r) =>
            r.id >= UserRuleParser.BLOCK_ID_BASE &&
            r.id < UserRuleParser.BLOCK_ID_BASE + UserRuleParser.MAX_BLOCKS
        )
        .map((r) => r.id);

      const addRules = [];
      const list = (domains || []).slice(0, UserRuleParser.MAX_BLOCKS);
      for (let i = 0; i < list.length; i += 1) {
        addRules.push({
          id: UserRuleParser.BLOCK_ID_BASE + i,
          priority: 1200,
          action: { type: "block" },
          condition: {
            requestDomains: [list[i]],
            resourceTypes: UserRuleDnrSync.#TYPES,
          },
        });
      }

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules,
      });
      return { removed: removeRuleIds.length, added: addRules.length };
    }
  }

  class UserRuleStore {
    static TEXT_KEY = "userRulesText";
    static COSMETIC_KEY = "userRuleCosmetics";

    /**
     * @returns {Promise<{ text: string, blocks: string[], cosmetics: Record<string, string[]>, errors: string[] }>}
     */
    static async load() {
      const data = await chrome.storage.local.get({
        [UserRuleStore.TEXT_KEY]: "",
        [UserRuleStore.COSMETIC_KEY]: {},
      });
      const text = String(data[UserRuleStore.TEXT_KEY] || "");
      const parsed = UserRuleParser.parse(text);
      return {
        text,
        blocks: parsed.blocks,
        cosmetics: data[UserRuleStore.COSMETIC_KEY] || parsed.cosmetics,
        errors: parsed.errors,
      };
    }

    /**
     * @param {string} text
     */
    static async save(text) {
      const parsed = UserRuleParser.parse(text);
      await chrome.storage.local.set({
        [UserRuleStore.TEXT_KEY]: String(text || "").slice(0, 100_000),
        [UserRuleStore.COSMETIC_KEY]: parsed.cosmetics,
      });
      await UserRuleDnrSync.sync(parsed.blocks);
      return parsed;
    }

    /**
     * Cosmetics for a page host (exact + suffix + generic *).
     * @param {string} host
     * @returns {Promise<string[]>}
     */
    static async cosmeticsFor(host) {
      const data = await chrome.storage.local.get({ [UserRuleStore.COSMETIC_KEY]: {} });
      const book = data[UserRuleStore.COSMETIC_KEY] || {};
      const out = [];
      const seen = new Set();
      const push = (list) => {
        if (!Array.isArray(list)) return;
        for (const s of list) {
          if (!s || seen.has(s)) continue;
          seen.add(s);
          out.push(s);
        }
      };
      push(book["*"]);
      if (HostKey?.suffixes) {
        for (const suffix of HostKey.suffixes(host)) {
          push(book[suffix]);
        }
      } else {
        const h = String(host || "")
          .replace(/^www\./, "")
          .toLowerCase();
        push(book[h]);
      }
      return out;
    }

    static async applyOnStartup() {
      const { text } = await UserRuleStore.load();
      if (!text.trim()) {
        await UserRuleDnrSync.sync([]);
        return { blocks: 0, cosmetics: 0 };
      }
      const parsed = await UserRuleStore.save(text);
      return {
        blocks: parsed.blocks.length,
        cosmetics: Object.keys(parsed.cosmetics).length,
      };
    }
  }

  globalThis.AblUserRules = {
    UserRuleParser,
    UserRuleDnrSync,
    UserRuleStore,
  };
})();
