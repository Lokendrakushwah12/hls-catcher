import { parseMaster, parseSegments, parseDuration, formatTime } from "./parse.js";

const out = document.getElementById("out");
const countChip = document.getElementById("countChip");
const spoofedHosts = new Set(); // hosts already covered by the DNR referer rule

// A popup can't be repositioned; the side panel is Chrome's right-side dock.
document.getElementById("dockBtn").onclick = () =>
  chrome.sidePanel.open({ tabId: tab.id }).then(() => window.close());

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const { [`tab${tab.id}`]: urls = [], [`ref${tab.id}`]: capturedReferer } =
  await chrome.storage.session.get([`tab${tab.id}`, `ref${tab.id}`]);

if (urls.length) {
  out.className = "";
  out.textContent = "";
  countChip.textContent = `${urls.length} found`;
  for (const url of urls) out.append(await card(url));
} else {
  countChip.textContent = "0 found";
}

async function card(url) {
  const el = document.createElement("div");
  el.className = "stream";
  el.innerHTML = `
    <div class="streamTop">
      <div class="meta">
        <div class="chipRow">
          <span class="chip blue">HLS</span>
          <span class="chip">Manifest</span>
        </div>
        <div class="streamTitle"></div>
        <div class="url"></div>
      </div>
    </div>
    <div class="thumbRow">
      <div class="thumb"></div>
      <div class="controls">
        <div class="row"></div>
        <div class="status"></div>
      </div>
    </div>`;
  const title = el.querySelector(".streamTitle");
  const urlEl = el.querySelector(".url");
  const row = el.querySelector(".row");
  const status = el.querySelector(".status");

  const manifestUrl = typeof url === "string" ? url : url.url;
  const manifestBody = typeof url === "string" ? null : url.body;

  title.textContent = streamName(manifestUrl);
  urlEl.textContent = manifestUrl;
  row.textContent = "reading…";

  let variants = [];
  try {
    const { text, resolvedUrl } = manifestBody
      ? { text: manifestBody, resolvedUrl: manifestUrl }
      : await fetchText(manifestUrl);
    variants = parseMaster(text, resolvedUrl);
  } catch (error) {
    row.textContent = `could not fetch manifest${error?.message ? ` (${error.message})` : ""}`;
    return el;
  }

  // A media playlist has no variants — it *is* the stream.
  const picker = document.createElement("select");
  for (const v of variants) {
    picker.append(new Option(`${v.resolution} · ${Math.round(v.bandwidth / 1000)} kbps`, v.url));
  }
  if (!variants.length) picker.append(new Option("single stream", manifestUrl));

  const dur = document.createElement("span");
  dur.className = "dur";
  const refresh = () => duration(picker.value).then((t) => (dur.textContent = t));
  picker.onchange = refresh;
  refresh();

  const go = document.createElement("button");
  go.textContent = "Download";
  go.className = "primary";
  go.onclick = async () => {
    go.disabled = picker.disabled = true;
    try {
      await grab(picker.value, label(picker), (done, total, bytes) => {
        status.textContent = `${done}/${total} segments · ${(bytes / 1e6).toFixed(1)} MB`;
      });
      status.textContent = "saved";
    } catch (e) {
      status.textContent = e.message;
    }
    go.disabled = picker.disabled = false;
  };

  row.textContent = "";
  row.append(picker, go, dur);
  status.textContent = variants.length ? `${variants.length} quality option${variants.length === 1 ? "" : "s"}` : "single playlist";
  return el;
}

// Fetch every segment and concatenate. MPEG-TS and fMP4 are both designed to
// be concatenatable — fMP4 just needs its #EXT-X-MAP init segment in front.
async function grab(playlistUrl, name, onProgress) {
  const { text, resolvedUrl } = await fetchText(playlistUrl);
  const { segments, initUrl, encrypted } = parseSegments(text, resolvedUrl);
  if (encrypted) throw new Error("encrypted stream — not supported");
  if (!segments.length) throw new Error("no segments found");

  const parts = initUrl ? [await fetchSegment({ url: initUrl })] : [];
  let bytes = 0;

  // ponytail: whole file buffered in memory, ~400 MB at 1080p. Swap for the
  // File System Access API and stream to disk if you hit the wall.
  const BATCH = 6;
  for (let i = 0; i < segments.length; i += BATCH) {
    const chunk = await Promise.all(segments.slice(i, i + BATCH).map(fetchSegment));
    for (const b of chunk) bytes += b.byteLength;
    parts.push(...chunk); // Promise.all preserves order
    onProgress(Math.min(i + BATCH, segments.length), segments.length, bytes);
  }

  const blob = new Blob(parts, { type: initUrl ? "video/mp4" : "video/mp2t" });
  await chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: `${name}.${initUrl ? "mp4" : "ts"}`,
  });
}

function label(picker) {
  const base = (tab.title || "stream").replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "stream";
  const res = picker.selectedOptions[0].textContent.split(" · ")[0];
  return `${base} ${res}`.replace(/\s+/g, "-");
}

async function duration(url) {
  try {
    const { text } = await fetchText(url);
    const secs = parseDuration(text);
    return secs ? formatTime(secs) : "live";
  } catch {
    return "";
  }
}

async function fetchText(url, options) {
  return fetchViaPage(url, "text", options);
}

// Fetch from the extension (host_permissions = no CORS wall) but use DNR to set
// Referer/Origin to the page, so these CDNs' hotlink check sees the video
// player, not chrome-extension://. This is how download helpers get past 404s.
async function fetchViaPage(url, responseType, options) {
  await spoofReferer(url);
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (responseType === "text") {
    return { text: await response.text(), resolvedUrl: response.url || url };
  }
  const buffer = await response.arrayBuffer();
  return { bytes: Array.from(new Uint8Array(buffer)), resolvedUrl: response.url || url };
}

// One session DNR rule whose domain list grows to cover every host we touch
// (master host, variant host, segment host). Referer/Origin = the page.
async function spoofReferer(url) {
  const host = new URL(url).hostname;
  if (spoofedHosts.has(host)) return;
  spoofedHosts.add(host);
  // The Referer the player actually sent; fall back to the target's own origin
  // (its own domain is almost always in the hotlink allowlist), never the page.
  const referer = capturedReferer || new URL(url).origin + "/";
  const origin = new URL(referer).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [777],
    addRules: [{
      id: 777,
      priority: 1,
      condition: { requestDomains: [...spoofedHosts], resourceTypes: ["xmlhttprequest"] },
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "referer", operation: "set", value: referer },
          // ponytail: drop this Origin line if a CDN 403s on it — Referer is
          // the usual hotlink signal, Origin only matters for stricter ones.
          { header: "origin", operation: "set", value: origin },
        ],
      },
    }],
  });
}

async function fetchSegment({ url, range }) {
  const opts = range
    ? { headers: { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }
    : undefined;
  const { bytes } = await fetchViaPage(url, "bytes", opts);
  return new Uint8Array(bytes).buffer;
}

function streamName(url) {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
    return decodeURIComponent(base).slice(0, 60);
  } catch {
    return "stream";
  }
}
