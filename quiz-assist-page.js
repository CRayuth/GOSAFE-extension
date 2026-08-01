(() => {
  "use strict";

  /**
   * Quiz Assist — MCQ / multi-select: hide wrong options. Type-answer: fill the box.
   * Does not auto-submit.
   */
  class FeatureGate {
    static on() {
      const root = document.documentElement;
      if (!root) return false;
      if (root.getAttribute("data-adblock-lite") === "off") return false;
      return root.getAttribute("data-gosafe-quiz-assist") !== "off";
    }
  }

  class QuizDom {
    static QUIZ_HOST =
      /(^|\.)(kahoot\.it|quizizz\.com|blooket\.com|gimkit\.com|quizlet\.live|quizlet\.com|wayground\.com)$/i;

    static isQuizHost() {
      const h = (location.hostname || "").replace(/^www\./, "");
      return QuizDom.QUIZ_HOST.test(h);
    }

    static isKahootHost() {
      const h = (location.hostname || "").replace(/^www\./, "");
      return /(^|\.)kahoot\.it$/i.test(h);
    }

    static #norm(s) {
      return String(s || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    /** @returns {{ mode: "mcq"|"multi"|"open", question: string, choices?: string[], nodes?: Element[], input?: HTMLInputElement|HTMLTextAreaElement, maxLen?: number, fingerprint: string, questionIndex?: number, controller?: boolean } | null} */
    static extract() {
      if (QuizDom.isKahootHost()) {
        const kahoot = QuizDom.#extractKahoot();
        if (kahoot) return kahoot;
        const controller = QuizDom.#extractController();
        if (controller) return controller;
      }
      if (QuizDom.isQuizHost()) {
        const qz = QuizDom.#extractQuizizz();
        if (qz) return qz;
        const generic = QuizDom.#extractGeneric();
        if (generic) return generic;
        const tf = QuizDom.#extractTrueFalse();
        if (tf) return tf;
        if (QuizDom.isKahootHost()) {
          const viaBank = QuizDom.#extractUsingBank();
          if (viaBank) return viaBank;
        }
      }
      const open = QuizDom.#extractOpen();
      if (open) return open;
      return null;
    }

    static isShapePad() {
      return QuizDom.#looksLikeShapePad();
    }

    /** Live player pad: /gameblock — only colored shapes, no question text. */
    static isControllerPage() {
      const path = (location.pathname || "").toLowerCase();
      const href = (location.href || "").toLowerCase();
      return (
        /gameblock|\/controller|\/v2\/mobile|join\.kahoot/i.test(path) ||
        /gameblock/i.test(href)
      );
    }

    static #questionNumber() {
      // Top-left badge often shows current question number
      for (const el of document.querySelectorAll(
        '[data-functional-selector*="question-index" i], [data-functional-selector*="question-number" i], [class*="question-index" i], [class*="QuestionIndex"]'
      )) {
        const t = QuizDom.#cleanText(el.innerText || el.textContent || "");
        const n = Number.parseInt(t, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 200) return n;
      }
      // Fallback: small circle with a lone number near the top
      for (const el of document.querySelectorAll("div, span, p")) {
        if (!(el instanceof Element) || !QuizDom.#visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.top > 80 || r.left > 120 || r.width > 64 || r.height > 64) continue;
        const t = QuizDom.#cleanText(el.innerText || "");
        if (/^\d{1,3}$/.test(t)) {
          const n = Number.parseInt(t, 10);
          if (n >= 1 && n <= 200) return n;
        }
      }
      return 0;
    }

    static #colorName(el, i) {
      const labels = ["Red", "Blue", "Yellow", "Green", "Orange", "Cyan"];
      try {
        const bg = getComputedStyle(el).backgroundColor || "";
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(bg);
        if (m) {
          const r = Number(m[1]);
          const g = Number(m[2]);
          const b = Number(m[3]);
          if (r > 150 && g < 100 && b < 100) return "Red";
          if (b > 150 && r < 100) return "Blue";
          if (r > 180 && g > 140 && b < 80) return "Yellow";
          if (g > 140 && r < 100 && b < 120) return "Green";
        }
      } catch {
        // ignore
      }
      return labels[i] || `Option ${i + 1}`;
    }

    /** Shape-only answer pad (classic live Kahoot on phone). */
    static #extractController() {
      if (!QuizDom.isQuizHost() && !/kahoot/i.test(location.hostname || "")) return null;
      if (!QuizDom.isControllerPage() && !QuizDom.#looksLikeShapePad()) return null;

      let nodes = QuizDom.#collectAnswerNodes();
      if (nodes.length < 2) nodes = QuizDom.#findTrueFalseNodes();
      if (nodes.length < 2) return null;

      // Order by answer-N selector when present; else by screen position (TL, TR, BL, BR)
      nodes = [...nodes].sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const row = Math.round(ra.top / 40) - Math.round(rb.top / 40);
        if (row) return row;
        return ra.left - rb.left;
      });

      const qNum =
        KahootQuizBank.liveQuestionIndex() >= 0
          ? KahootQuizBank.liveQuestionIndex() + 1
          : QuizDom.#questionNumber() || 1;
      const choices = nodes.map((el, i) => {
        const t = QuizDom.#choiceText(el);
        if (t && t.length > 1 && !/^[▲◆●■▶◀△◇○□]$/u.test(t)) return t;
        return QuizDom.#colorName(el, i);
      });
      const question = `Kahoot live question ${qNum}`;
      return {
        mode: "mcq",
        question,
        choices,
        nodes,
        fingerprint: `ctrl:${qNum}|${choices.join("|")}|${nodes.length}`,
        questionIndex: qNum - 1,
        controller: true,
      };
    }

    static #looksLikeShapePad() {
      const nodes = QuizDom.#collectAnswerNodes();
      if (nodes.length < 2 || nodes.length > 6) return false;
      let withText = 0;
      for (const el of nodes) {
        const t = QuizDom.#choiceText(el);
        if (t && t.length > 2 && !/^(true|false)$/i.test(t)) withText += 1;
      }
      // Most tiles are icon-only
      if (withText > 0) return false;
      const q = QuizDom.#questionText();
      return !q || q.length < 8;
    }

    /** True/False tiles — common on Kahoot solo; often not tagged as answer-N. */
    static #extractTrueFalse() {
      const nodes = QuizDom.#findTrueFalseNodes();
      if (nodes.length < 2) return null;
      let question = QuizDom.#questionText();
      if (!question) question = QuizDom.#questionNearAnswers(nodes);
      if (!question || question.length < 8) return null;
      const choices = nodes.map((el) => QuizDom.#choiceText(el));
      const fingerprint = `mcq:${question}||${choices.join("|")}`;
      return { mode: "mcq", question, choices, nodes, fingerprint };
    }

    static #findTrueFalseNodes() {
      /** @type {Element|null} */
      let t = null;
      /** @type {Element|null} */
      let f = null;
      for (const el of document.querySelectorAll("button, [role='button'], div, span")) {
        if (!(el instanceof Element) || !QuizDom.#visible(el)) continue;
        if (el.closest("#gosafe-quiz-assist")) continue;
        const text = QuizDom.#cleanText(el.innerText || el.getAttribute("aria-label") || "");
        if (!/^(true|false)$/i.test(text)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.height < 28) continue;
        // Prefer the largest clickable that is exactly True/False
        if (/^true$/i.test(text)) {
          if (!t || r.width * r.height > t.getBoundingClientRect().width * t.getBoundingClientRect().height) {
            t = el;
          }
        } else if (/^false$/i.test(text)) {
          if (!f || r.width * r.height > f.getBoundingClientRect().width * f.getBoundingClientRect().height) {
            f = el;
          }
        }
      }
      return t && f ? [t, f] : [];
    }

    /** @param {Element[]} nodes */
    static #questionNearAnswers(nodes) {
      if (!nodes.length) return "";
      const top = Math.min(...nodes.map((n) => n.getBoundingClientRect().top));
      let best = "";
      let bestScore = 0;
      for (const el of document.querySelectorAll("p, div, span, h1, h2, h3, [class*='question' i]")) {
        if (!(el instanceof Element) || !QuizDom.#visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom > top - 4 || r.top < 30) continue;
        const t = QuizDom.#cleanText(el.innerText || "");
        if (t.length < 12 || t.length > 600) continue;
        if (/^(true|false|submit|kahoot|learn)$/i.test(t)) continue;
        if (/drag the tiles|check all that apply/i.test(t)) continue;
        // Prefer shorter leaf-ish blocks (question box), not huge parents
        const childLen = [...el.children].reduce(
          (n, c) => n + QuizDom.#cleanText(c.textContent || "").length,
          0
        );
        if (childLen > t.length * 0.85 && el.children.length > 2) continue;
        const score = Math.min(t.length, 200) + r.width / 10;
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
      return best;
    }

    /** Match on-screen text to a loaded Kahoot bank question (works when selectors fail). */
    static #extractUsingBank() {
      const bank = KahootQuizBank.peek();
      const items = bank?.questions;
      if (!Array.isArray(items) || !items.length) return null;
      const pageRaw = KahootQuizBank.pageText();
      const page = KahootQuizBank.norm(pageRaw).slice(0, 20000);
      if (!page) return null;

      let best = null;
      let bestScore = 0;
      for (const item of items) {
        if (/^content$/i.test(String(item.type || ""))) continue;
        const q = String(item.question || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .trim();
        if (q.length < 6) continue;
        const qn = KahootQuizBank.norm(q);
        if (!qn) continue;
        let score = 0;
        if (page.includes(qn)) score = 100;
        else {
          const snippet = qn.slice(0, Math.min(28, qn.length));
          if (snippet.length >= 8 && page.includes(snippet)) score = 85;
          else if (pageRaw.includes(q.slice(0, Math.min(40, q.length)))) score = 80;
          else {
            const a = new Set(qn.split(" ").filter((w) => w.length > 2));
            let hit = 0;
            for (const w of a) if (page.includes(w)) hit += 1;
            if (a.size && hit / a.size >= 0.7 && hit >= 3) score = 76;
          }
        }
        const choices = Array.isArray(item.choices) ? item.choices : [];
        let distinctive = 0;
        for (const c of choices) {
          const a = KahootQuizBank.norm(String(c?.answer || "").replace(/<[^>]+>/g, " "));
          if (a.length >= 6 && page.includes(a) && !/^(true|false)$/i.test(a)) distinctive += 1;
        }
        if (distinctive >= 2) score = Math.max(score, 82 + distinctive);
        if (score > bestScore) {
          bestScore = score;
          best = { item, q };
        }
      }
      if (!best || bestScore < 70) return null;

      let nodes = QuizDom.#collectAnswerNodes();
      if (nodes.length < 2) nodes = QuizDom.#findTrueFalseNodes();
      if (nodes.length < 2) {
        // Still return question so bank can answer & show text even without tiles
        nodes = [];
      }
      const choices = nodes.length
        ? nodes.map((el) => QuizDom.#choiceText(el))
        : (best.item.choices || []).map((c) =>
            String(c?.answer || "").replace(/<[^>]+>/g, " ").trim()
          );
      const type = String(best.item.type || "quiz");
      const multi = /multi|select/i.test(type);
      const mode = /open/i.test(type) ? "open" : multi ? "multi" : "mcq";
      const fingerprint = `${mode}:${best.q}||${choices.join("|")}`;
      return {
        mode,
        question: best.q,
        choices,
        nodes,
        fingerprint,
        input:
          mode === "open"
            ? document.querySelector(
                'input[placeholder*="Type your answer" i], input[placeholder*="Type an answer" i]'
              )
            : null,
      };
    }

    static #visible(el) {
      if (!(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return (
        r.width > 40 &&
        r.height > 20 &&
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        Number.parseFloat(cs.opacity || "1") > 0.05 &&
        r.bottom > 0 &&
        r.top < window.innerHeight
      );
    }

    static #cleanText(s) {
      const raw = QuizDom.#norm(s);
      // Kahoot sometimes doubles text in nested nodes
      const m = raw.match(/^(.{2,}?)\1$/);
      return m ? m[1].trim() : raw;
    }

    static #pageHintText() {
      const bits = [];
      for (const sel of [
        '[data-functional-selector*="instruction"]',
        '[data-functional-selector*="hint"]',
        '[class*="instruction" i]',
        '[class*="subtitle" i]',
      ]) {
        try {
          const el = document.querySelector(sel);
          if (el) bits.push(el.innerText || "");
        } catch {
          // ignore
        }
      }
      const banners = document.querySelectorAll("h1, h2, h3, [role='status'], [role='note']");
      for (const el of banners) {
        const t = QuizDom.#norm(el.innerText || "");
        if (t.length && t.length < 80) bits.push(t);
      }
      return bits.join("\n");
    }

    /** @param {string} question @param {Element[]} nodes */
    static #isMultiSelect(question, nodes) {
      const hint = `${question}\n${QuizDom.#pageHintText()}`;
      if (
        /check all that apply|select all that apply|choose all that apply|select all correct|all that are true|multiple answers|pick all/i.test(
          hint
        )
      ) {
        return true;
      }
      const block =
        document.querySelector("[data-question-type]") ||
        document.querySelector('[data-functional-selector="question-block"]');
      const qt =
        block?.getAttribute("data-question-type") ||
        block?.getAttribute("data-functional-selector") ||
        "";
      if (/multi|multiple|checkbox|select.?all|nselect/i.test(qt)) return true;

      let checks = 0;
      for (const n of nodes) {
        if (
          n.querySelector(
            'input[type="checkbox"], [role="checkbox"], [class*="checkbox" i], [class*="tick" i]'
          )
        ) {
          checks += 1;
        }
      }
      if (checks >= 3 || (nodes.length >= 5 && checks >= 1)) return true;
      try {
        const slice = String(document.body?.innerText || "").slice(0, 6000);
        if (/check all that apply|select all that apply|choose all that apply/i.test(slice)) {
          return true;
        }
      } catch {
        // ignore
      }
      return false;
    }

    static #questionText() {
      const selectors = [
        '[data-functional-selector="block-title"]',
        '[data-functional-selector="question-title"]',
        '[data-functional-selector="question-title__title"]',
        '[data-functional-selector="question-container"] h1',
        '[data-functional-selector="question-container"] h2',
        'h1[class*="question" i]',
        '[class*="question-text" i]',
        '[class*="QuestionText"]',
        '[data-functional-selector*="question" i]',
        "main h1",
        "h1",
        "h2",
      ];
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          const t = QuizDom.#cleanText(el?.innerText || el?.textContent || "");
          if (QuizDom.#visible(el) && t.length > 0 && t.length < 1200 && !/^quiz$/i.test(t)) {
            if (/^(true|false)$/i.test(t)) continue;
            if (/multiple choice|content view|true or false|fill.?in|questions?/i.test(t) && t.length < 48) {
              continue;
            }
            return t;
          }
        } catch {
          // ignore
        }
      }
      return "";
    }

    /** Type-answer / open-ended (Kahoot “Type your answer here”). */
    static #extractOpen() {
      // Don't treat MCQ pages as open just because a stray input exists.
      if (QuizDom.#collectAnswerNodes().length >= 2) return null;
      const input = QuizDom.#findAnswerInput();
      if (!input) return null;
      const question = QuizDom.#questionText();
      if (!question || question.length < 3) return null;

      let maxLen = Number(input.getAttribute("maxlength")) || 0;
      if (!maxLen || maxLen > 80) {
        maxLen = QuizDom.isQuizHost() ? 20 : 40;
      }
      const fingerprint = `open:${question}|${maxLen}`;
      return { mode: "open", question, input, maxLen, fingerprint };
    }

    /** @returns {HTMLInputElement|HTMLTextAreaElement|null} */
    static #findAnswerInput() {
      const selectors = [
        'input[data-functional-selector*="text-answer" i]',
        'input[data-functional-selector*="type-answer" i]',
        'input[data-functional-selector*="open" i]',
        'textarea[data-functional-selector*="text-answer" i]',
        'input[placeholder*="Type your answer" i]',
        'input[placeholder*="Type an answer" i]',
        'input[placeholder*="type answer" i]',
        'textarea[placeholder*="Type your answer" i]',
        'input[aria-label*="Type your answer" i]',
      ];
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            const r = el.getBoundingClientRect();
            if (r.width >= 80 && r.height >= 24 && !el.disabled && !el.readOnly) return el;
          }
        } catch {
          // ignore
        }
      }
      return null;
    }

    /** @param {string[]} selectors */
    static #collectBySelectors(selectors) {
      /** @type {Element[]} */
      const found = [];
      const seen = new Set();
      for (const sel of selectors) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            if (!(el instanceof Element) || seen.has(el) || !QuizDom.#visible(el)) continue;
            if (el.closest("#gosafe-quiz-assist, #gosafe-reader-fab, #gosafe-reader-mode")) continue;
            seen.add(el);
            found.push(el);
          }
        } catch {
          // ignore
        }
      }
      return found;
    }

    /** Parent/grandparent grouping for hashed Kahoot solo/nano tiles. */
    static #findAnswersByGroup() {
      const candidates = [
        ...document.querySelectorAll('button, [role="button"], [role="option"], li'),
      ].filter((el) => {
        if (!(el instanceof Element)) return false;
        if (el.closest("#gosafe-quiz-assist, #gosafe-reader-fab")) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 60 || r.height < 36) return false;
        if (r.top < window.innerHeight * 0.18) return false;
        if (r.top >= window.innerHeight || r.bottom <= 0) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const text = QuizDom.#cleanText(el.textContent || el.getAttribute("aria-label") || "");
        return text.length >= 1 && text.length <= 400;
      });

      if (candidates.length < 2) return [];

      /** @param {Map<Element, Element[]>} map @param {Element} key @param {Element} el */
      const push = (map, key, el) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(el);
      };

      /** @type {Map<Element, Element[]>} */
      const byParent = new Map();
      for (const el of candidates) {
        if (el.parentElement) push(byParent, el.parentElement, el);
      }
      let best = [];
      for (const group of byParent.values()) {
        if (group.length >= 2 && group.length <= 6 && group.length > best.length) best = group;
      }
      if (best.length >= 2) return best;

      /** @type {Map<Element, Element[]>} */
      const byGrand = new Map();
      for (const el of candidates) {
        const gp = el.parentElement?.parentElement;
        if (gp) push(byGrand, gp, el);
      }
      for (const group of byGrand.values()) {
        if (group.length >= 2 && group.length <= 6 && group.length > best.length) best = group;
      }
      return best.length >= 2 ? best : [];
    }

    static #collectAnswerNodes() {
      const strict = QuizDom.#collectBySelectors([
        '[data-functional-selector^="answer-"]',
        'button[data-functional-selector^="answer-"]',
        '[data-functional-selector^="choice-"]',
        'button[data-functional-selector^="choice-"]',
        '[data-functional-selector*="answer"]',
        '[data-functional-selector*="choice"]',
      ]);
      // Prefer indexed answer-N order when present
      const byIndex = new Map();
      for (const el of strict) {
        const sel = el.getAttribute("data-functional-selector") || "";
        const m = /(?:answer|choice)-(\d+)/i.exec(sel);
        if (m) byIndex.set(Number(m[1]), el);
      }
      if (byIndex.size >= 2 && byIndex.size <= 6) {
        return [...byIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, el]) => el);
      }
      if (strict.length >= 2 && strict.length <= 6) return strict;

      const loose = QuizDom.#collectBySelectors([
        'button[class*="answer" i]',
        'button[class*="choice" i]',
        'button[class*="option" i]',
        'div[class*="answer" i][role="button"]',
        'div[class*="Answer"]',
        'div[class*="answerCard" i]',
        '[class*="AnswerBox"]',
        '[class*="answer-box"]',
        '[class*="answerButton" i]',
      ]);
      if (loose.length >= 2 && loose.length <= 6) return loose;

      return QuizDom.#findAnswersByGroup();
    }

    static #extractKahoot() {
      if (!QuizDom.isQuizHost() && !/kahoot/i.test(location.hostname || "")) {
        const hasKahootSel = document.querySelector('[data-functional-selector^="answer-"]');
        if (!hasKahootSel) return null;
      }

      let nodes = QuizDom.#collectAnswerNodes();
      if (nodes.length < 2) nodes = QuizDom.#findTrueFalseNodes();
      if (nodes.length < 2) return null;

      let question = QuizDom.#questionText();
      if (!question) question = QuizDom.#questionNearAnswers(nodes);
      const choices = nodes.map(
        (el, i) => QuizDom.#choiceText(el) || `Option ${i + 1}`
      );
      if (!question || question.length < 3) return null;

      const multi = QuizDom.#isMultiSelect(question, nodes);
      const mode = multi ? "multi" : "mcq";
      const fingerprint = `${mode}:${question}||${choices.join("|")}`;
      return { mode, question, choices, nodes, fingerprint };
    }

    static #extractGeneric() {
      const question = QuizDom.#questionText();
      if (!question || question.length < 2) return null;

      const nodes = QuizDom.#collectAnswerNodes();
      if (nodes.length < 2) return null;
      const choices = nodes.map((el) => QuizDom.#choiceText(el));
      if (choices.filter(Boolean).length < 2) return null;
      const multi = QuizDom.#isMultiSelect(question, nodes);
      const mode = multi ? "multi" : "mcq";
      const fingerprint = `${mode}:${question}||${choices.join("|")}`;
      return { mode, question, choices, nodes, fingerprint };
    }

    /** Quizizz / Wayground (admin content view + live play). */
    static #extractQuizizz() {
      if (!/quizizz|wayground/i.test(location.hostname || "")) return null;

      /** @type {Element[]} */
      let nodes = [];
      const optionSels = [
        '[class*="option-text" i]',
        '[class*="OptionText"]',
        '[class*="answer-option" i]',
        '[data-cy*="option" i]',
        '[data-testid*="option" i]',
        'label[class*="option" i]',
        '[role="radio"]',
        '[role="checkbox"]',
        'div[class*="option" i]',
      ];
      for (const sel of optionSels) {
        try {
          const found = [...document.querySelectorAll(sel)].filter(
            (el) => el instanceof Element && QuizDom.#visible(el)
          );
          if (found.length >= 2 && found.length <= 8) {
            nodes = found;
            break;
          }
        } catch {
          // ignore
        }
      }
      if (nodes.length < 2) {
        // Radio / checkbox rows in content editor
        const labels = [...document.querySelectorAll("label")].filter((el) => {
          if (!(el instanceof Element) || !QuizDom.#visible(el)) return false;
          const t = QuizDom.#choiceText(el);
          return t.length >= 1 && t.length < 300;
        });
        if (labels.length >= 2 && labels.length <= 8) nodes = labels;
      }
      if (nodes.length < 2) nodes = QuizDom.#collectAnswerNodes();
      if (nodes.length < 2) return null;

      // Prefer question text near the options (not page chrome)
      let question = "";
      let bestScore = -1;
      const top = Math.min(...nodes.map((n) => n.getBoundingClientRect().top));
      const skip =
        /^(content view|questions?|multiple choice|true or false|fill.?in|poll|slide|used \d|kg|mathematics|chemistry|other|\d+\s*sec|\d+\s*pt)/i;
      for (const el of document.querySelectorAll(
        'p, h1, h2, h3, h4, [class*="question" i], [class*="QuestionText"], [data-cy*="question" i]'
      )) {
        if (!(el instanceof Element) || !QuizDom.#visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom > top + 8) continue;
        if (r.top < 40) continue;
        const t = QuizDom.#cleanText(el.innerText || "");
        if (t.length < 1 || t.length > 800) continue;
        if (skip.test(t)) continue;
        if (/^\d+\.\s*multiple choice/i.test(t)) continue;
        const dist = Math.max(0, top - r.bottom);
        const score = 500 - dist + (t.length < 80 ? 80 : 0) + (t.length < 20 ? 40 : 0);
        if (score > bestScore) {
          bestScore = score;
          question = t;
        }
      }
      if (!question) question = QuizDom.#questionText();
      if (!question || question.length < 1) return null;
      if (/multiple choice question|content view/i.test(question) && question.length < 40) {
        question = QuizDom.#questionNearAnswers(nodes) || question;
      }

      const choices = nodes.map((el, i) => QuizDom.#choiceText(el) || `Option ${i + 1}`);
      if (choices.filter((c) => c && !/^option \d+$/i.test(c)).length < 2 && choices.length < 2) {
        return null;
      }
      const multi = QuizDom.#isMultiSelect(question, nodes);
      const mode = multi ? "multi" : "mcq";
      return {
        mode,
        question,
        choices,
        nodes,
        fingerprint: `${mode}:${question}||${choices.join("|")}`,
      };
    }

    /** @param {Element} el */
    static #choiceText(el) {
      const labeled =
        el.getAttribute("aria-label") ||
        el.querySelector("[aria-label]")?.getAttribute("aria-label") ||
        "";
      const text = QuizDom.#cleanText(el.innerText || el.textContent || labeled);
      return text.replace(/^[▲◆●■▶◀]\s*/u, "").trim() || text;
    }
  }

  class QuizAssistUi {
    static #ROOT = "gosafe-quiz-assist";
    static #STYLE = "gosafe-quiz-assist-css";
    static #KEEP = "gosafe-quiz-keep";
    static #DROP = "gosafe-quiz-drop";

    static ensure() {
      QuizAssistUi.#injectCss();
      let panel = document.getElementById(QuizAssistUi.#ROOT);
      if (!panel) {
        panel = document.createElement("div");
        panel.id = QuizAssistUi.#ROOT;
        panel.hidden = true;
        panel.innerHTML = `
          <div class="gqa-head">
            <img class="gqa-logo" alt="" width="18" height="18" />
            <strong class="gqa-status">…</strong>
            <button type="button" class="gqa-ask" title="Ask / retry">Ask</button>
            <button type="button" class="gqa-close" title="Hide" aria-label="Hide">×</button>
          </div>
          <div class="gqa-idrow" hidden>
            <input class="gqa-id" type="text" spellcheck="false" autocomplete="off"
              placeholder="Paste this quiz’s quizId (from Solo / host URL)" />
            <button type="button" class="gqa-idgo">Load</button>
          </div>
          <div class="gqa-answer" hidden></div>
        `;
        (document.documentElement || document.body).appendChild(panel);
        panel.querySelector(".gqa-ask")?.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          QuizAssistApp.retry();
        });
        panel.querySelector(".gqa-close")?.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          panel.hidden = true;
        });
        panel.querySelector(".gqa-idgo")?.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          QuizAssistUi.#submitQuizId();
        });
        panel.querySelector(".gqa-id")?.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            QuizAssistUi.#submitQuizId();
          }
        });
      }
      const logo = panel.querySelector(".gqa-logo");
      if (logo instanceof HTMLImageElement) {
        const url = document.documentElement.getAttribute("data-gosafe-icon-url") || "";
        if (url) logo.src = url;
      }
      return panel;
    }

    static #injectCss() {
      if (document.getElementById(QuizAssistUi.#STYLE)) return;
      const style = document.createElement("style");
      style.id = QuizAssistUi.#STYLE;
      style.textContent = `
#${QuizAssistUi.#ROOT} {
  position: fixed !important;
  z-index: 2147483646 !important;
  right: 12px !important;
  top: 12px !important;
  left: auto !important;
  bottom: auto !important;
  max-width: min(300px, calc(100vw - 24px)) !important;
  border-radius: 12px !important;
  background: linear-gradient(160deg, #002870 0%, #0058d0 100%) !important;
  color: #f4f7fc !important;
  font: 600 12px/1.3 "Segoe UI", "Helvetica Neue", sans-serif !important;
  box-shadow: 0 10px 28px rgba(0, 40, 112, 0.4) !important;
  overflow: hidden !important;
  pointer-events: auto !important;
}
#${QuizAssistUi.#ROOT}[hidden] { display: none !important; }
#${QuizAssistUi.#ROOT} .gqa-head {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 8px 10px !important;
}
#${QuizAssistUi.#ROOT} .gqa-logo {
  width: 18px !important;
  height: 18px !important;
  border-radius: 4px !important;
  background: #fff !important;
  object-fit: contain !important;
  flex: 0 0 auto !important;
}
#${QuizAssistUi.#ROOT} .gqa-status {
  flex: 1 !important;
  font-size: 12px !important;
  font-weight: 600 !important;
}
#${QuizAssistUi.#ROOT} .gqa-ask,
#${QuizAssistUi.#ROOT} .gqa-close {
  border: 0 !important;
  border-radius: 6px !important;
  background: rgba(255,255,255,0.18) !important;
  color: #fff !important;
  font: 700 11px/1 "Segoe UI", sans-serif !important;
  padding: 4px 8px !important;
  cursor: pointer !important;
  flex: 0 0 auto !important;
}
#${QuizAssistUi.#ROOT} .gqa-ask:hover,
#${QuizAssistUi.#ROOT} .gqa-close:hover {
  background: rgba(255,255,255,0.32) !important;
}
#${QuizAssistUi.#ROOT} .gqa-idrow {
  display: flex !important;
  gap: 6px !important;
  padding: 0 10px 8px !important;
}
#${QuizAssistUi.#ROOT} .gqa-idrow[hidden] { display: none !important; }
#${QuizAssistUi.#ROOT} .gqa-id {
  flex: 1 !important;
  min-width: 0 !important;
  border: 0 !important;
  border-radius: 6px !important;
  padding: 6px 8px !important;
  font: 600 11px/1.2 "Segoe UI", sans-serif !important;
  background: rgba(255,255,255,0.92) !important;
  color: #0a1f44 !important;
}
#${QuizAssistUi.#ROOT} .gqa-idgo {
  border: 0 !important;
  border-radius: 6px !important;
  background: #00c853 !important;
  color: #fff !important;
  font: 700 11px/1 "Segoe UI", sans-serif !important;
  padding: 6px 10px !important;
  cursor: pointer !important;
}
#${QuizAssistUi.#ROOT} .gqa-answer {
  padding: 0 12px 10px !important;
  font-size: 16px !important;
  font-weight: 800 !important;
  line-height: 1.25 !important;
}
#${QuizAssistUi.#ROOT} .gqa-answer[hidden] { display: none !important; }
.${QuizAssistUi.#DROP} {
  opacity: 0.12 !important;
  filter: grayscale(1) blur(1px) !important;
  pointer-events: none !important;
  transform: scale(0.96) !important;
  transition: opacity 0.2s ease, filter 0.2s ease, transform 0.2s ease !important;
}
.${QuizAssistUi.#KEEP} {
  outline: 3px solid #00e676 !important;
  outline-offset: 3px !important;
  box-shadow: 0 0 0 5px rgba(0, 230, 118, 0.3) !important;
  opacity: 1 !important;
  filter: none !important;
  pointer-events: auto !important;
  z-index: 6 !important;
  position: relative !important;
  transition: outline 0.15s ease !important;
}
.${QuizAssistUi.#KEEP}.gosafe-quiz-filled {
  background: #e8fff0 !important;
  border-color: #00c853 !important;
}
.gosafe-quiz-ord {
  position: absolute !important;
  top: 6px !important;
  left: 6px !important;
  z-index: 8 !important;
  min-width: 22px !important;
  height: 22px !important;
  padding: 0 6px !important;
  border-radius: 999px !important;
  background: #00c853 !important;
  color: #fff !important;
  font: 800 12px/22px "Segoe UI", sans-serif !important;
  text-align: center !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.25) !important;
  pointer-events: none !important;
}
`;
      (document.head || document.documentElement).appendChild(style);
    }

    /** True when an answer is currently visible in the panel. */
    static hasAnswer() {
      const panel = document.getElementById(QuizAssistUi.#ROOT);
      const a = panel?.querySelector(".gqa-answer");
      return Boolean(panel && !panel.hidden && a && !a.hidden && String(a.textContent || "").trim());
    }

    /**
     * Update status line only. Does not clear a shown answer unless `clearAnswer`.
     * @param {string} status
     * @param {{ clearAnswer?: boolean }} [opts]
     */
    static setStatus(status, opts = {}) {
      const panel = QuizAssistUi.ensure();
      panel.hidden = false;
      const s = panel.querySelector(".gqa-status");
      const a = panel.querySelector(".gqa-answer");
      if (s) s.textContent = status;
      if (opts.clearAnswer && a) {
        a.hidden = true;
        a.textContent = "";
      }
    }

    /** @param {string} answer */
    static showAnswer(answer) {
      const panel = QuizAssistUi.ensure();
      panel.hidden = false;
      const s = panel.querySelector(".gqa-status");
      const a = panel.querySelector(".gqa-answer");
      if (s) s.textContent = "Answer";
      if (a) {
        a.hidden = false;
        a.textContent = answer || "—";
      }
    }

    static setIdleHint() {
      // Never wipe a live answer with the "Armed…" idle label
      if (QuizAssistUi.hasAnswer()) return;
      QuizAssistUi.setStatus(KahootQuizBank.readyLabel(), { clearAnswer: false });
      QuizAssistUi.#syncIdRow();
    }

    static showIdRow(show) {
      const panel = QuizAssistUi.ensure();
      const row = panel.querySelector(".gqa-idrow");
      if (row) row.hidden = !show;
    }

    static #syncIdRow() {
      // Kahoot-only: paste quizId for live pad
      if (!QuizDom.isKahootHost()) {
        QuizAssistUi.showIdRow(false);
        return;
      }
      const need =
        QuizDom.isControllerPage() ||
        QuizDom.isShapePad() ||
        !KahootQuizBank.quizIdFromUrl();
      QuizAssistUi.showIdRow(Boolean(need && !KahootQuizBank.peek()));
    }

    static #submitQuizId() {
      const panel = document.getElementById(QuizAssistUi.#ROOT);
      const input = panel?.querySelector(".gqa-id");
      const raw = String(input?.value || "").trim();
      const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(raw);
      if (!m) {
        QuizAssistUi.setStatus("Paste a valid quizId UUID", { clearAnswer: true });
        QuizAssistUi.showIdRow(true);
        return;
      }
      KahootQuizBank.rememberQuizId(m[0]);
      QuizAssistUi.setStatus("Loading this quiz…", { clearAnswer: true });
      KahootQuizBank.load(m[0]).then((bank) => {
        if (!bank?.questions?.length) {
          QuizAssistUi.setStatus("Could not load that quizId", { clearAnswer: true });
          QuizAssistUi.showIdRow(true);
          return;
        }
        QuizAssistUi.showIdRow(false);
        QuizAssistApp.retry();
      });
    }

    static hidePanel() {
      const panel = document.getElementById(QuizAssistUi.#ROOT);
      if (panel) panel.hidden = true;
    }

    static hide() {
      QuizAssistUi.hidePanel();
      QuizAssistUi.clearFilter();
    }

    /**
     * Keep correct choice(s); fade/block the rest. Optionally toggle-select keeps.
     * @param {Element[]} nodes
     * @param {number|number[]} keep
     * @param {{ select?: boolean }} [opts]
     */
    static filterWrong(nodes, keep, opts = {}) {
      QuizAssistUi.clearFilter();
      if (!Array.isArray(nodes)) return;
      const indexes = (Array.isArray(keep) ? keep : [keep]).filter((n) =>
        Number.isInteger(n)
      );
      const set = new Set(indexes);
      if (!set.size) return;
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i];
        if (!(el instanceof Element)) continue;
        if (set.has(i)) {
          el.classList.add(QuizAssistUi.#KEEP);
          el.classList.remove(QuizAssistUi.#DROP);
          if (opts.select) QuizAssistUi.#ensureSelected(el);
        } else {
          el.classList.add(QuizAssistUi.#DROP);
          el.classList.remove(QuizAssistUi.#KEEP);
        }
      }
    }

    /**
     * Number jumble tiles in the correct order (1 = top / first).
     * @param {Element[]} nodes
     * @param {number[]} orderIndices — page indexes in correct sequence
     */
    static markJumbleOrder(nodes, orderIndices) {
      QuizAssistUi.clearFilter();
      if (!Array.isArray(nodes) || !Array.isArray(orderIndices)) return;
      for (let order = 0; order < orderIndices.length; order += 1) {
        const idx = orderIndices[order];
        const el = nodes[idx];
        if (!(el instanceof HTMLElement)) continue;
        const cs = getComputedStyle(el);
        if (cs.position === "static") el.style.setProperty("position", "relative", "important");
        el.classList.add(QuizAssistUi.#KEEP);
        let badge = el.querySelector(":scope > .gosafe-quiz-ord");
        if (!(badge instanceof HTMLElement)) {
          badge = document.createElement("span");
          badge.className = "gosafe-quiz-ord";
          el.appendChild(badge);
        }
        badge.textContent = String(order + 1);
      }
    }

    /** @param {Element} el */
    static #ensureSelected(el) {
      try {
        const pressed =
          el.getAttribute("aria-pressed") === "true" ||
          el.getAttribute("aria-checked") === "true" ||
          el.classList.contains("selected") ||
          el.dataset.selected === "true";
        if (pressed) return;
        if (el instanceof HTMLElement) el.click();
      } catch {
        // ignore
      }
    }

    /**
     * Fill type-answer input (React-friendly) and outline it.
     * @param {HTMLInputElement|HTMLTextAreaElement} input
     * @param {string} value
     */
    static fillOpenAnswer(input, value) {
      QuizAssistUi.clearFilter();
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
      const text = String(value || "");
      try {
        input.focus();
      } catch {
        // ignore
      }

      const setter =
        Object.getOwnPropertyDescriptor(
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          "value"
        )?.set ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

      if (setter) setter.call(input, text);
      else input.value = text;

      try {
        input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }));
      } catch {
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));

      input.classList.add(QuizAssistUi.#KEEP, "gosafe-quiz-filled");
    }

    static clearFilter() {
      for (const el of document.querySelectorAll(
        `.${QuizAssistUi.#KEEP}, .${QuizAssistUi.#DROP}, .gosafe-quiz-filled`
      )) {
        el.classList.remove(QuizAssistUi.#KEEP, QuizAssistUi.#DROP, "gosafe-quiz-filled");
      }
      for (const badge of document.querySelectorAll(".gosafe-quiz-ord")) {
        badge.remove();
      }
    }
  }

  /**
   * Public Kahoot quiz bank — solo/nano URLs include quizId with correct answers.
   * https://kahoot.it/rest/kahoots/{quizId}
   */
  class KahootQuizBank {
    /** @type {Map<string, object>} */
    static #cache = new Map();
    /** @type {Promise<object|null>|null} */
    static #inflight = null;
    static #inflightId = "";

    /** @type {string} */
    static #resolvedId = "";

    static quizIdFromUrl(href = location.href) {
      // Kahoot bank IDs only — never treat Quizizz/Wayground Mongo ids as Kahoot UUIDs
      if (!QuizDom.isKahootHost()) return KahootQuizBank.#resolvedId || "";
      try {
        const u = new URL(href);
        const q =
          u.searchParams.get("quizId") ||
          u.searchParams.get("quiz-id") ||
          u.searchParams.get("kahootId");
        if (q && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
          return q;
        }
        const m = u.pathname.match(
          /\/(?:challenge|solo|quiz)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
        );
        if (m) return m[1];
      } catch {
        // ignore
      }
      if (KahootQuizBank.#resolvedId) return KahootQuizBank.#resolvedId;
      return KahootQuizBank.#findQuizIdInPage();
    }

    /** Scan storage / resource URLs for a Kahoot UUID (live games hide it from the address bar). */
    static #findQuizIdInPage() {
      const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const tryText = (s, requireKahoot) => {
        const text = String(s || "");
        if (requireKahoot && !/kahoot|quiz/i.test(text)) return "";
        const m = re.exec(text);
        return m ? m[0] : "";
      };
      try {
        for (const store of [localStorage, sessionStorage]) {
          for (let i = 0; i < store.length; i += 1) {
            const key = store.key(i) || "";
            const val = store.getItem(key) || "";
            const hit =
              tryText(key, true) ||
              tryText(val, /kahoot|quiz/i.test(key) || /kahoot|quiz/i.test(val));
            if (hit) {
              KahootQuizBank.#resolvedId = hit;
              return hit;
            }
          }
        }
      } catch {
        // ignore
      }
      try {
        for (const e of performance.getEntriesByType("resource")) {
          if (!/kahoot/i.test(e.name)) continue;
          const hit = tryText(e.name, false);
          if (hit) {
            KahootQuizBank.#resolvedId = hit;
            return hit;
          }
        }
      } catch {
        // ignore
      }
      return KahootQuizBank.#resolvedId || "";
    }

    static rememberQuizId(id) {
      if (id && /^[0-9a-f-]{20,}$/i.test(id)) KahootQuizBank.#resolvedId = id;
    }

    /** Live hook / title search may set these. */
    static #liveTitle = "";
    static #liveQuestionIndex = -1;

    static setLiveMeta(meta) {
      if (!meta || typeof meta !== "object") return;
      if (meta.quizId) KahootQuizBank.rememberQuizId(String(meta.quizId));
      if (meta.quizTitle) KahootQuizBank.#liveTitle = String(meta.quizTitle).trim();
      if (Number.isInteger(meta.questionIndex)) {
        KahootQuizBank.#liveQuestionIndex = meta.questionIndex;
      }
    }

    static liveQuestionIndex() {
      return KahootQuizBank.#liveQuestionIndex;
    }

    /** Resolve quizId from URL, hook, or public title search. */
    static async resolveQuizId() {
      const fromUrl = (() => {
        try {
          const u = new URL(location.href);
          const q =
            u.searchParams.get("quizId") ||
            u.searchParams.get("quiz-id") ||
            u.searchParams.get("kahootId");
          if (q && /^[0-9a-f-]{20,}$/i.test(q)) return q;
          const m = u.pathname.match(/\/(?:challenge|solo|quiz)\/([0-9a-f-]{20,})/i);
          if (m) return m[1];
        } catch {
          // ignore
        }
        return "";
      })();
      if (fromUrl) {
        KahootQuizBank.rememberQuizId(fromUrl);
        return fromUrl;
      }
      if (KahootQuizBank.#resolvedId) return KahootQuizBank.#resolvedId;
      const found = KahootQuizBank.#findQuizIdInPage();
      if (found) return found;
      if (KahootQuizBank.#liveTitle) {
        const id = await KahootQuizBank.#searchByTitle(KahootQuizBank.#liveTitle);
        if (id) {
          KahootQuizBank.rememberQuizId(id);
          return id;
        }
      }
      return "";
    }

    /** @param {string} title */
    static async #searchByTitle(title) {
      const q = String(title || "").trim();
      if (q.length < 3) return "";
      const urls = [
        `https://create.kahoot.it/rest/kahoots/?query=${encodeURIComponent(q)}&limit=10`,
        `https://kahoot.it/rest/kahoots/?query=${encodeURIComponent(q)}&limit=10`,
      ];
      const want = KahootQuizBank.norm(q);
      for (const url of urls) {
        try {
          const res = await fetch(url, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (!res.ok) continue;
          const json = await res.json();
          const entities = json?.entities || json?.card?.entities || json || [];
          const list = Array.isArray(entities) ? entities : [];
          for (const ent of list) {
            const card = ent?.card || ent;
            const id = String(card?.uuid || card?.kahootId || ent?.uuid || "").trim();
            const t = KahootQuizBank.norm(card?.title || ent?.title || "");
            if (id && /^[0-9a-f-]{20,}$/i.test(id) && (t === want || t.includes(want) || want.includes(t))) {
              return id;
            }
          }
          // First public result as weak fallback when exact title match missing
          for (const ent of list) {
            const card = ent?.card || ent;
            const id = String(card?.uuid || card?.kahootId || "").trim();
            if (id && /^[0-9a-f-]{20,}$/i.test(id)) return id;
          }
        } catch {
          // ignore
        }
      }
      return "";
    }

    static norm(s) {
      return String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&quot;/gi, '"')
        .replace(/&#x27;/gi, "'")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    static #norm(s) {
      return KahootQuizBank.norm(s);
    }

    /** @param {string} quizId */
    static async load(quizId) {
      if (!quizId) return null;
      if (KahootQuizBank.#cache.has(quizId)) return KahootQuizBank.#cache.get(quizId);
      if (KahootQuizBank.#inflight && KahootQuizBank.#inflightId === quizId) {
        return KahootQuizBank.#inflight;
      }
      KahootQuizBank.#inflightId = quizId;
      KahootQuizBank.#inflight = (async () => {
        try {
          const urls = [
            `https://kahoot.it/rest/kahoots/${encodeURIComponent(quizId)}`,
            `https://create.kahoot.it/rest/kahoots/${encodeURIComponent(quizId)}`,
            `https://create.kahoot.it/rest/kahoots/${encodeURIComponent(quizId)}/card/?includeKahoot=true`,
            `https://play.kahoot.it/rest/kahoots/${encodeURIComponent(quizId)}`,
          ];
          for (const url of urls) {
            const res = await fetch(url, {
              credentials: "include",
              headers: { Accept: "application/json" },
            });
            if (!res.ok) continue;
            let json = await res.json();
            if (json?.kahoot && Array.isArray(json.kahoot.questions)) json = json.kahoot;
            if (!json || json.error || !Array.isArray(json.questions)) continue;
            KahootQuizBank.#cache.set(quizId, json);
            KahootQuizBank.rememberQuizId(quizId);
            return json;
          }
        } catch {
          // ignore
        } finally {
          KahootQuizBank.#inflight = null;
          KahootQuizBank.#inflightId = "";
        }
        return null;
      })();
      return KahootQuizBank.#inflight;
    }

    /** @param {string} [quizId] */
    static peek(quizId = KahootQuizBank.quizIdFromUrl()) {
      if (!quizId) return null;
      return KahootQuizBank.#cache.get(quizId) || null;
    }

    static readyLabel() {
      if (!QuizDom.isKahootHost()) {
        if (QuizDom.isQuizHost()) {
          const host = (location.hostname || "").replace(/^www\./, "").split(".")[0] || "quiz";
          return `${host} — tap Ask or select Q+A → QCM`;
        }
        return "Waiting for a question…";
      }
      const id = KahootQuizBank.quizIdFromUrl();
      const bank = KahootQuizBank.peek(id);
      if (QuizDom.isControllerPage() || QuizDom.isShapePad()) {
        return "Live pad — open THIS quiz’s Solo link first (not another game)";
      }
      if (!id) return "Waiting for a question…";
      if (!bank) return "Loading quiz bank…";
      const n = Array.isArray(bank.questions) ? bank.questions.length : 0;
      const title = String(bank.title || "").trim().slice(0, 36);
      if (title && n) return `Armed: ${title} (${n} Q)`;
      if (n) return `Armed (${n} Q) — play next question`;
      return "Quiz loaded — play next question";
    }

    /**
     * Match by live question index (0-based) when the player pad has no text.
     * Rejects type mismatches (e.g. jumble bank vs True/False pad).
     * @param {object} bank
     * @param {number} questionIndex
     * @param {string[]} [pageChoices]
     * @param {{ controller?: boolean, choiceCount?: number }} [hints]
     */
    static matchByIndex(bank, questionIndex, pageChoices = [], hints = {}) {
      const items = Array.isArray(bank?.questions) ? bank.questions : [];
      if (!items.length || !Number.isInteger(questionIndex) || questionIndex < 0) return null;

      let item = items[questionIndex];
      if (!item || /^content$/i.test(String(item.type || ""))) {
        const playable = items.filter((q) => !/^content$/i.test(String(q.type || "")));
        item = playable[questionIndex] || null;
      }
      if (!item) return null;

      const type = String(item.type || "quiz");
      const choiceCount = Number(hints.choiceCount) || pageChoices.length || 0;
      // Guard: don't apply a jumble/open answer onto a 2-tile True/False pad
      if (choiceCount === 2 && /jumble|puzzle|open/i.test(type)) return null;
      if (choiceCount >= 3 && /jumble|puzzle/i.test(type) && choiceCount <= 4) {
        // Live pad is color tiles, not letter fragments — jumble can't map reliably
        if (hints.controller) return null;
      }
      if (choiceCount === 2 && !/true|false|quiz|multiple/i.test(type)) {
        // still allow standard quiz with 2 choices
      }

      const q = KahootQuizBank.cleanAnswer(item.question) || `Question ${questionIndex + 1}`;
      const hit = KahootQuizBank.match(bank, q, pageChoices);
      if (!hit?.ok) return null;
      // Extra guard: jumble label on a non-jumble screen
      if (hit.jumble && hints.controller) return null;
      return hit;
    }

    /**
     * @param {object} bank
     * @param {string} question
     * @param {string[]} [pageChoices]
     */
    static match(bank, question, pageChoices = []) {
      const qn = KahootQuizBank.#norm(question);
      if (!qn || !bank?.questions) return null;
      let best = null;
      let bestScore = 0;
      for (const item of bank.questions) {
        const type = String(item.type || "");
        if (/^content$/i.test(type)) continue;
        const iq = KahootQuizBank.#norm(
          String(item.question || "").replace(/<[^>]+>/g, " ")
        );
        if (!iq) continue;
        let score = 0;
        if (iq === qn) score = 100;
        else if (iq.includes(qn) || qn.includes(iq)) score = 80;
        else {
          const a = new Set(iq.split(" ").filter((w) => w.length > 2));
          const b = new Set(qn.split(" ").filter((w) => w.length > 2));
          if (!a.size || !b.size) continue;
          let hit = 0;
          for (const w of a) if (b.has(w)) hit += 1;
          score = (200 * hit) / (a.size + b.size);
        }
        if (score > bestScore) {
          bestScore = score;
          best = item;
        }
      }
      if (!best || bestScore < 45) return null;

      const choices = Array.isArray(best.choices) ? best.choices : [];
      const type = String(best.type || "quiz");

      // Jumble / puzzle: fragments are already in correct order in the API.
      if (/jumble|puzzle/i.test(type)) {
        const fragments = choices
          .map((c) => String(c?.answer || "").replace(/<[^>]+>/g, " ").trim())
          .filter(Boolean);
        if (!fragments.length) return null;

        /** @type {number[]} page node indexes in correct top→bottom order */
        const orderIndices = [];
        if (pageChoices.length) {
          const norms = pageChoices.map((c) => KahootQuizBank.#norm(c));
          const used = new Set();
          for (const frag of fragments) {
            const an = KahootQuizBank.#norm(frag);
            let idx = norms.findIndex((c, i) => c === an && !used.has(i));
            if (idx < 0) {
              idx = norms.findIndex(
                (c, i) => !used.has(i) && c && an && (c.includes(an) || an.includes(c))
              );
            }
            if (idx >= 0) {
              used.add(idx);
              orderIndices.push(idx);
            }
          }
        }

        return {
          ok: true,
          source: "kahoot_bank",
          type,
          jumble: true,
          indices: orderIndices,
          answers: fragments,
          answer: fragments.join(""),
          orderLabel: `${fragments.join(" → ")}  (${fragments.join("")})`,
          confidence: "high",
          reason: "Kahoot jumble order",
        };
      }

      // Open-ended: usually one correct choice text
      if (/open_ended|open-ended/i.test(type)) {
        const texts = choices
          .filter((c) => c && (c.correct || choices.length === 1))
          .map((c) => String(c.answer || "").replace(/<[^>]+>/g, " ").trim())
          .filter(Boolean);
        if (!texts.length) return null;
        return {
          ok: true,
          source: "kahoot_bank",
          type,
          open: true,
          indices: [],
          answers: texts,
          answer: texts[0],
          confidence: "high",
          reason: "Kahoot open-ended answer",
        };
      }

      const correctTexts = choices
        .filter((c) => c && c.correct)
        .map((c) => String(c.answer || "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim())
        .filter(Boolean);
      if (!correctTexts.length) return null;

      /** @type {number[]} */
      let indices = [];
      if (pageChoices.length) {
        const norms = pageChoices.map((c) => KahootQuizBank.#norm(c));
        for (const ans of correctTexts) {
          const an = KahootQuizBank.#norm(ans);
          let idx = norms.findIndex((c) => c === an);
          if (idx < 0) {
            idx = norms.findIndex((c) => c && an && (c.includes(an) || an.includes(c)));
          }
          if (idx >= 0 && !indices.includes(idx)) indices.push(idx);
        }
        if (!indices.length && pageChoices.length === choices.length) {
          choices.forEach((c, i) => {
            if (c?.correct) indices.push(i);
          });
        }
      } else {
        choices.forEach((c, i) => {
          if (c?.correct) indices.push(i);
        });
      }

      const multi =
        /multi|select/i.test(type) ||
        correctTexts.length > 1 ||
        indices.length > 1;

      return {
        ok: true,
        source: "kahoot_bank",
        type,
        multi,
        indices,
        answers: correctTexts,
        answer: correctTexts.join(" · "),
        confidence: "high",
        reason: "Official Kahoot quiz answers",
      };
    }

    /**
     * @param {string} question
     * @param {string[]} [pageChoices]
     */
    static async solve(question, pageChoices = []) {
      const id = KahootQuizBank.quizIdFromUrl();
      if (!id) return null;
      const bank = await KahootQuizBank.load(id);
      if (!bank) return { ok: false, error: "kahoot_bank_fetch" };
      const hit = KahootQuizBank.match(bank, question, pageChoices);
      if (!hit) return { ok: false, error: "kahoot_bank_miss" };
      return hit;
    }

    /** Strip HTML entities from Kahoot strings. */
    static cleanAnswer(s) {
      return String(s || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&quot;/gi, '"')
        .replace(/&#x27;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    /** Visible page text including open shadow roots (Kahoot often nests UI). */
    static pageText() {
      const chunks = [];
      const walk = (root) => {
        if (!root) return;
        try {
          if (root instanceof Element || root instanceof Document) {
            const text = root.body?.innerText || root.innerText || root.textContent || "";
            if (text) chunks.push(String(text));
          }
        } catch {
          // ignore
        }
        try {
          const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
          for (const el of all) {
            if (el?.shadowRoot) walk(el.shadowRoot);
          }
        } catch {
          // ignore
        }
      };
      walk(document);
      // Aria labels on answer tiles (sometimes not in innerText)
      try {
        for (const el of document.querySelectorAll("[aria-label]")) {
          const a = el.getAttribute("aria-label");
          if (a && a.length > 1 && a.length < 400) chunks.push(a);
        }
      } catch {
        // ignore
      }
      return chunks.join("\n");
    }

    /**
     * Bank-first: find which quiz question is on screen by text, then locate tiles.
     * @returns {Promise<{ quiz: object, hit: object }|null>}
     */
    static async solveFromPage() {
      const id = KahootQuizBank.quizIdFromUrl();
      if (!id) return null;
      const bank = await KahootQuizBank.load(id);
      if (!bank?.questions?.length) return null;

      const pageRaw = KahootQuizBank.pageText();
      const page = KahootQuizBank.norm(pageRaw);
      if (page.length < 20) return null;

      let best = null;
      let bestScore = 0;
      for (const item of bank.questions) {
        const type = String(item.type || "");
        if (/^content$/i.test(type)) continue;
        const q = KahootQuizBank.cleanAnswer(item.question);
        if (q.length < 4) continue;
        const qn = KahootQuizBank.norm(q);
        let score = 0;
        if (qn && page.includes(qn)) score = 100;
        else if (qn) {
          const snip = qn.slice(0, Math.min(28, qn.length));
          if (snip.length >= 8 && page.includes(snip)) score = 88;
          else {
            // Token overlap (handles "Why do we dream?" vs "Why do you think we dream?")
            const a = new Set(qn.split(" ").filter((w) => w.length > 2));
            const b = new Set(page.split(" ").filter((w) => w.length > 2));
            if (a.size) {
              let hit = 0;
              for (const w of a) if (b.has(w)) hit += 1;
              const ratio = hit / a.size;
              if (ratio >= 0.7 && hit >= 3) score = Math.max(score, 75 + Math.round(ratio * 20));
              else if (ratio >= 0.85 && hit >= 2) score = Math.max(score, 72);
            }
          }
        }
        const choices = Array.isArray(item.choices) ? item.choices : [];
        let choiceHits = 0;
        let distinctiveHits = 0;
        for (const c of choices) {
          const a = KahootQuizBank.norm(KahootQuizBank.cleanAnswer(c.answer));
          if (a.length < 1) continue;
          if (page.includes(a)) {
            choiceHits += 1;
            // True/False are weak alone; longer strings are strong
            if (a.length >= 6 && !/^(true|false|yes|no)$/i.test(a)) distinctiveHits += 1;
          }
        }
        if (distinctiveHits >= 2) score = Math.max(score, 80 + distinctiveHits * 5);
        else if (choiceHits >= 2 && score >= 50) score = Math.max(score, 70 + choiceHits * 4);
        else if (choiceHits >= 3) score = Math.max(score, 78 + choiceHits);
        // True/False: need question signal + both tiles
        if (
          choices.length === 2 &&
          choiceHits === 2 &&
          score >= 60 &&
          choices.every((c) => /^(true|false)$/i.test(KahootQuizBank.cleanAnswer(c.answer)))
        ) {
          score = Math.max(score, 85);
        }
        if (score > bestScore) {
          bestScore = score;
          best = item;
        }
      }
      if (!best || bestScore < 65) return null;

      const question = KahootQuizBank.cleanAnswer(best.question);
      const choiceTexts = (best.choices || [])
        .map((c) => KahootQuizBank.cleanAnswer(c.answer))
        .filter(Boolean);
      const nodeList = KahootQuizBank.#locateChoiceNodes(choiceTexts);
      const labels = nodeList.length
        ? nodeList.map((el) =>
            String(el.innerText || el.getAttribute("aria-label") || "")
              .replace(/\s+/g, " ")
              .trim()
          )
        : choiceTexts;

      // Prefer building the hit directly from bank flags (authoritative)
      const type = String(best.type || "quiz");
      /** @type {object|null} */
      let hit = null;
      if (/jumble|puzzle/i.test(type)) {
        const orderIndices = [];
        if (nodeList.length) {
          const norms = labels.map((l) => KahootQuizBank.norm(l));
          const used = new Set();
          for (const frag of choiceTexts) {
            const an = KahootQuizBank.norm(frag);
            let idx = norms.findIndex((c, i) => c === an && !used.has(i));
            if (idx < 0) {
              idx = norms.findIndex(
                (c, i) => !used.has(i) && c && an && (c.includes(an) || an.includes(c))
              );
            }
            if (idx >= 0) {
              used.add(idx);
              orderIndices.push(idx);
            }
          }
        }
        hit = {
          ok: true,
          source: "kahoot_bank",
          jumble: true,
          answers: choiceTexts,
          answer: choiceTexts.join(""),
          orderLabel: `${choiceTexts.join(" → ")}  (${choiceTexts.join("")})`,
          indices: orderIndices,
        };
      } else if (/open/i.test(type)) {
        const answers = (best.choices || [])
          .filter((c) => c && (c.correct || (best.choices || []).length === 1))
          .map((c) => KahootQuizBank.cleanAnswer(c.answer))
          .filter(Boolean);
        if (!answers.length) return null;
        hit = {
          ok: true,
          source: "kahoot_bank",
          open: true,
          answers,
          answer: answers[0],
          indices: [],
        };
      } else {
        const answers = (best.choices || [])
          .filter((c) => c?.correct)
          .map((c) => KahootQuizBank.cleanAnswer(c.answer))
          .filter(Boolean);
        if (!answers.length) {
          hit = KahootQuizBank.match(bank, question, labels) ||
            KahootQuizBank.match(bank, question, choiceTexts);
        } else {
          const indices = [];
          const norms = labels.map((l) => KahootQuizBank.norm(l));
          for (const a of answers) {
            const an = KahootQuizBank.norm(a);
            let idx = norms.findIndex((c) => c === an);
            if (idx < 0) {
              idx = norms.findIndex((c) => c && an && (c.includes(an) || an.includes(c)));
            }
            if (idx < 0 && choiceTexts.length === labels.length) {
              idx = choiceTexts.findIndex((t) => KahootQuizBank.norm(t) === an);
            }
            if (idx >= 0 && !indices.includes(idx)) indices.push(idx);
          }
          // If we couldn't map to page nodes, keep API choice indexes
          if (!indices.length && !nodeList.length) {
            (best.choices || []).forEach((c, i) => {
              if (c?.correct) indices.push(i);
            });
          }
          hit = {
            ok: true,
            source: "kahoot_bank",
            answers,
            answer: answers.join(" · "),
            indices,
            multi: answers.length > 1 || /multi|select/i.test(type),
          };
        }
      }
      if (!hit?.ok) return null;

      const multi = /multi|select/i.test(type) || Boolean(hit.multi);
      const open = /open/i.test(type) || Boolean(hit.open);
      const quiz = {
        mode: hit.jumble ? "mcq" : open ? "open" : multi ? "multi" : "mcq",
        question,
        choices: labels,
        nodes: nodeList,
        fingerprint: `bank:${question}|${hit.answer || hit.answers?.join("|") || ""}`,
        input: open
          ? document.querySelector(
              'input[placeholder*="Type your answer" i], input[placeholder*="Type an answer" i], input[type="text"]'
            )
          : null,
      };

      return { quiz, hit };
    }

    /**
     * Find on-page elements whose visible text matches choice answers.
     * @param {string[]} choiceTexts
     * @returns {Element[]}
     */
    static #locateChoiceNodes(choiceTexts) {
      const wanted = choiceTexts
        .map((t) => ({ raw: t, n: KahootQuizBank.norm(t) }))
        .filter((x) => x.n.length >= 1);
      if (wanted.length < 1) return [];

      /** @type {Map<string, Element>} */
      const found = new Map();
      const candidates = document.querySelectorAll(
        "button, [role='button'], [data-functional-selector], li, div, span"
      );
      for (const el of candidates) {
        if (!(el instanceof Element)) continue;
        if (el.closest("#gosafe-quiz-assist, #gosafe-reader-fab, #gosafe-reader-mode")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 24) continue;
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const text = KahootQuizBank.norm(
          String(el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ")
        );
        if (!text || text.length > 500) continue;
        for (const w of wanted) {
          if (text === w.n || (w.n.length >= 3 && text.includes(w.n)) || (text.length >= 3 && w.n.includes(text))) {
            const prev = found.get(w.n);
            if (!prev) found.set(w.n, el);
            else {
              const pt = KahootQuizBank.norm(
                String(prev.innerText || prev.getAttribute("aria-label") || "")
              );
              if (text.length < pt.length) found.set(w.n, el);
            }
          }
        }
      }

      // Preserve API choice order
      /** @type {Element[]} */
      const ordered = [];
      for (const w of wanted) {
        const el = found.get(w.n);
        if (el && !ordered.includes(el)) ordered.push(el);
      }
      return ordered;
    }
  }

  class QuizAssistApp {
    static #lastFp = "";
    static #busy = false;
    static #timer = 0;
    static #started = false;
    static #channelRetries = 0;

    static start() {
      if (QuizAssistApp.#started) return;
      if (window !== window.top) return;
      if (location.protocol !== "http:" && location.protocol !== "https:") return;
      QuizAssistApp.#started = true;

      // Live Kahoot only: listen for quizId/title sniffed from websockets
      if (QuizDom.isKahootHost()) {
        window.addEventListener("gosafe-kahoot-meta", (ev) => {
          const detail = ev?.detail;
          if (!detail) return;
          KahootQuizBank.setLiveMeta(detail);
          if (detail.quizId) {
            KahootQuizBank.load(String(detail.quizId)).then(() => {
              QuizAssistUi.setIdleHint();
              QuizAssistApp.#lastFp = "";
              QuizAssistApp.ask(true);
            });
          } else if (detail.quizTitle) {
            KahootQuizBank.resolveQuizId().then((id) => {
              if (!id) return;
              KahootQuizBank.load(id).then(() => {
                QuizAssistUi.setIdleHint();
                QuizAssistApp.#lastFp = "";
                QuizAssistApp.ask(true);
              });
            });
          } else if (Number.isInteger(detail.questionIndex)) {
            QuizAssistApp.#lastFp = "";
            QuizAssistApp.ask(true);
          }
        });
        try {
          window.dispatchEvent(new CustomEvent("gosafe-kahoot-meta-request"));
        } catch {
          // ignore
        }
      }

      // Always show the panel on quiz hosts
      if (QuizDom.isQuizHost()) {
        QuizAssistUi.setIdleHint();
      }

      // Prefetch Kahoot bank only on Kahoot
      const id = QuizDom.isKahootHost() ? KahootQuizBank.quizIdFromUrl() : "";
      if (id && !QuizDom.isControllerPage()) {
        QuizAssistUi.setIdleHint();
        KahootQuizBank.load(id).then(() => {
          QuizAssistUi.setIdleHint();
          QuizAssistApp.#lastFp = "";
          QuizAssistApp.ask(true);
        });
      }

      const tick = () => {
        if (!FeatureGate.on()) {
          QuizAssistUi.hide();
          return;
        }
        QuizAssistApp.#schedule();
      };

      tick();
      setInterval(tick, 700);
      document.addEventListener("DOMContentLoaded", tick, { once: true });
      try {
        new MutationObserver(() => QuizAssistApp.#schedule()).observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      } catch {
        // ignore
      }
    }

    static #schedule() {
      clearTimeout(QuizAssistApp.#timer);
      QuizAssistApp.#timer = setTimeout(() => QuizAssistApp.ask(false), 350);
    }

    /** Manual Ask button — force a fresh solve. */
    static retry() {
      QuizAssistApp.#lastFp = "";
      QuizAssistApp.#channelRetries = 0;
      QuizAssistApp.#busy = false;
      QuizAssistUi.setStatus("Solving…", { clearAnswer: true });
      QuizAssistApp.ask(true);
    }

    /**
     * @param {object} payload
     * @returns {Promise<object>}
     */
    static #send(payload) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(payload, (response) => {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve({
                ok: false,
                error: "channel_closed",
                detail: String(err.message || err).slice(0, 160),
              });
              return;
            }
            resolve(response && typeof response === "object" ? response : { ok: false, error: "no_response" });
          });
        } catch (err) {
          resolve({ ok: false, error: String(err?.message || err || "send_failed") });
        }
      });
    }

    /**
     * @param {object} quiz
     * @param {object} res
     * @param {boolean} isOpen
     * @param {boolean} isMulti
     */
    static #applyResult(quiz, res, isOpen, isMulti) {
      if ((isOpen || res.open) && quiz.input) {
        const answer = String(res.answer || "").trim();
        if (!answer) {
          QuizAssistUi.setStatus("Empty answer");
          return;
        }
        QuizAssistUi.fillOpenAnswer(quiz.input, answer.slice(0, quiz.maxLen || 20));
        QuizAssistUi.showAnswer(answer);
        return;
      }

      // Jumble / puzzle — show order, badge tiles 1..n
      if (res.jumble) {
        const label = String(res.orderLabel || res.answer || "");
        if (Array.isArray(res.indices) && res.indices.length && quiz.nodes) {
          QuizAssistUi.markJumbleOrder(quiz.nodes, res.indices);
        }
        QuizAssistUi.showAnswer(label || "See tile order");
        return;
      }

      /** @type {number[]} */
      let indices = Array.isArray(res.indices)
        ? res.indices.map((n) => Number(n)).filter((n) => Number.isInteger(n))
        : [];
      if (!indices.length && Number.isInteger(Number(res.index))) {
        indices = [Number(res.index)];
      }
      const nodeIndices = indices.filter((i) => quiz.nodes?.[i]);

      const multi = Boolean(isMulti || res.multi || nodeIndices.length > 1);
      if (nodeIndices.length && quiz.nodes?.length) {
        QuizAssistUi.filterWrong(quiz.nodes, nodeIndices, { select: multi });
      }

      const label =
        Array.isArray(res.answers) && res.answers.length
          ? res.answers.join(" · ")
          : String(res.answer || "").trim() ||
            (nodeIndices.length && quiz.choices
              ? nodeIndices.map((i) => quiz.choices[i] || `Option ${i + 1}`).join(" · ")
              : "");

      if (label) QuizAssistUi.showAnswer(label);
      else if (!nodeIndices.length) QuizAssistUi.setStatus("No matching option", { clearAnswer: true });
    }

    /** @param {boolean} force */
    static async ask(force) {
      if (!FeatureGate.on()) return;
      if (QuizAssistApp.#busy) return;

      // Keep panel visible on Kahoot even while waiting
      if (QuizDom.isQuizHost() && !document.getElementById("gosafe-quiz-assist")) {
        QuizAssistUi.setIdleHint();
      }

      // 1) Kahoot bank-first only (official answers when quizId is present)
      if (QuizDom.isKahootHost() && KahootQuizBank.quizIdFromUrl() && !QuizDom.isControllerPage()) {
        QuizAssistApp.#busy = true;
        try {
          const packed = await KahootQuizBank.solveFromPage();
          if (packed?.hit?.ok && packed.quiz) {
            const fp = packed.quiz.fingerprint;
            if (!force && fp === QuizAssistApp.#lastFp && QuizAssistUi.hasAnswer()) return;
            QuizAssistApp.#lastFp = fp;
            QuizAssistApp.#channelRetries = 0;
            QuizAssistApp.#applyResult(
              packed.quiz,
              packed.hit,
              packed.quiz.mode === "open" || Boolean(packed.hit.open),
              packed.quiz.mode === "multi" || Boolean(packed.hit.multi)
            );
            return;
          }
        } catch {
          // fall through
        } finally {
          QuizAssistApp.#busy = false;
        }
      }

      const quiz = QuizDom.extract();
      if (!quiz) {
        if (QuizDom.isQuizHost()) {
          if (QuizDom.isControllerPage() || QuizDom.isShapePad()) {
            QuizAssistUi.setStatus(
              QuizDom.isKahootHost()
                ? "Live pad — open THIS quiz’s Solo link first (not another game)"
                : "Waiting for a question — tap Ask when options appear",
              { clearAnswer: true }
            );
          } else if (!QuizAssistUi.hasAnswer()) {
            QuizAssistUi.setIdleHint();
          }
        } else {
          QuizAssistUi.hide();
        }
        return;
      }

      if (!force && quiz.fingerprint === QuizAssistApp.#lastFp && QuizAssistUi.hasAnswer()) return;

      const isOpen = quiz.mode === "open";
      const isMulti = quiz.mode === "multi";
      const fp = quiz.fingerprint;
      QuizAssistApp.#busy = true;
      QuizAssistUi.setStatus("Solving…");

      try {
        // Live Kahoot controller only
        if (QuizDom.isKahootHost() && (quiz.controller || QuizDom.isControllerPage())) {
          QuizAssistUi.showIdRow(true);
          const id = (await KahootQuizBank.resolveQuizId()) || KahootQuizBank.quizIdFromUrl();
          if (!id) {
            QuizAssistApp.#lastFp = fp;
            QuizAssistUi.setStatus(
              "Paste this quiz’s quizId (host Solo URL) then Load",
              { clearAnswer: true }
            );
            QuizAssistUi.showIdRow(true);
            return;
          }
          const bank = await KahootQuizBank.load(id);
          if (!bank?.questions?.length) {
            QuizAssistUi.setStatus("Could not load quiz bank — check quizId", { clearAnswer: true });
            QuizAssistUi.showIdRow(true);
            return;
          }
          QuizAssistUi.showIdRow(false);
          const liveIdx = KahootQuizBank.liveQuestionIndex();
          const idx =
            liveIdx >= 0
              ? liveIdx
              : Number.isInteger(quiz.questionIndex)
                ? quiz.questionIndex
                : 0;
          const bankHit = KahootQuizBank.matchByIndex(bank, idx, quiz.choices || [], {
            controller: true,
            choiceCount: quiz.nodes?.length || quiz.choices?.length || 0,
          });
          if (bankHit?.ok) {
            QuizAssistApp.#lastFp = fp;
            if (Array.isArray(bankHit.indices) && bankHit.indices.length && quiz.choices?.length) {
              const colorLabel = bankHit.indices
                .map((i) => quiz.choices[i] || `Option ${i + 1}`)
                .join(" · ");
              bankHit.answers = [colorLabel, ...(bankHit.answers || [])].filter(
                (v, i, a) => a.indexOf(v) === i
              );
              bankHit.answer = colorLabel;
            }
            QuizAssistApp.#applyResult(quiz, bankHit, false, Boolean(bankHit.multi));
            return;
          }
          QuizAssistUi.setStatus(`No match for Q${idx + 1} — try Ask or check quizId`, {
            clearAnswer: true,
          });
          return;
        }

        const bankHit = QuizDom.isKahootHost()
          ? await KahootQuizBank.solve(quiz.question, quiz.choices || [])
          : null;
        if (bankHit?.ok) {
          QuizAssistApp.#lastFp = fp;
          QuizAssistApp.#channelRetries = 0;
          if (bankHit.open && !quiz.input) {
            const input = document.querySelector(
              'input[placeholder*="Type your answer" i], input[placeholder*="Type an answer" i]'
            );
            if (input instanceof HTMLInputElement) quiz.input = input;
          }
          QuizAssistApp.#applyResult(
            quiz,
            bankHit,
            Boolean(isOpen || bankHit.open),
            Boolean(bankHit.multi) || isMulti
          );
          return;
        }

        if (
          /drag the tiles|arrange them in the correct order/i.test(
            String(document.body?.innerText || "").slice(0, 4000)
          ) &&
          KahootQuizBank.peek()
        ) {
          QuizAssistUi.setStatus("Jumble — waiting for question match…");
          return;
        }

        QuizAssistUi.setStatus("Asking AI…");

        const res = await QuizAssistApp.#send({
          type: "aiAnswerQuiz",
          question: quiz.question,
          choices: quiz.choices || [],
          host: location.hostname || "",
          mode: isOpen ? "open" : isMulti ? "multi" : "mcq",
          maxLen: quiz.maxLen || 20,
        });

        if (!res?.ok) {
          const err = String(res?.error || "failed");
          if (err === "missing_api_key" || err === "ai_disabled") {
            QuizAssistUi.setStatus(
              QuizDom.isKahootHost() && KahootQuizBank.quizIdFromUrl()
                ? "Could not match question yet…"
                : "Add NVIDIA API key in Options"
            );
          } else if (err === "disabled") {
            QuizAssistUi.setStatus("Quiz Assist is off");
          } else if (err === "timeout") {
            QuizAssistUi.setStatus(res.detail || "NVIDIA timed out — retrying…");
            setTimeout(() => {
              QuizAssistApp.#lastFp = "";
              QuizAssistApp.ask(false);
            }, 1200);
          } else if (err === "channel_closed") {
            if (QuizAssistApp.#channelRetries < 2) {
              QuizAssistApp.#channelRetries += 1;
              QuizAssistUi.setStatus("Extension woke up — retrying…");
              setTimeout(() => {
                QuizAssistApp.#lastFp = "";
                QuizAssistApp.ask(false);
              }, 500);
            } else {
              QuizAssistApp.#channelRetries = 0;
              QuizAssistUi.setStatus("AI channel failed — reload extension");
            }
          } else if (/^http_/.test(err)) {
            QuizAssistApp.#channelRetries = 0;
            QuizAssistUi.setStatus(
              `NVIDIA ${err}${res.detail ? `: ${String(res.detail).slice(0, 60)}` : ""}`
            );
          } else {
            QuizAssistApp.#channelRetries = 0;
            QuizAssistUi.setStatus(`Could not answer (${err})`);
          }
          return;
        }

        QuizAssistApp.#channelRetries = 0;
        QuizAssistApp.#lastFp = fp;
        QuizAssistApp.#applyResult(quiz, res, isOpen, isMulti);
      } catch (err) {
        QuizAssistUi.setStatus(`Error: ${String(err?.message || err).slice(0, 80)}`);
      } finally {
        QuizAssistApp.#busy = false;
      }
    }
  }

  QuizAssistApp.start();
})();
