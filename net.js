// Shared by the popup (reading manifests) and the offscreen doc (downloading).
// Fetch from the extension - host_permissions means no CORS wall - while a DNR
// rule rewrites Referer/Origin to the player's, to pass CDN hotlink checks.
// Popup and offscreen run in separate contexts, so each owns a distinct rule id.
let pageReferer = null;
let ruleId = 777;
const spoofedHosts = new Set();

export function configure(referer, id = 777) {
  pageReferer = referer || null;
  ruleId = id;
}

export async function fetchText(url, options) {
  return fetchVia(url, "text", options);
}

export async function fetchSegment({ url, range }) {
  const opts = range
    ? { headers: { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }
    : undefined;
  const { bytes } = await fetchVia(url, "bytes", opts);
  return bytes.buffer;
}

async function fetchVia(url, responseType, options) {
  await spoofReferer(url);
  const r = await fetch(url, { credentials: "include", cache: "no-store", ...options });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (responseType === "text") return { text: await r.text(), resolvedUrl: r.url || url };
  const buf = await r.arrayBuffer();
  return { bytes: new Uint8Array(buf), resolvedUrl: r.url || url };
}

// The DNR rule's domain list grows to cover every host we touch (master,
// variant, segment). Referer = the player's; fall back to the target's own
// origin (its own domain is almost always allowlisted), never the page.
async function spoofReferer(url) {
  const host = new URL(url).hostname;
  if (spoofedHosts.has(host)) return;
  spoofedHosts.add(host);
  const referer = pageReferer || new URL(url).origin + "/";
  const origin = new URL(referer).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      condition: { requestDomains: [...spoofedHosts], resourceTypes: ["xmlhttprequest"] },
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "referer", operation: "set", value: referer },
          // ponytail: drop this Origin line if a CDN 403s on it - Referer is
          // the usual hotlink signal, Origin only matters for stricter ones.
          { header: "origin", operation: "set", value: origin },
        ],
      },
    }],
  });
}
