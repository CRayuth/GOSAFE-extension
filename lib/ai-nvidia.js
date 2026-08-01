(() => {
  "use strict";

  /**
   * NVIDIA Integrate (OpenAI-compatible) chat client for the service worker.
   * API key lives in chrome.storage.local only — never hardcode.
   */
  class NvidiaAiSettings {
    static KEY = "aiSettings";
    static DEFAULT_MODEL = "z-ai/glm-5.2";
    static ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
    static #RETIRED = new Set(["z-ai/glm-5.1", "z-ai/glm-5"]);

    /** @returns {Promise<{ enabled: boolean, apiKey: string, model: string, hasKey: boolean }>} */
    static async get() {
      const { aiSettings = null } = await chrome.storage.local.get({ aiSettings: null });
      const raw = aiSettings && typeof aiSettings === "object" ? aiSettings : {};
      const apiKey = String(raw.apiKey || "").trim();
      let model =
        String(raw.model || NvidiaAiSettings.DEFAULT_MODEL).trim() || NvidiaAiSettings.DEFAULT_MODEL;
      if (NvidiaAiSettings.#RETIRED.has(model)) {
        model = NvidiaAiSettings.DEFAULT_MODEL;
        await chrome.storage.local.set({
          aiSettings: {
            enabled: raw.enabled !== false,
            apiKey,
            model,
          },
        });
      }
      return {
        enabled: raw.enabled !== false,
        apiKey,
        model,
        hasKey: Boolean(apiKey),
      };
    }

    /** @param {{ enabled?: boolean, apiKey?: string, model?: string }} patch */
    static async set(patch = {}) {
      const cur = await NvidiaAiSettings.get();
      const next = {
        enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : cur.enabled,
        apiKey:
          patch.apiKey !== undefined ? String(patch.apiKey || "").trim() : cur.apiKey,
        model:
          patch.model !== undefined
            ? String(patch.model || "").trim() || NvidiaAiSettings.DEFAULT_MODEL
            : cur.model,
      };
      await chrome.storage.local.set({ aiSettings: next });
      return {
        enabled: next.enabled,
        model: next.model,
        hasKey: Boolean(next.apiKey),
      };
    }
  }

  class NvidiaChatClient {
    static #cache = new Map();
    static #CAP = 40;

    /**
     * @param {{ system: string, user: string, temperature?: number, maxTokens?: number, cacheKey?: string }} opts
     */
    static async complete(opts) {
      const settings = await NvidiaAiSettings.get();
      if (!settings.enabled) {
        return { ok: false, error: "ai_disabled" };
      }
      if (!settings.apiKey) {
        return { ok: false, error: "missing_api_key" };
      }

      const cacheKey = opts.cacheKey ? String(opts.cacheKey) : "";
      if (cacheKey && NvidiaChatClient.#cache.has(cacheKey)) {
        return { ok: true, text: NvidiaChatClient.#cache.get(cacheKey), cached: true };
      }

      const body = {
        model: opts.model || settings.model,
        temperature: opts.temperature ?? 0.4,
        top_p: 0.9,
        max_tokens: opts.maxTokens ?? 1200,
        stream: false,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      };

      const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 22000);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      let res;
      try {
        res = await fetch(NvidiaAiSettings.ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        const msg = String(err?.message || err || "network_error");
        if (/abort/i.test(msg)) {
          return { ok: false, error: "timeout", detail: `NVIDIA took >${Math.round(timeoutMs / 1000)}s` };
        }
        return { ok: false, error: msg };
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 240);
        } catch {
          // ignore
        }
        return { ok: false, error: `http_${res.status}`, detail };
      }

      let json;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: "bad_json" };
      }

      const text = String(json?.choices?.[0]?.message?.content || "").trim();
      if (!text) return { ok: false, error: "empty_response" };

      if (cacheKey) {
        NvidiaChatClient.#cache.set(cacheKey, text);
        while (NvidiaChatClient.#cache.size > NvidiaChatClient.#CAP) {
          NvidiaChatClient.#cache.delete(NvidiaChatClient.#cache.keys().next().value);
        }
      }
      return { ok: true, text, model: body.model };
    }

    /**
     * @param {{ kind?: string, title?: string, detail?: string, host?: string }} entry
     */
    static explainAlert(entry) {
      const kind = String(entry.kind || "event");
      const title = String(entry.title || "Security event");
      const detail = String(entry.detail || "");
      const host = String(entry.host || "");
      const system =
        "You are GOSAFE, a browser security assistant. Explain blocked/suspicious events " +
        "in clear English for a non-expert. Be concise (under 180 words). Cover: what happened, " +
        "why it matters, and what the user should do. Do not invent facts not in the input.";
      const user = [
        `Event kind: ${kind}`,
        `Title: ${title}`,
        host ? `Host: ${host}` : "",
        detail ? `Detail: ${detail}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return NvidiaChatClient.complete({
        system,
        user,
        maxTokens: 700,
        cacheKey: `alert:${kind}|${title}|${host}|${detail}`.slice(0, 220),
      });
    }

    /**
     * One-line silent safety tip for serious events (no UI chrome).
     * @param {{ kind?: string, title?: string, detail?: string, host?: string }} entry
     */
    static silentTip(entry) {
      const kind = String(entry.kind || "event");
      const title = String(entry.title || "Security event");
      const detail = String(entry.detail || "");
      const host = String(entry.host || "");
      const system =
        "You are GOSAFE. Write ONE short safety tip (max 35 words) for a browser user. " +
        "Format: one sentence what happened + one clear action. No markdown, no bullets, no greeting.";
      const user = [`kind=${kind}`, `title=${title}`, host && `host=${host}`, detail && `detail=${detail}`]
        .filter(Boolean)
        .join("\n");
      return NvidiaChatClient.complete({
        system,
        user,
        maxTokens: 120,
        temperature: 0.2,
        cacheKey: `tip:${kind}|${host}|${title}`.slice(0, 200),
      });
    }

    /**
     * @param {object} fingerprint — structured page tech probe (no secrets)
     */
    static analyzePage(fingerprint) {
      const system =
        "You are GOSAFE, a web technology and security analyst. Given a structured page " +
        "fingerprint (no passwords/cookies values), write a clear report with short sections:\n" +
        "1) Overview\n2) Client / front-end stack\n3) Likely platform / server / hosting clues\n" +
        "4) Third-party services\n5) Security & privacy notes\n6) Risk summary (Low/Medium/High) with reasons.\n" +
        "Be factual from the fingerprint; mark uncertain items as guesses. Under 350 words.";
      const user = `Page fingerprint JSON:\n${JSON.stringify(fingerprint).slice(0, 14000)}`;
      const url = String(fingerprint?.url || "");
      return NvidiaChatClient.complete({
        system,
        user,
        maxTokens: 1400,
        temperature: 0.35,
        cacheKey: `page:${url}|${fingerprint?.title || ""}`.slice(0, 220),
      });
    }

    /**
     * Pick the best quiz answer — MCQ, multi-select, or open type-answer.
     * @param {{ question: string, choices?: string[], host?: string, mode?: string, maxLen?: number }} quiz
     */
    static async answerQuiz(quiz) {
      const question = String(quiz?.question || "").trim().slice(0, 1200);
      if (!question) return { ok: false, error: "bad_quiz" };

      const modeRaw = String(quiz?.mode || "mcq").toLowerCase();
      const mode = modeRaw === "open" ? "open" : modeRaw === "multi" ? "multi" : "mcq";
      if (mode === "open") {
        return NvidiaChatClient.#answerOpenQuiz(question, quiz);
      }

      const choices = Array.isArray(quiz?.choices)
        ? quiz.choices.map((c, i) => {
            const t = String(c || "").trim().slice(0, 400);
            return t || `Option ${i + 1}`;
          })
        : [];
      if (choices.length < 2) {
        return { ok: false, error: "bad_quiz" };
      }

      if (mode === "multi") {
        return NvidiaChatClient.#answerMultiQuiz(question, choices, quiz);
      }

      const numbered = choices.map((c, i) => `${i}: ${c}`).join("\n");
      const system =
        "You are GOSAFE Quiz Assist. Given a multiple-choice quiz question and options, " +
        "pick the single most likely correct option. Reply with ONLY compact JSON (no markdown):\n" +
        '{"index":0,"answer":"exact option text","confidence":"high|medium|low","reason":"short"}\n' +
        "index must be the 0-based option number from the list. Prefer well-known facts. " +
        "If unsure, still pick the best option with confidence low.";
      const user = [
        `Host: ${String(quiz?.host || "").slice(0, 120)}`,
        `Question: ${question}`,
        "Options:",
        numbered,
      ].join("\n");

      const raw = await NvidiaChatClient.complete({
        system,
        user,
        maxTokens: 160,
        temperature: 0.15,
        timeoutMs: 20000,
        cacheKey: `quiz:${question}|${choices.join("|")}`.slice(0, 240),
      });
      if (!raw?.ok) return raw;

      const parsed = NvidiaChatClient.#parseQuizJson(raw.text, choices);
      if (!parsed) {
        return { ok: false, error: "bad_ai_json", detail: String(raw.text || "").slice(0, 200) };
      }
      return {
        ok: true,
        mode: "mcq",
        index: parsed.index,
        indices: [parsed.index],
        answer: parsed.answer,
        confidence: parsed.confidence,
        reason: parsed.reason,
        model: raw.model,
        cached: raw.cached,
      };
    }

    /**
     * @param {string} question
     * @param {string[]} choices
     * @param {{ host?: string }} quiz
     */
    static async #answerMultiQuiz(question, choices, quiz) {
      const numbered = choices.map((c, i) => `${i}: ${c}`).join("\n");
      const system =
        "You are GOSAFE Quiz Assist for multi-select quizzes (Check all that apply). " +
        "Select EVERY option that is factually true / correct. Reply with ONLY compact JSON:\n" +
        '{"indices":[0,2],"answers":["opt text",…],"confidence":"high|medium|low","reason":"short"}\n' +
        "indices are 0-based option numbers. Include all that apply; omit false ones. " +
        "If unsure about one option, leave it out. Prefer well-known facts.";
      const user = [
        `Host: ${String(quiz?.host || "").slice(0, 120)}`,
        `Question: ${question}`,
        "Options:",
        numbered,
      ].join("\n");

      const raw = await NvidiaChatClient.complete({
        system,
        user,
        maxTokens: 280,
        temperature: 0.15,
        timeoutMs: 22000,
        cacheKey: `quiz-multi:${question}|${choices.join("|")}`.slice(0, 240),
      });
      if (!raw?.ok) return raw;

      const parsed = NvidiaChatClient.#parseMultiQuizJson(raw.text, choices);
      if (!parsed || !parsed.indices.length) {
        return { ok: false, error: "bad_ai_json", detail: String(raw.text || "").slice(0, 200) };
      }
      return {
        ok: true,
        mode: "multi",
        indices: parsed.indices,
        index: parsed.indices[0],
        answers: parsed.answers,
        answer: parsed.answers.join("; "),
        confidence: parsed.confidence,
        reason: parsed.reason,
        model: raw.model,
        cached: raw.cached,
      };
    }

    /**
     * @param {string} text
     * @param {string[]} choices
     */
    static #parseMultiQuizJson(text, choices) {
      const raw = String(text || "").trim();
      const fence = raw.match(/\{[\s\S]*\}/);
      let obj;
      try {
        obj = JSON.parse(fence ? fence[0] : raw);
      } catch {
        // Fallback: collect choice texts mentioned in freeform reply
        const lower = raw.toLowerCase();
        const indices = [];
        for (let i = 0; i < choices.length; i += 1) {
          const c = choices[i].toLowerCase();
          if (c.length >= 4 && lower.includes(c)) indices.push(i);
        }
        if (!indices.length) return null;
        return {
          indices,
          answers: indices.map((i) => choices[i]),
          confidence: "low",
          reason: "matched from freeform reply",
        };
      }

      /** @type {number[]} */
      let indices = [];
      if (Array.isArray(obj.indices)) {
        indices = obj.indices.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < choices.length);
      }
      if (!indices.length && Array.isArray(obj.answers)) {
        for (const a of obj.answers) {
          const ans = String(a || "").trim().toLowerCase();
          if (!ans) continue;
          let idx = choices.findIndex((c) => c.toLowerCase() === ans);
          if (idx < 0) {
            idx = choices.findIndex(
              (c) => c.toLowerCase().includes(ans) || ans.includes(c.toLowerCase())
            );
          }
          if (idx >= 0 && !indices.includes(idx)) indices.push(idx);
        }
      }
      if (!indices.length && Number.isInteger(Number(obj.index))) {
        const i = Number(obj.index);
        if (i >= 0 && i < choices.length) indices = [i];
      }
      indices = [...new Set(indices)].sort((a, b) => a - b);
      if (!indices.length) return null;
      const confidence = ["high", "medium", "low"].includes(String(obj.confidence || "").toLowerCase())
        ? String(obj.confidence).toLowerCase()
        : "medium";
      return {
        indices,
        answers: indices.map((i) => choices[i]),
        confidence,
        reason: String(obj.reason || "").slice(0, 180),
      };
    }

    /**
     * @param {string} question
     * @param {{ host?: string, maxLen?: number }} quiz
     */
    static async #answerOpenQuiz(question, quiz) {
      const maxLen = Math.max(4, Math.min(80, Number(quiz?.maxLen) || 20));
      const system =
        "You are GOSAFE Quiz Assist for short typed answers (Kahoot Type Answer). " +
        "Reply with ONLY compact JSON (no markdown):\n" +
        '{"answer":"short text","confidence":"high|medium|low","reason":"short"}\n' +
        `The answer must be concise — prefer a single word or short phrase, max ${maxLen} characters. ` +
        "No punctuation unless essential. Prefer the common English name (e.g. Japan not Nippon).";
      const user = [
        `Host: ${String(quiz?.host || "").slice(0, 120)}`,
        `Max length: ${maxLen}`,
        `Question: ${question}`,
      ].join("\n");

      const raw = await NvidiaChatClient.complete({
        system,
        user,
        maxTokens: 80,
        temperature: 0.1,
        timeoutMs: 18000,
        cacheKey: `quiz-open:${maxLen}:${question}`.slice(0, 240),
      });
      if (!raw?.ok) return raw;

      let answer = "";
      let confidence = "medium";
      let reason = "";
      const fence = String(raw.text || "").match(/\{[\s\S]*\}/);
      try {
        const obj = JSON.parse(fence ? fence[0] : raw.text);
        answer = String(obj.answer || "").trim();
        if (["high", "medium", "low"].includes(String(obj.confidence || "").toLowerCase())) {
          confidence = String(obj.confidence).toLowerCase();
        }
        reason = String(obj.reason || "").slice(0, 180);
      } catch {
        answer = String(raw.text || "")
          .replace(/^["'\s]+|["'\s]+$/g, "")
          .split(/[\n.]/)[0]
          .trim();
        confidence = "low";
      }
      answer = answer.replace(/\s+/g, " ").slice(0, maxLen).trim();
      if (!answer) return { ok: false, error: "empty_answer", detail: String(raw.text || "").slice(0, 120) };
      return {
        ok: true,
        mode: "open",
        answer,
        confidence,
        reason,
        model: raw.model,
        cached: raw.cached,
      };
    }

    /**
     * @param {string} text
     * @param {string[]} choices
     */
    static #parseQuizJson(text, choices) {
      const raw = String(text || "").trim();
      let jsonStr = raw;
      const fence = raw.match(/\{[\s\S]*\}/);
      if (fence) jsonStr = fence[0];
      let obj;
      try {
        obj = JSON.parse(jsonStr);
      } catch {
        // Fallback: match choice text in freeform reply
        const lower = raw.toLowerCase();
        let best = -1;
        for (let i = 0; i < choices.length; i += 1) {
          const c = choices[i].toLowerCase();
          if (c.length >= 2 && lower.includes(c) && (best < 0 || c.length > choices[best].length)) {
            best = i;
          }
        }
        if (best < 0) return null;
        return {
          index: best,
          answer: choices[best],
          confidence: "low",
          reason: "matched from freeform reply",
        };
      }
      let index = Number(obj.index);
      if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
        const ans = String(obj.answer || "").trim().toLowerCase();
        index = choices.findIndex((c) => c.toLowerCase() === ans);
        if (index < 0) {
          index = choices.findIndex(
            (c) => ans && (c.toLowerCase().includes(ans) || ans.includes(c.toLowerCase()))
          );
        }
      }
      if (index < 0 || index >= choices.length) return null;
      const confidence = ["high", "medium", "low"].includes(String(obj.confidence || "").toLowerCase())
        ? String(obj.confidence).toLowerCase()
        : "medium";
      return {
        index,
        answer: choices[index],
        confidence,
        reason: String(obj.reason || "").slice(0, 180),
      };
    }

    /**
     * Answer a QCM from raw selected text (question + options pasted/highlighted together).
     * @param {{ text: string, host?: string }} payload
     */
    static async answerSelectionQuiz(payload) {
      const blob = String(payload?.text || "")
        .replace(/\r/g, "")
        .trim()
        .slice(0, 4000);
      if (blob.length < 8) return { ok: false, error: "bad_quiz" };

      const parsed = NvidiaChatClient.#parseSelectionBlob(blob);
      if (parsed?.choices?.length >= 2) {
        const mode = parsed.multi ? "multi" : "mcq";
        return NvidiaChatClient.answerQuiz({
          question: parsed.question,
          choices: parsed.choices,
          host: payload?.host,
          mode,
        });
      }

      // Freeform selection — let the model extract Q/options and answer
      const system =
        "You are GOSAFE Quiz Assist. The user selected a multiple-choice question " +
        "(and usually its answer options) from a webpage. Identify the question and options, " +
        "then pick the correct answer(s). Reply with ONLY compact JSON (no markdown):\n" +
        '{"answer":"best option text or short answer","answers":["opt1"],"confidence":"high|medium|low","reason":"short"}\n' +
        "If multi-select (check all that apply), put every correct option in answers. " +
        "Prefer well-known facts. answer should be the primary/display string.";
      const user = [
        `Host: ${String(payload?.host || "").slice(0, 120)}`,
        "Selected text:",
        blob,
      ].join("\n");

      const raw = await NvidiaChatClient.complete({
        system,
        user,
        maxTokens: 220,
        temperature: 0.15,
        timeoutMs: 22000,
        cacheKey: `quiz-sel:${blob}`.slice(0, 240),
      });
      if (!raw?.ok) return raw;

      const obj = NvidiaChatClient.#parseLooseJson(raw.text);
      if (!obj) {
        return { ok: false, error: "bad_ai_json", detail: String(raw.text || "").slice(0, 200) };
      }
      const answers = Array.isArray(obj.answers)
        ? obj.answers.map((a) => String(a || "").trim()).filter(Boolean)
        : [];
      const answer =
        String(obj.answer || "").trim() ||
        (answers.length ? answers.join(" · ") : "");
      if (!answer) {
        return { ok: false, error: "bad_ai_json", detail: String(raw.text || "").slice(0, 200) };
      }
      const confidence = ["high", "medium", "low"].includes(String(obj.confidence || "").toLowerCase())
        ? String(obj.confidence).toLowerCase()
        : "medium";
      return {
        ok: true,
        mode: answers.length > 1 ? "multi" : "mcq",
        answer,
        answers: answers.length ? answers : [answer],
        confidence,
        reason: String(obj.reason || "").slice(0, 180),
        model: raw.model,
        cached: raw.cached,
        source: "selection",
      };
    }

    /**
     * Split selected text into question + choices when formatting is clear.
     * @param {string} blob
     * @returns {{ question: string, choices: string[], multi?: boolean } | null}
     */
    static #parseSelectionBlob(blob) {
      const lines = String(blob || "")
        .split(/\n+/)
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (lines.length < 3) {
        // Try A) B) C) on one block
        const inline = String(blob || "");
        const parts = inline.split(/(?=[A-Da-d][).:\-]\s)/);
        if (parts.length >= 3) {
          const question = parts[0].replace(/\s+/g, " ").trim();
          const choices = parts
            .slice(1)
            .map((p) => p.replace(/^[A-Da-d][).:\-]\s*/, "").trim())
            .filter((c) => c.length > 0);
          if (question.length >= 5 && choices.length >= 2) {
            return {
              question,
              choices,
              multi: /check all that apply|select all that apply/i.test(question),
            };
          }
        }
        return null;
      }

      /** @type {string[]} */
      const choiceLines = [];
      /** @type {string[]} */
      const qLines = [];
      let inChoices = false;
      for (const line of lines) {
        const m = /^(?:[A-Da-d]|[1-9]|[①②③④⑤⑥])[).:\-]?\s+(.+)$/.exec(line);
        const bullet = /^[-•*]\s+(.+)$/.exec(line);
        if (m || bullet) {
          inChoices = true;
          choiceLines.push((m ? m[1] : bullet[1]).trim());
        } else if (!inChoices) {
          qLines.push(line);
        } else if (choiceLines.length && line.length < 200) {
          // continuation of last choice
          choiceLines[choiceLines.length - 1] += ` ${line}`;
        }
      }

      // Fallback: last N lines as choices if labeled parse failed
      if (choiceLines.length < 2 && lines.length >= 3) {
        const maybeQ = lines[0];
        const rest = lines.slice(1);
        if (rest.length >= 2 && rest.length <= 8 && maybeQ.length >= 8) {
          return {
            question: maybeQ,
            choices: rest,
            multi: /check all that apply|select all that apply/i.test(maybeQ),
          };
        }
        return null;
      }
      if (choiceLines.length < 2 || !qLines.length) return null;
      const question = qLines.join(" ").trim();
      if (question.length < 5) return null;
      return {
        question,
        choices: choiceLines,
        multi: /check all that apply|select all that apply/i.test(question + blob),
      };
    }

    /** @param {string} text */
    static #parseLooseJson(text) {
      const raw = String(text || "").trim();
      const fence = raw.match(/\{[\s\S]*\}/);
      try {
        return JSON.parse(fence ? fence[0] : raw);
      } catch {
        return null;
      }
    }
  }

  globalThis.AblAi = {
    NvidiaAiSettings,
    NvidiaChatClient,
  };
})();
