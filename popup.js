import { parseMaster, parseDuration, formatTime } from "./parse.js";
import { configure, fetchText } from "./net.js";

const out = document.getElementById("out");
const countChip = document.getElementById("countChip");

// A popup can't be repositioned; the side panel is Chrome's right-side dock.
document.getElementById("dockBtn").onclick = () =>
  chrome.sidePanel.open({ tabId: tab.id }).then(() => window.close());

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const { [`tab${tab.id}`]: urls = [], [`ref${tab.id}`]: capturedReferer } =
  await chrome.storage.session.get([`tab${tab.id}`, `ref${tab.id}`]);
configure(capturedReferer, 777); // popup's own DNR rule id; offscreen uses 778

// Downloads run in the offscreen doc; it reports back here (if we're still open).
const jobs = new Map(); // playlistUrl -> (msg) => void
chrome.runtime.onMessage.addListener((msg) => jobs.get(msg.playlistUrl)?.(msg));

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

  // A media playlist has no variants - it *is* the stream.
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
  go.onclick = () => {
    const playlistUrl = picker.value;
    go.disabled = picker.disabled = true;
    status.textContent = "starting…";
    jobs.set(playlistUrl, (msg) => {
      if (msg.type === "progress") {
        status.textContent = `${msg.done}/${msg.total} segments · ${(msg.bytes / 1e6).toFixed(1)} MB`;
        return;
      }
      status.textContent = msg.type === "done" ? "saved" : msg.message;
      go.disabled = picker.disabled = false;
      jobs.delete(playlistUrl);
    });
    // Handed to the background - keeps running even if this popup/panel closes.
    chrome.runtime.sendMessage({ type: "download", playlistUrl, name: label(picker), referer: capturedReferer });
  };

  row.textContent = "";
  row.append(picker, go, dur);
  status.textContent = variants.length ? `${variants.length} quality option${variants.length === 1 ? "" : "s"}` : "single playlist";
  return el;
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

function streamName(url) {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
    return decodeURIComponent(base).slice(0, 60);
  } catch {
    return "stream";
  }
}
