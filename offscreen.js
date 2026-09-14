// Runs the download so it survives the popup/side panel closing. This context
// only has chrome.runtime, so: fetch + assemble here, but relay DNR host
// coverage and the final save to the service worker. Closes itself when idle.
import { parseSegments } from "./parse.js";
import { configure, fetchText, fetchSegment } from "./net.js";

let active = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "offscreen-download") run(msg);
});

async function run({ playlistUrl, name, referer }) {
  active++;
  configure(referer, 778, { relay: true }); // no DNR API here — relay to the SW
  try {
    await grab(playlistUrl, name, (done, total, bytes) =>
      report({ type: "progress", playlistUrl, done, total, bytes }));
    report({ type: "done", playlistUrl });
  } catch (e) {
    report({ type: "error", playlistUrl, message: e.message });
  } finally {
    if (--active === 0) window.close();
  }
}

// The popup may be closed — a message with no receiver rejects; ignore it.
const report = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

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
  const blobUrl = URL.createObjectURL(blob);
  // chrome.downloads isn't available here. The SW saves it and resolves only
  // once the download completes, so we keep the blob alive until then.
  const res = await chrome.runtime.sendMessage({
    type: "save",
    blobUrl,
    filename: `${name}.${initUrl ? "mp4" : "ts"}`,
  });
  URL.revokeObjectURL(blobUrl);
  if (res?.error) throw new Error(res.error);
}
