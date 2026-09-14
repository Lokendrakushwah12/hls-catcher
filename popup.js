import { parseMaster, parseDuration, formatTime } from "./parse.js";
import { configure, fetchText } from "./net.js";

const out = document.getElementById("out");
const countChip = document.getElementById("countChip");

// A popup can't be repositioned; the side panel is Chrome's right-side dock.
document.getElementById("dockBtn").onclick = () =>
  chrome.sidePanel.open({ tabId: tab.id }).then(() => window.close());

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let currentReferer = null; // captured Referer for this tab (may change per song)
let thumbDataUrl = null; // current <video> frame

// Downloads run in the offscreen doc; it reports back here (if we're still open).
const jobs = new Map(); // playlistUrl -> (msg) => void
chrome.runtime.onMessage.addListener((msg) => {
  if (["progress", "status", "done", "error"].includes(msg.type)) jobs.get(msg.playlistUrl)?.(msg);
});

// Manifests on this tab, for pairing a video track with its demuxed audio.
const catalog = []; // { manifestUrl, audioOnly, mediaPlaylist, audioPlaylistUrl }

const AUDIO_CODEC = /^(mp4a|opus|ac-3|ec-3|flac|vorbis)/;
const VIDEO_CODEC = /(avc|hvc|hev|av01|vp0|vp8|vp9|dvh)/;
const isAudioOnly = (variants) =>
  variants.length > 0 && variants.every((v) => AUDIO_CODEC.test(v.codecs) && !VIDEO_CODEC.test(v.codecs));

// Formats we can reach with `-c copy` (container change, no re-encode).
const VIDEO_FORMATS = ["mp4", "mkv"];
const AUDIO_FORMATS = ["m4a", "mkv"];

// Heroicons (solid/mini, 20px) inlined - external icon fetches are CSP-blocked.
const ICON = {
  download: `<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 1 0-1.09-1.03l-2.955 3.129V2.75Z"/><path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z"/></svg>`,
  copy: `<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5A1.5 1.5 0 0 1 15.5 14h-.5v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z"/><path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z"/></svg>`,
  clock: `<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z" clip-rule="evenodd"/></svg>`,
  chevron: `<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a.75.75 0 0 1 .55.24l3.25 3.5a.75.75 0 1 1-1.1 1.02L10 4.852 7.3 7.76a.75.75 0 0 1-1.1-1.02l3.25-3.5A.75.75 0 0 1 10 3Zm-3.76 9.2a.75.75 0 0 1 1.06.04l2.7 2.908 2.7-2.908a.75.75 0 1 1 1.1 1.02l-3.25 3.5a.75.75 0 0 1-1.1 0l-3.25-3.5a.75.75 0 0 1 .04-1.06Z" clip-rule="evenodd"/></svg>`,
  play: `<svg class="play" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM9.555 7.168A1 1 0 0 0 8 8v4a1 1 0 0 0 1.555.832l3-2a1 1 0 0 0 0-1.664l-3-2Z" clip-rule="evenodd"/></svg>`,
  pencil: `<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793ZM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828Z"/></svg>`,
};

// Strip characters that are illegal in filenames; keep spaces and unicode.
const fileName = (text) => text.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 120) || "stream";

// Briefly show "Copied" feedback on a button that has a trailing text span.
async function copyToClipboard(url, labelEl) {
  await navigator.clipboard.writeText(url);
  const prev = labelEl.textContent;
  labelEl.textContent = "Copied";
  setTimeout(() => (labelEl.textContent = prev), 1200);
}

// One open menu at a time.
document.addEventListener("click", () => document.querySelectorAll(".menu").forEach((m) => (m.hidden = true)));

await render();

// The side panel stays open across song/page changes, so re-render when this
// tab's captured list changes. (The popup re-runs on each open, so it's covered
// there too.) Skip while a download is active so we don't wipe its live UI.
let rerenderTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !(`tab${tab.id}` in changes) || jobs.size) return;
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(render, 300);
});

async function render() {
  const { [`tab${tab.id}`]: urls = [], [`ref${tab.id}`]: capturedReferer } =
    await chrome.storage.session.get([`tab${tab.id}`, `ref${tab.id}`]);
  currentReferer = capturedReferer;
  configure(capturedReferer, 777); // popup's own DNR rule id; offscreen uses 778
  thumbDataUrl = await captureThumb();
  catalog.length = 0;
  out.textContent = "";
  if (urls.length) {
    out.className = "list";
    countChip.textContent = `${urls.length} found`;
    for (const url of urls) out.append(await card(url));
  } else {
    out.className = "empty";
    out.textContent = "Nothing yet - play the video with this open, or reload the page.";
    countChip.textContent = "0 found";
  }
}

// The actual <video> frame (not a tab screenshot) as the card thumbnail. Runs
// in the page, draws the current frame to a canvas. Tainted canvases (a
// cross-origin <video> without CORS) throw on export -> null -> placeholder.
function captureThumb() {
  return chrome.scripting
    .executeScript({
      target: { tabId: tab.id, allFrames: true }, // players are often in an iframe
      func: () => {
        const v = [...document.querySelectorAll("video")]
          .filter((v) => v.videoWidth > 0)
          .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
        if (!v) return null;
        const c = document.createElement("canvas");
        const scale = Math.min(1, 320 / v.videoWidth);
        c.width = v.videoWidth * scale;
        c.height = v.videoHeight * scale;
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        try {
          return c.toDataURL("image/jpeg", 0.7);
        } catch {
          return null;
        }
      },
    })
    .then((results) => results.map((r) => r.result).find(Boolean) ?? null)
    .catch(() => null);
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
          <span class="chip size" hidden><span class="sizeText"></span></span>
        </div>
        <div class="titleEdit">
          <div class="streamTitle" contenteditable="true" spellcheck="false"></div>
          <button class="editBtn" type="button" title="Edit download name">${ICON.pencil}</button>
        </div>
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
  const sizeChip = el.querySelector(".chip.size");
  const sizeText = el.querySelector(".sizeText");

  const manifestUrl = typeof url === "string" ? url : url.url;
  const manifestBody = typeof url === "string" ? null : url.body;

  title.textContent = tab.title || streamName(manifestUrl);
  // Enter commits (no newline); the pencil focuses and selects the text.
  title.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); title.blur(); }
  };
  el.querySelector(".editBtn").onclick = () => {
    title.focus();
    getSelection().selectAllChildren(title);
  };
  if (thumbDataUrl) el.querySelector(".thumb").style.backgroundImage = `url("${thumbDataUrl}")`;
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

  const audioOnly = isAudioOnly(variants);
  catalog.push({
    manifestUrl,
    audioOnly,
    mediaPlaylist: !variants.length,
    audioPlaylistUrl: audioOnly && variants.length ? variants[0].url : manifestUrl,
  });

  // A media playlist has no variants - it *is* the stream.
  const picker = document.createElement("select");
  for (const v of variants) {
    picker.append(new Option(`${v.resolution} · ${Math.round(v.bandwidth / 1000)} kbps`, v.url));
  }
  if (!variants.length) picker.append(new Option("single stream", manifestUrl));

  // Output container. ffmpeg remuxes to this (no more raw .ts).
  const fmt = document.createElement("select");
  fmt.className = "fmt";
  fmt.title = "Output format";
  for (const f of audioOnly ? AUDIO_FORMATS : VIDEO_FORMATS) fmt.append(new Option(f.toUpperCase(), f));

  const bwByUrl = new Map(variants.map((v) => [v.url, v.bandwidth]));
  const refresh = async () => {
    const secs = await duration(picker.value);
    durText.textContent = secs ? formatTime(secs) : "live";
    durChip.hidden = secs == null;
    if (variants.length)
      el.querySelector(".thumbBadge").textContent = picker.selectedOptions[0].textContent.split(" · ")[0];
    // size ≈ bitrate × duration ÷ 8 (remux keeps the bytes; VBR makes it a ~).
    const bw = bwByUrl.get(picker.value);
    sizeChip.hidden = !(bw && secs);
    if (bw && secs) sizeText.textContent = "~" + formatSize((bw / 8) * secs);
  };
  picker.onchange = refresh;
  refresh();

  const start = (audioUrl) =>
    startDownload({ playlistUrl: picker.value, audioUrl, name: fileName(title.textContent), format: fmt.value, go, picker, status, bar });

  // Split Download button: main action + chevron menu.
  const go = document.createElement("button");
  go.className = "btn";
  go.innerHTML = `${ICON.download}<span>Download</span>`;
  go.onclick = () => start();

  const chev = document.createElement("button");
  chev.className = "chev";
  chev.type = "button";
  chev.innerHTML = ICON.chevron;

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.hidden = true;

  // On demuxed sites (e.g. YouTube) the audio is a separate manifest - offer to
  // fetch it and mux into one file.
  if (variants.length && !audioOnly) {
    const muxItem = document.createElement("button");
    muxItem.innerHTML = `${ICON.download}<span>Download with audio</span>`;
    muxItem.onclick = () => {
      const audio = catalog.find((c) => c.manifestUrl !== manifestUrl && (c.audioOnly || c.mediaPlaylist));
      if (!audio) return void (status.textContent = "no separate audio track found");
      start(audio.audioPlaylistUrl);
    };
    menu.append(muxItem);
  }

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
  // Single-stream playlists have one option - no quality picker worth showing.
  row.append(...(variants.length ? [picker] : []), fmt, split);
  status.textContent = variants.length
    ? `${variants.length} quality option${variants.length === 1 ? "" : "s"}`
    : "single playlist";
  return el;
}

// Hand the job to the background; reflect its progress here.
function startDownload({ playlistUrl, audioUrl, name, format, go, picker, status, bar }) {
  const fill = bar.firstElementChild;
  go.disabled = picker.disabled = true;
  bar.hidden = false;
  fill.style.width = "0%";
  status.textContent = "starting…";
  jobs.set(playlistUrl, (msg) => {
    if (msg.type === "status") return void (status.textContent = msg.text);
    if (msg.type === "progress") {
      const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
      fill.style.width = `${pct}%`;
      status.textContent = `${pct}% · ${(msg.bytes / 1e6).toFixed(1)} MB`;
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
  chrome.runtime.sendMessage({ type: "download", playlistUrl, audioUrl, name, format, referer: currentReferer });
}

async function duration(url) {
  try {
    const { text } = await fetchText(url);
    return parseDuration(text); // seconds; 0 for a live/empty playlist
  } catch {
    return null;
  }
}

const formatSize = (bytes) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;

function streamName(url) {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
    return decodeURIComponent(base).slice(0, 60);
  } catch {
    return "stream";
  }
}
