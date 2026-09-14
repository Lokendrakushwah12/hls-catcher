// Runs downloads so they survive the popup/side panel closing. Fetches segments
// here, then uses ffmpeg.wasm (loaded as a global by offscreen.html) to remux
// into a real container - .mp4/.m4a instead of raw .ts - and to mux a demuxed
// video+audio pair into one file. Closes itself when idle.
import { parseSegments } from "./parse.js";
import { configure, fetchText, fetchSegment } from "./net.js";

let active = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "offscreen-download") run(msg);
});

async function run({ playlistUrl, audioUrl, name, format, referer }) {
  active++;
  configure(referer, 778, { relay: true }); // no DNR API here - relay to the SW
  const progress = (done, total, bytes) => report({ type: "progress", playlistUrl, done, total, bytes });
  const status = (text) => report({ type: "status", playlistUrl, text });
  try {
    status("fetching video…");
    const video = await assembleTrack(playlistUrl, progress);
    let audio = null;
    if (audioUrl) {
      status("fetching audio…");
      audio = await assembleTrack(audioUrl, progress);
    }
    status("processing…");
    const { data, ext } = await process(video, audio, format, (p) => status(`processing… ${Math.round(p * 100)}%`));

    const blobUrl = URL.createObjectURL(new Blob([data], { type: MIME[ext] || "application/octet-stream" }));
    // chrome.downloads isn't available here - the SW saves and resolves once done.
    const res = await chrome.runtime.sendMessage({ type: "save", blobUrl, filename: `${name}.${ext}` });
    URL.revokeObjectURL(blobUrl);
    if (res?.error) throw new Error(res.error);
    report({ type: "done", playlistUrl });
  } catch (e) {
    report({ type: "error", playlistUrl, message: e.message });
  } finally {
    if (--active === 0) window.close();
  }
}

// The popup may be closed - a message with no receiver rejects; ignore it.
const report = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

const MIME = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", m4a: "audio/mp4" };

// Fetch every segment and concatenate into one buffer. Container is "mp4" for
// fMP4 (has an #EXT-X-MAP init segment) else "ts" - ffmpeg reads both.
async function assembleTrack(playlistUrl, onProgress) {
  const { text, resolvedUrl } = await fetchText(playlistUrl);
  const { segments, initUrl, encrypted } = parseSegments(text, resolvedUrl);
  if (encrypted) throw new Error("encrypted stream - not supported");
  if (!segments.length) throw new Error("no segments found");

  const parts = initUrl ? [new Uint8Array(await fetchSegment({ url: initUrl }))] : [];
  let bytes = 0;

  // ponytail: whole track buffered in memory, plus ffmpeg's copies. ~400 MB at
  // 1080p. Stream to disk via the File System Access API if you hit the wall.
  const BATCH = 6;
  for (let i = 0; i < segments.length; i += BATCH) {
    const chunk = await Promise.all(segments.slice(i, i + BATCH).map(fetchSegment));
    for (const b of chunk) {
      bytes += b.byteLength;
      parts.push(new Uint8Array(b));
    }
    onProgress(Math.min(i + BATCH, segments.length), segments.length, bytes);
  }
  return { data: concat(parts), container: initUrl ? "mp4" : "ts" };
}

// Remux (and optionally mux audio in) with `-c copy` - container change only,
// no re-encode, so it's fast and lossless. Picking a container incompatible
// with the stream's codec makes ffmpeg error, which surfaces in the card.
async function process(video, audio, format, onProgress) {
  const ff = await loadFfmpeg();
  onFfmpegProgress = onProgress;
  const inV = `v.${video.container}`;
  await ff.writeFile(inV, video.data);
  let inA;
  if (audio) {
    inA = `a.${audio.container}`;
    await ff.writeFile(inA, audio.data);
  }
  const build = (fmt) => {
    const fast = fmt === "mp4" ? ["-movflags", "+faststart"] : [];
    return audio
      ? ["-i", inV, "-i", inA, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", ...fast, `out.${fmt}`]
      : ["-i", inV, "-c", "copy", ...fast, `out.${fmt}`];
  };

  // Try the requested container; if the codec isn't valid in it, fall back to
  // MKV, which holds anything - so we never hand back an unplayable file.
  let ext = format;
  ffLog.length = 0;
  let code = await ff.exec(build(format));
  if (code !== 0 && format !== "mkv") {
    ext = "mkv";
    code = await ff.exec(build("mkv"));
  }
  if (code !== 0) {
    // Surface what ffmpeg saw in the inputs so we can tell audio-vs-video.
    const streams = ffLog.filter((l) => /Input #|Stream #\d:\d/.test(l)).map((l) => l.trim());
    const err = ffLog.filter((l) => /error|invalid|matches no/i.test(l)).slice(-1)[0] || "remux failed";
    throw new Error(`${err.trim()} - ${streams.join(" | ")}`.slice(0, 300));
  }

  const data = await ff.readFile(`out.${ext}`);
  onFfmpegProgress = null;
  return { data, ext };
}

let ffmpegPromise = null;
let onFfmpegProgress = null;
const ffLog = []; // recent ffmpeg log lines, for surfacing the real error
function loadFfmpeg() {
  return (ffmpegPromise ??= (async () => {
    const ff = new FFmpegWASM.FFmpeg();
    ff.on("progress", ({ progress }) => onFfmpegProgress?.(progress || 0));
    ff.on("log", ({ message }) => {
      ffLog.push(message);
      if (ffLog.length > 300) ffLog.shift();
    });
    await ff.load({
      coreURL: chrome.runtime.getURL("vendor/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("vendor/ffmpeg-core.wasm"),
    });
    return ff;
  })());
}

function concat(parts) {
  const size = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}
