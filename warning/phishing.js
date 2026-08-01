(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const target = params.get("url") || "";
  const score = params.get("score") || "?";
  const safety = params.get("safety");
  const mode = params.get("mode") || "phishing";
  const reasons = (params.get("reasons") || "").split(",").filter(Boolean);

  const titleEl = document.querySelector("h1");
  const dangerEl = document.querySelector("p.danger");
  const blurbEl = document.querySelector("main.card > p:not(.danger)");
  const targetEl = document.getElementById("target");
  const metaEl = document.getElementById("meta");

  targetEl.textContent = target || "(unknown url)";

  if (mode === "trust" && safety != null) {
    if (titleEl) titleEl.textContent = "Low GOSAFE Security Score";
    if (dangerEl) {
      dangerEl.textContent = `Safety score ${safety}/100 — this site looks risky.`;
    }
    if (blurbEl) {
      blurbEl.textContent =
        "GOSAFE adblock uses local heuristics (HTTPS, scam patterns, risky domains). Domain age and remote malware history are not looked up online.";
    }
    metaEl.textContent = `Safety ${safety}/100${reasons.length ? ` · ${reasons.join(", ")}` : ""}`;
  } else {
    metaEl.textContent = `Risk score ${score}/100${reasons.length ? ` · ${reasons.join(", ")}` : ""}`;
  }

  document.getElementById("report").href =
    "https://www.consumer.ftc.gov/articles/how-recognize-and-avoid-phishing-scams";

  document.getElementById("goBack").addEventListener("click", () => {
    if (history.length > 1) history.back();
    else location.href = "about:blank";
  });

  document.getElementById("allowOnce").addEventListener("click", async () => {
    if (!target) return;
    try {
      let host = "";
      try {
        host = new URL(target).hostname;
      } catch {
        // ignore
      }
      if (host) {
        await chrome.runtime.sendMessage({
          type: "setSiteRule",
          host,
          mode: "allow",
        });
      }
    } catch {
      // ignore
    }
    location.href = target;
  });
})();
