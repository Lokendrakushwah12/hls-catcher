# HLS Catcher

A Chrome (MV3) extension that detects the **HLS/DASH manifests** a page requests
while a video plays, lists their quality variants, and downloads a chosen one as
a single file - without any external service.

HLS (**HTTP Live Streaming**, Apple) and DASH (**Dynamic Adaptive Streaming over
HTTP**, aka MPEG-DASH) are the two dominant adaptive-streaming formats: a small
text *manifest* (`.m3u8` for HLS, `.mpd` for DASH) lists the available quality
"variants" and the media *segments* each is split into.

It's a small, dependency-free study of the two problems every "download this
stream" tool has to solve: **finding** the manifest, and **re-fetching** it past
the CDN protections that assume only the page's own player will ask.

## What it does

1. Watches network traffic for URLs ending in `.m3u8` / `.mpd`.
2. Reads the manifest, parses its variant streams, and shows a quality picker
   with the total duration.
3. On download, fetches every segment of the chosen variant, concatenates them,
   and saves one `.ts` (MPEG-TS) or `.mp4` (fMP4) file.

## How it works - the engineering

### 1. Detection (`background.js`)

A `chrome.webRequest.onBeforeRequest` listener matches manifest URLs
(`/\.(m3u8|mpd)(\?|$)/i`) on every request the page makes. MV3 removed the
*blocking* form of `webRequest`, but a plain observer still sees each request, so
this needs no content script injected into the page.

Detected URLs are keyed by tab and kept in `chrome.storage.session` - **not** a
module variable - because MV3 service workers are killed after ~30s idle and a
`Map` would vanish with them. The list is cleared when the tab navigates or
closes.

> On **Firefox** the same listener can also capture the manifest *body* via
> `filterResponseData`. That API is Firefox-only; on Chrome the `try` block
> throws and we fall back to re-fetching. The code keeps it as a fast path where
> available.

### 2. The re-fetch problem - and how download helpers beat it

Re-fetching a captured manifest URL usually **404s**, even though the same URL
just worked for the player. Two independent reasons, and both had to be handled:

- **Hotlink protection.** These CDNs check the `Referer`/`Origin` header. A fetch
  from the extension's own origin (`chrome-extension://…`) carries the wrong
  header and is rejected. A fetch from the *page* carries the right header but is
  then blocked by the page's **CORS** policy (the manifest is usually on a
  different origin than the page).

The escape from that bind - the trick download helpers use - is to fetch from the
**extension** (host permissions mean no CORS wall) while using
`declarativeNetRequest` to **rewrite the `Referer`/`Origin`** so the CDN sees the
player, not the extension. See `net.js`.

To avoid *guessing* the right `Referer`, `background.js` also records the real one
the player sent (via `onBeforeSendHeaders`, an "extraHeaders" listener) and the
popup replays it exactly; if none was captured it falls back to the target's own
origin, which is almost always allow-listed.

A DNR "session rule" (id 777 for the popup, 778 for the offscreen doc so they
never clobber each other) sets those headers for a growing list of request
domains - the master host, the variant host, and the segment host, added as each
is discovered.

### 3. Downloading in the background (`offscreen.js`)

A download of a long video can take minutes, and a popup is destroyed the moment
it loses focus. So the actual work runs in an **offscreen document** - the one
MV3 context that both has DOM APIs (`Blob` + `URL.createObjectURL`, which service
workers lack) and outlives the popup.

Flow:

```
popup / side panel  --("download")-->  service worker
service worker       --(ensure offscreen doc, "offscreen-download")-->  offscreen
offscreen            --("progress" / "done" / "error")-->  popup (if still open)
```

The offscreen doc fetches segments in batches of 6, concatenates them into a
`Blob`, hands it to `chrome.downloads`, then **closes itself** when its last job
finishes to free the buffered video (which can be hundreds of MB - the whole file
is held in memory; see the `ponytail:` note in the code for the streaming
upgrade path). Because the download lives in the offscreen doc, you can switch
tabs or close the side panel and it keeps going.

### 4. Parsing (`parse.js`)

Plain-text HLS parsing, no library:

- **Master playlist → variants**, sorted by bandwidth (`parseMaster`).
- **Media playlist → segments**, handling the three wrinkles real playlists have
  (`parseSegments`): `#EXT-X-BYTERANGE` (segments are ranges of one file),
  `#EXT-X-MAP` (an fMP4 init segment that must lead the output), and
  `#EXT-X-KEY` (encrypted - refused rather than producing garbage).
- **Duration** by summing `#EXTINF` values (`parseDuration`).

Run the parser's self-check with `node test-parse.js`.

### 5. UI (`popup.html` / `popup.js`)

The same page serves as both the toolbar **popup** and, via the "Dock right"
button, Chrome's **side panel** (`chrome.sidePanel`) - a popup can't be
repositioned, so the side panel is the right-side dock. Each captured manifest
becomes a card with a quality picker, a split Download button with a live
progress bar (`% · MB · segments`), and copy-URL actions. Icons are inlined
Heroicons - the CSP blocks external icon/style fetches.

## Limits

- **DASH (`.mpd`)** is detected and listed but not downloadable - the parser is
  HLS-only.
- **Encrypted (DRM) streams** are refused by design.
- **Audio-only** works when delivered as HLS; direct `.mp3`/`.m4a` files aren't
  detected (save those directly instead).
- The whole file buffers in memory during download.

## Install (unpacked)

`chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
folder. After changing `manifest.json` permissions, remove and re-add (or toggle)
the extension so Chrome re-grants them.

## Legal

For downloading streams you have the right to access. Respect the terms of
service and copyright of the sites you use it on.
