# GOSAFE adblock

**Chrome Manifest V3** extension for tracker / ad / phishing defense — plus page helpers for privacy, media, learning tools, and Page Insights.

| | |
|---|---|
| **Version** | `1.27.0` |
| **Platform** | Chromium (Chrome / Edge / Brave) |
| **Engine** | `declarativeNetRequest` + isolated / MAIN-world content scripts |
| **Repo** | [CRayuth/GOSAFE-extension](https://github.com/CRayuth/GOSAFE-extension) |

---

## Table of contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Request & protection flow](#request--protection-flow)
4. [Feature-flag pipeline](#feature-flag-pipeline)
5. [Page Insights](#page-insights)
6. [Install](#install)
7. [Rulesets & build](#rulesets--build)
8. [Project layout](#project-layout)
9. [Development notes](#development-notes)

---

## Features

| Area | What it does |
|------|----------------|
| **Network** | Block / redirect trackers via DNR; strip tracking params; HTTPS upgrade; DNS defense |
| **Privacy** | WebRTC shield, fingerprint noise, random UA, GPC/DNT, cookie-consent reject, clipboard crypto guard |
| **Security** | Phishing / trust score, permission spam guard, malware host feeds, security watch |
| **Page UX** | Force English, link preview, text selection + QCM (NVIDIA), reader mode, video PiP |
| **Site helpers** | YouTube / Spotify ad skip, Medium unlock, login-wall peek, Facebook Add Friend |
| **Quiz Assist** | Kahoot bank + NVIDIA answers (Quizizz / Wayground / Kahoot) |
| **Page Insights** | Privacy receipt, subscription / dark-pattern detectors, session perf block, permissions, health score |
| **Control** | Popup toggles, per-site Auto / Whitelist / Block, hide-element picker, user rules, activity log |

GOSAFE is **not** a fork of uBlock Origin. It reuses community filter lists and implements its own MV3 stack.

---

## Architecture

High-level composition: the **service worker** owns network policy and messages; **content scripts** apply page behavior; the **popup** is the control surface.

```mermaid
flowchart TB
  subgraph UI["Extension UI"]
    Popup["popup/\nstatus · toggles · health card"]
    Options["options/\nUA · user rules"]
  end

  subgraph SW["Service worker — background.js"]
    Router["MessageRouter"]
    Store["ExtensionStateStore\nfeatures · site rules"]
    DNR["RulesetController\nstatic + dynamic + session DNR"]
    Trust["TrustScore / phishing"]
    InsightsBG["PageInsightsController\ncontentSettings · session blocks"]
    Log["ActivityLogStore"]
  end

  subgraph Page["Active tab"]
    Content["content.js\ncosmetics · DOM flags"]
    Isolated["Isolated scripts\nPage Insights · Quiz · Preview …"]
    Main["MAIN world\nclickguard · security · UA spoof"]
  end

  Popup --> Router
  Options --> Router
  Router --> Store
  Router --> DNR
  Router --> Trust
  Router --> InsightsBG
  Router --> Log
  Store -->|"chrome.storage"| Content
  Content -->|"data-gosafe-* flags"| Isolated
  Content -->|"data-adblock-lite-*"| Main
  Isolated --> Router
  DNR -->|"block / redirect / strip"| Net["Network requests"]
```

### OOP style

Each script is a small composition of **value objects**, **catalogs**, **algorithms**, and a **controller** entry (e.g. `ContentController`, `MessageRouter`).

```mermaid
flowchart LR
  VO["Value objects\nHostKey · scores · results"] --> Alg["Algorithms\nsuffix walk · ring buffer · scorers"]
  Alg --> Ctrl["Controllers\napply policy · route messages"]
  Ctrl --> Chrome["Chrome APIs\nDNR · storage · tabs · contentSettings"]
```

---

## Request & protection flow

What happens when a page loads and a subresource is requested:

```mermaid
sequenceDiagram
  participant Tab as Browser tab
  participant DNR as declarativeNetRequest
  participant SW as background.js
  participant CS as content scripts

  Tab->>DNR: Request (script / xhr / pixel …)
  DNR->>DNR: Match allowlist / blocklist / redirects / trackparams
  alt Block or redirect
    DNR-->>Tab: Cancel or stub resource
    DNR->>SW: onRuleMatchedDebug (optional)
    SW->>SW: Activity log + KPIs
  else Allow
    DNR-->>Tab: Continue
  end

  Tab->>CS: document_start / idle inject
  CS->>CS: Publish data-gosafe-* / data-adblock-lite-*
  CS->>CS: Cosmetics, guards, page features
```

### DNR priority (simplified)

```mermaid
flowchart TD
  R["Incoming request"] --> A{"Allowlist\nprio ~1000?"}
  A -->|shell / full allow| OK["Allow"]
  A -->|no| B{"d3host / redirects\nprio ~1100+?"}
  B -->|hit| BR["Block or redirect stub"]
  B -->|no| C{"Blocklists / protections\n/ trackparams?"}
  C -->|hit| BR
  C -->|no| D{"Dynamic / session\nUA · GPC · site · Insights 9700+"}
  D -->|hit| BR
  D -->|no| OK
```

---

## Feature-flag pipeline

Features are camelCase booleans mirrored in **three** places, then published as DOM attributes for page scripts.

```mermaid
flowchart LR
  Popup["popup checkbox"] -->|"setFeature"| BG["background.js\nDEFAULT_FEATURES"]
  BG -->|"chrome.storage.local.features"| Content["content.js\nProtectionPolicy"]
  Content -->|"publishDomFlags()"| DOM["documentElement\ndata-gosafe-*\ndata-adblock-lite-*"]
  DOM --> Page["FeatureGate.on()\nin page-*.js"]
```

| Flag example | DOM attribute | Script |
|--------------|---------------|--------|
| `pageInsights` | `data-gosafe-page-insights` | `page-insights-page.js` |
| `quizAssist` | `data-gosafe-quiz-assist` | `quiz-assist-page.js` |
| `permissionGuard` | `data-adblock-lite-permissions` | `security-page.js` (MAIN) |

Master kill: `data-adblock-lite="off"` (protection paused / disabled).

---

## Page Insights

On-demand panel (no floating button). Open from the popup **Page Health** card; close with **✕** or **Esc**.

```mermaid
flowchart TB
  Popup["Popup · Page Health card"] -->|"openPageInsights"| PI["page-insights-page.js"]
  PI --> Scan["PageScan\nDOM · Resource Timing · a11y"]
  Scan --> Lib["lib/page-insights.js\nsubscription · dark patterns · health math"]
  PI -->|"getTrustScore"| BG["background.js"]
  PI -->|"get/setPagePermission"| CS["chrome.contentSettings"]
  PI -->|"blockThirdPartiesSession"| Session["DNR session rules 9700–9799"]

  subgraph Tabs["Panel tabs"]
    T1["Score"]
    T2["Privacy receipt"]
    T3["Dark patterns"]
    T4["Speed / optimize"]
    T5["Permissions"]
  end
  PI --> Tabs
```

**Health score pillars (weights):** Speed 25 · Privacy 25 · Security 30 · Accessibility 20.

---

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this repository folder
4. Reload the extension after code or ruleset rebuilds

Approve new permissions when prompted (e.g. `contentSettings` for Page Insights permission manager).

---

## Rulesets & build

### Filter sources (lite default)

- [HaGeZi](https://github.com/hagezi/dns-blocklists) Pro Mini, TIF Mini, Fake, Pop-Up Ads  
- [EasyList](https://easylist.to/) / EasyPrivacy / Fanboy Cookie  
- [uBlock uAssets](https://github.com/uBlockOrigin/uAssets) filters, badware, privacy, quick-fixes, unbreak  
- [Peter Lowe](https://pgl.yoyo.org/adservers/) · [URLhaus](https://gitlab.com/malware-filter/urlhaus-filter)  
- AdGuard Tracking Protection (in blocklist build) · URL Tracking → `rules/trackparams.json`

```mermaid
flowchart LR
  Src["Remote filter lists"] --> Build["scripts/build_*.py"]
  Build --> Rules["rules/*.json"]
  Rules --> Manifest["manifest.json\ndeclarative_net_request"]
  Manifest --> Chrome["Chrome DNR engine"]
```

### Common commands

```bash
# Blocklists
python scripts/build_blocklists.py --lite
python scripts/build_blocklists.py --full          # larger; more memory

# Specialized rulesets
python scripts/build_d3host.py
python scripts/build_redirects.py
python scripts/build_trackparams.py
python scripts/refresh_rulesets.py                 # d3host + redirects
python scripts/refresh_rulesets.py --lite

# PhishTrap local signals
pip install datasets
python scripts/build_phishtrap_signals.py

# Chrome Web Store zip
python scripts/pack_store.py                       # → dist/gosafe-adblock.zip
```

GitHub Actions: `.github/workflows/refresh-rulesets.yml` (daily + manual).

### Allowlist model

| Mode | Priority | Behavior |
|------|----------|----------|
| **Full allow** | ~1000 | Streaming, YouTube media, CDNs, fonts, Spotify, Canva, Medium |
| **Shell allow** | ~900 | Major sites for `main_frame` / `sub_frame` only — tracker subdomains still blockable |
| **d3host / redirects** | ~1100+ | Win over broad allow for known tracker hosts |

Build-time `is_allowlisted()` skips tracker-shaped hosts (`ads.*`, `analytics.*`, `pixel.*`, …).

---

## Project layout

```text
GOSAFE-extension/
├── background.js          # Service worker · MessageRouter · DNR · privacy
├── content.js             # Cosmetics · ProtectionPolicy · DOM flags
├── page-insights-page.js  # Page Insights UI (on demand)
├── quiz-assist-page.js    # Quiz Assist
├── security-page.js       # MAIN · clipboard / permissions / scriptlets
├── clickguard-page.js     # MAIN · overlay / open / hijack guards
├── popup/                 # Control UI
├── options/               # UA + user rules pages
├── lib/                   # Shared modules (phishing, activity log, page-insights, …)
├── rules/                 # Compiled DNR JSON
├── scripts/               # Python ruleset builders
└── web-accessible-resources/redirects/   # Empty stubs for $redirect-style neuter
```

### Core modules (`lib/`)

| Module | Role |
|--------|------|
| `ds.js` | `HostKey`, edit distance, LRU cache |
| `phishing.js` | Risk scorer, navigation guard, TrustScore |
| `page-insights.js` | Subscription / dark-pattern regexes, health score math |
| `site-rules.js` | Per-host allow/block → dynamic DNR |
| `activity-log.js` | Ring buffer + KPIs for the popup |
| `list-updater.js` | Supplemental list sync |
| `dns-defense.js` | DNS-layer defense engine |
| `ai-nvidia.js` | NVIDIA chat helpers (Quiz / QCM) |

---

## Development notes

### User rules

Popup → **Rules**, or `options/user-rules.html`:

```text
||tracker.example^
example.com##.ad-rail
##.cookie-banner
```

Network lines → dynamic DNR (ids `9600+`). Cosmetic lines merge with hide-element / adaptive cosmetics.

### Compatibility caveats

- YouTube / Spotify ads are largely first-party — handled by page hooks, not raw host blocks on player APIs  
- Do not block Spotify `spclient` / pathfinder (breaks playback)  
- Peek-without-login only dismisses walls when content is already in the DOM  
- Cosmetic exceptions / full EasyList scriptlets are not fully supported  
- HTTPS upgrade can break rare HTTP-only LAN devices — toggle off if needed  
- Random UA rewrites the HTTP header (DNR) and in-page `navigator` / Client Hints  

### Patterns

- **Message dispatch** — `Map` of `message.type` → handler in `MessageRouter`  
- **Feature gating** — missing `data-gosafe-*` attribute counts as **on** (race-safe with `content.js`)  
- **Session Insights blocks** — DNR rule ids `9700–9799`, opt-in only  

---

## License / credits

Filter lists belong to their respective authors (HaGeZi, EasyList, uBlock uAssets, AdGuard, etc.).  
PhishTrap signal thresholds distilled from [saidutta69/PhishTrap](https://huggingface.co/datasets/saidutta69/PhishTrap).  
UA options inspired by [random-user-agent](https://github.com/tarampampam/random-user-agent).
