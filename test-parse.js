import assert from "node:assert";
import { parseMaster, parseDuration, formatTime } from "./parse.js";

const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.640028"
high/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=99
#EXT-X-ENDLIST`;

const v = parseMaster(master, "https://example.com/v/master.m3u8");
assert.equal(v.length, 2, "the trailing entry has no URI line and is dropped");
assert.equal(v[0].resolution, "1280x720", "sorted by bandwidth, highest first");
assert.equal(v[0].bandwidth, 2500000, "BANDWIDTH must not match AVERAGE-BANDWIDTH");
assert.equal(v[1].bandwidth, 800000);
assert.equal(v[1].codecs, "avc1.42c01e,mp4a.40.2", "quoted values keep their commas");
assert.equal(v[0].url, "https://example.com/v/high/index.m3u8", "relative URIs resolve");

const media = `#EXTM3U
#EXTINF:10.5,
seg0.ts
#EXTINF:9.5,
seg1.ts`;

assert.equal(parseDuration(media), 20);
assert.equal(formatTime(3794), "01:03:14");
assert.equal(formatTime(0), "00:00:00");

console.log("ok");

// --- parseSegments ---
import { parseSegments } from "./parse.js";

// Byterange form: one file, sliced. Second entry omits @offset, so it must
// continue from where the first ended.
const br = parseSegments(
  `#EXTM3U
#EXTINF:9.9,
#EXT-X-BYTERANGE:1000@0
main.ts
#EXTINF:9.9,
#EXT-X-BYTERANGE:500
main.ts`,
  "https://example.com/g1/prog.m3u8"
);
assert.equal(br.segments.length, 2);
assert.equal(br.segments[0].url, "https://example.com/g1/main.ts");
assert.deepEqual(br.segments[0].range, { offset: 0, length: 1000 });
assert.deepEqual(br.segments[1].range, { offset: 1000, length: 500 }, "implicit offset continues");

// Plain form: separate files, no ranges.
const plain = parseSegments(`#EXTM3U
#EXTINF:9.9,
seg0.ts
#EXTINF:9.9,
seg1.ts`, "https://example.com/v/p.m3u8");
assert.equal(plain.segments.length, 2);
assert.equal(plain.segments[0].range, null, "no byterange -> whole-file fetch");
assert.equal(plain.encrypted, false);

// fMP4: init segment is hoisted out, not treated as a media segment.
const fmp4 = parseSegments(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
0.m4s`, "https://example.com/v/p.m3u8");
assert.equal(fmp4.initUrl, "https://example.com/v/init.mp4");
assert.equal(fmp4.segments.length, 1, "the init segment is not a media segment");

// Encryption must be detected, not silently concatenated into garbage.
assert.equal(parseSegments(`#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\n0.ts`).encrypted, true);
assert.equal(parseSegments(`#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\n0.ts`).encrypted, false);

console.log("ok (segments)");
