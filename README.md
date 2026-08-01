# GOSAFE adblock

Manifest V3 ad / tracker / phishing blocker with YouTube skip, redirect guards, and Medium member-story reader.

## Architecture (OOP)

Each script is a small composition of classes — data objects, algorithms, and a controller:

| File | Responsibility |
|------|----------------|
| `background.js` | Service worker: DNR + HTTPS ruleset, WebRTC privacy, download guard, message router |
| `content.js` | Cosmetics, redirect guard, HTTPS insecure banner, DOM feature flags |
| `clickguard-page.js` | MAIN world: overlay / `window.open` / location hijack guards |
| `security-page.js` | MAIN world: clipboard crypto guard, scriptlets, permission spam |
| `ua-generator.js` / `ua-page.js` | Random User-Agent pool + MAIN-world navigator spoof |
| `options/user-agent.html` | User-Agent settings page (pool, rotation, renew) |
| `youtube.js` | Hide YouTube chrome ads via CSS |
| `youtube-page.js` | MAIN world: DFS-clean player JSON + ad skip/seek state machine |
| `medium.js` | Detect locked posts, fetch mirror, reader overlay |
| `popup/popup.js` | Toggle UI + blocked counter |

### Patterns used

- **Value objects** — `ArticleUrl`, `UnlockResult`, `PopupStatus`
- **Catalogs / sets** — selector lists, mirror queues, regex matchers
- **Algorithms** — DFS JSON ad prune, domain-suffix walk, batched CSS chunking, linear mirror failover, debounced mutation coalesce
- **Controllers** — one app entry per script (`ContentController`, `MediumUnlockController`, …)
- **Message dispatch table** — `Map` of command → handler in the background worker

## Filter sources

Default **lite** profile (uBlock-style defaults, size-capped):

- [HaGeZi Pro Mini](https://github.com/hagezi/dns-blocklists)
- [EasyList](https://easylist.to/easylist/easylist.txt) / [EasyPrivacy](https://easylist.to/easylist/easyprivacy.txt)
- [Fanboy Cookie](https://easylist.to/)
- [uBlock filters](https://github.com/uBlockOrigin/uAssets) (filters, badware, privacy, quick-fixes, unbreak) — same public lists [uBlock Origin](https://github.com/gorhill/uBlock) ships by default
- [Peter Lowe’s ad servers](https://pgl.yoyo.org/adservers/)
- [URLhaus malicious hosts](https://gitlab.com/malware-filter/urlhaus-filter)

GOSAFE adblock is **not** a fork of uBlock Origin. It uses Chrome MV3 `declarativeNetRequest` plus its own page helpers. We only reuse the community filter lists uBO also recommends.

Optional **full** mega-list build (much larger; higher Chrome memory):

```bash
python scripts/build_blocklists.py --full
```

Full adds AdGuard DNS, OISD big, HaGeZi Pro, StevenBlack, GoodbyeAds, and more Fanboy lists (plus the uBO extras above).

## Phishing CSVs (optional)

Uploaded CSVs were quarantined after false positives (Canva/Medium got blocked).

- Quarantine folder: `d:\extension-cache\csv-quarantine`
- CSV import is **off by default**
- Only enable if you trust the labels:

```bash
python scripts/build_blocklists.py --with-csv
```

## Popup UX (v1.9)

Black-and-white control surface with:

- Master protection toggle + per-site pause
- Feature switches: cosmetics, click-jack, YouTube/Spotify/Medium helpers, download shield
- Security: HTTPS, clipboard, scriptlets, WebRTC, permissions, random UA, phishing heuristics, fingerprint shield, list auto-update
- Per-site **Auto / Whitelist / Block** — Whitelist trusts the site but keeps ads/trackers blocked and Activity monitoring on
- **Hide element** picker — click any leftover UI on a page to hide it permanently for that site
- Blocked counter + mode (Full / Custom / Off)
- Options page for User-Agent pool / auto-renew (inspired by [random-user-agent](https://github.com/tarampampam/random-user-agent))

## OOP modules (`lib/`)

| Module | Structures / algorithms |
|--------|-------------------------|
| `lib/ds.js` | `HostKey` suffix walk, Levenshtein DP, LRU `Map` cache |
| `lib/phishing.js` | Weighted risk scorer + navigation guard |
| `lib/site-rules.js` | Rule book (longest-suffix) → DNR dynamic sync |
| `lib/list-updater.js` | Mirror failover fetch → domain set → batched DNR rules |
| `lib/activity-log.js` | Ring buffer of recent protection events |
| `fingerprint-page.js` | Session XorShift32 noise for canvas/audio/WebGL |

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** → **Load unpacked** → select `d:\extension`
3. Reload the extension after code or list rebuilds

## Refresh blocklists

```bash
python scripts/build_blocklists.py --lite
# or: python scripts/build_blocklists.py --full
```

Raw downloads stay in `d:\extension-cache` so the unpacked package stays small.

## Pack for Chrome Web Store

```bash
python scripts/pack_store.py
```

Output: `dist/gosafe-adblock.zip` (excludes `_metadata`, scripts, and caches).

## Notes

- YouTube video ads are first-party; player hooks handle skip/seek
- Spotify audio ads are first-party; page hooks mute and seek/finish short ad clips (≤90s). Network blocks on `spclient` / pathfinder break playback — do not add them
- Peek without login dismisses signup/login overlays (Quora, FB public pages, X, etc.) when content is already in the page — it cannot invent private feed data
- Google/YouTube/streaming/Medium/Canva domains are allowlisted so pages load
- Medium member-only stories are preview-only in the DOM; full text is loaded via a mirror reader
- Cosmetic exceptions / procedural filters / full EasyList scriptlets are not fully supported
- HTTPS upgrade may break rare HTTP-only LAN devices — toggle off if needed
- WebRTC shield uses `chrome.privacy` (`disable_non_proxied_udp`)
- Random User-Agent rewrites the HTTP header (DNR) and `navigator.userAgent` / Client Hints in-page
