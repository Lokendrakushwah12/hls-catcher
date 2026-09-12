// HLS playlists are plain text. This is the whole data model behind a
// download-helper's quality dropdown and duration label.

// Master playlist -> variant streams, highest bandwidth first.
export function parseMaster(text, baseUrl) {
  const lines = text.split("\n").map((l) => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const uri = lines[i + 1];
    if (!uri || uri.startsWith("#")) continue; // malformed entry, skip
    const attrs = lines[i].slice("#EXT-X-STREAM-INF:".length);
    out.push({
      resolution: attr(attrs, "RESOLUTION") || "unknown",
      bandwidth: Number(attr(attrs, "BANDWIDTH")) || 0,
      codecs: attr(attrs, "CODECS") || "",
      url: baseUrl ? new URL(uri, baseUrl).href : uri,
    });
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth);
}

// Media playlist -> total seconds, by summing segment durations.
export function parseDuration(text) {
  let total = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("#EXTINF:")) total += parseFloat(line.slice(8)) || 0;
  }
  return total;
}

export function formatTime(seconds) {
  const s = Math.round(seconds);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

// Attribute values are either "quoted" (may contain commas) or bare up to the
// next comma. The (?:^|,) anchor stops BANDWIDTH matching AVERAGE-BANDWIDTH.
function attr(s, name) {
  const m = s.match(new RegExp(`(?:^|,)${name}=("([^"]*)"|[^,]*)`));
  return m ? m[2] ?? m[1] : null;
}

// Media playlist -> the segments to fetch, in order.
// Handles three wrinkles real playlists have:
//   #EXT-X-BYTERANGE  segments are ranges of ONE file, not separate files
//   #EXT-X-MAP        fMP4 init segment that must lead the output
//   #EXT-X-KEY        encrypted; raw concatenation would produce garbage
export function parseSegments(text, baseUrl) {
  const segments = [];
  let range = null;
  let prevEnd = 0;
  let initUrl = null;
  let encrypted = false;

  for (const line of text.split("\n").map((l) => l.trim())) {
    if (line.startsWith("#EXT-X-KEY:")) {
      if (!/METHOD=NONE/.test(line)) encrypted = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const m = line.match(/URI="([^"]*)"/);
      if (m) initUrl = baseUrl ? new URL(m[1], baseUrl).href : m[1];
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const [len, off] = line.slice("#EXT-X-BYTERANGE:".length).split("@");
      const length = Number(len);
      // A missing @offset means "continues where the last range ended".
      const offset = off === undefined ? prevEnd : Number(off);
      range = { offset, length };
      prevEnd = offset + length;
    } else if (line && !line.startsWith("#")) {
      segments.push({ url: baseUrl ? new URL(line, baseUrl).href : line, range });
      range = null;
    }
  }
  return { segments, initUrl, encrypted };
}
