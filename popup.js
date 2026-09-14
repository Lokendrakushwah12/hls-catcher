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

// Heroicons (solid/mini, 20px) inlined — external icon fetches are CSP-blocked.
const ICON = {
  download: `<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 1 0-1.09-1.03l-2.955 3.129V2.75Z"/><path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z"/></svg>`,
  copy: `<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5A1.5 1.5 0 0 1 15.5 14h-.5v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z"/><path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z"/></svg>`,
  clock: `<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z" clip-rule="evenodd"/></svg>`,
  chevron: `<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a.75.75 0 0 1 .55.24l3.25 3.5a.75.75 0 1 1-1.1 1.02L10 4.852 7.3 7.76a.75.75 0 0 1-1.1-1.02l3.25-3.5A.75.75 0 0 1 10 3Zm-3.76 9.2a.75.75 0 0 1 1.06.04l2.7 2.908 2.7-2.908a.75.75 0 1 1 1.1 1.02l-3.25 3.5a.75.75 0 0 1-1.1 0l-3.25-3.5a.75.75 0 0 1 .04-1.06Z" clip-rule="evenodd"/></svg>`,
  play: `<svg class="play" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM9.555 7.168A1 1 0 0 0 8 8v4a1 1 0 0 0 1.555.832l3-2a1 1 0 0 0 0-1.664l-3-2Z" clip-rule="evenodd"/></svg>`,
};

// Briefly show "Copied" feedback on a button that has a trailing text span.
async function copyToClipboard(url, labelEl) {
  await navigator.clipboard.writeText(url);
  const prev = labelEl.textContent;
  labelEl.textContent = "Copied";
  setTimeout(() => (labelEl.textContent = prev), 1200);
}

// One open menu at a time.
document.addEventListener("click", () => document.querySelectorAll(".menu").forEach((m) => (m.hidden = true)));

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
    <div class="thumbRow">
      <div class="thumb">${ICON.play}<span class="thumbBadge">HLS</span></div>
      <div class="meta">
        <div class="chipRow">
          <span class="chip blue">HLS</span>
          <span class="chip">Manifest</span>
          <span class="chip dur" hidden>${ICON.clock}<span class="durText"></span></span>
        </div>
        <div class="streamTitle"></div>
        <button class="iconBtn copyBtn" type="button" title="Copy manifest URL">${ICON.copy}<span>Copy URL</span></button>
      </div>
    </div>
    <div class="controls">
      <div class="row"></div>
      <div class="status"></div>
      <div class="progress" hidden><span></span></div>
    </div>`;
  const title = el.querySelector(".streamTitle");
  const row = el.querySelector(".row");
  const status = el.querySelector(".status");
  const bar = el.querySelector(".progress");
  const durChip = el.querySelector(".chip.dur");
  const durText = el.querySelector(".durText");

  const manifestUrl = typeof url === "string" ? url : url.url;
  const manifestBody = typeof url === "string" ? null : url.body;

  title.textContent = streamName(manifestUrl);
  el.querySelector(".copyBtn").onclick = (e) =>
    copyToClipboard(manifestUrl, e.currentTarget.querySelector("span"));
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

  const refresh = () =>
    duration(picker.value).then((t) => {
      durText.textContent = t;
      durChip.hidden = !t;
      el.querySelector(".thumbBadge").textContent =
        picker.selectedOptions[0].textContent.split(" · ")[0];
    });
  picker.onchange = refresh;
  refresh();

  // Split Download button: main action + chevron menu (copy the stream URL).
  const go = document.createElement("button");
  go.className = "btn";
  go.innerHTML = `${ICON.download}<span>Download</span>`;
  go.onclick = () => startDownload(picker, go, status, bar);

  const chev = document.createElement("button");
  chev.className = "chev";
  chev.type = "button";
  chev.innerHTML = ICON.chevron;

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.hidden = true;
  const copyStream = document.createElement("button");
  copyStream.innerHTML = `${ICON.copy}<span>Copy stream URL</span>`;
  copyStream.onclick = (e) => copyToClipboard(picker.value, e.currentTarget.querySelector("span"));
  menu.append(copyStream);

  chev.onclick = (e) => {
    e.stopPropagation(); // the document handler would otherwise close it at once
    const open = menu.hidden;
    document.querySelectorAll(".menu").forEach((m) => (m.hidden = true));
    menu.hidden = !open;
  };

  const split = document.createElement("div");
  split.className = "split";
  split.append(go, chev, menu);

  row.textContent = "";
  row.append(picker, split);
  status.textContent = variants.length
    ? `${variants.length} quality option${variants.length === 1 ? "" : "s"}`
    : "single playlist";
  return el;
}

// Hand the selected quality to the background; reflect progress here.
function startDownload(picker, go, status, bar) {
  const playlistUrl = picker.value;
  const fill = bar.firstElementChild;
  go.disabled = picker.disabled = true;
  bar.hidden = false;
  fill.style.width = "0%";
  status.textContent = "starting…";
  jobs.set(playlistUrl, (msg) => {
    if (msg.type === "progress") {
      const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
      fill.style.width = `${pct}%`;
      status.textContent = `${pct}% · ${(msg.bytes / 1e6).toFixed(1)} MB · ${msg.done}/${msg.total} segments`;
      return;
    }
    if (msg.type === "done") {
      fill.style.width = "100%";
      status.textContent = "Saved";
    } else {
      bar.hidden = true;
      status.textContent = msg.message;
    }
    go.disabled = picker.disabled = false;
    jobs.delete(playlistUrl);
  });
  // Handed to the background - keeps running even if this popup/panel closes.
  chrome.runtime.sendMessage({ type: "download", playlistUrl, name: label(picker), referer: capturedReferer });
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
