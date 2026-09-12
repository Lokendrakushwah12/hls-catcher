// Observational webRequest: MV3 dropped the *blocking* version, but a plain
// listener still sees every request the page makes, before the popup opens.
const MANIFEST = /\.(m3u8|mpd)(\?|$)/i;
const key = (tabId) => `tab${tabId}`;

chrome.webRequest.onBeforeRequest.addListener(
  async ({ requestId, url, tabId }) => {
    if (tabId < 0 || !MANIFEST.test(url)) return;
    const k = key(tabId);
    let filter;
    let chunks = [];
    const decoder = new TextDecoder();

    try {
      filter = chrome.webRequest.filterResponseData(requestId);

      filter.ondata = (event) => {
        chunks.push(new Uint8Array(event.data));
        filter.write(event.data);
      };

      filter.onstop = async () => {
        try {
          const text = decoder.decode(concatUint8(chunks));
          const { [k]: current = [] } = await chrome.storage.session.get(k);
          const updated = (() => {
            const existing = current.find((item) => item.url === url);
            if (existing) {
              return current.map((item) => (item.url === url ? { ...item, body: text } : item));
            }
            return [...current, { id: requestId, url, body: text }];
          })();
          await chrome.storage.session.set({ [k]: updated });
          chrome.action.setBadgeText({ tabId, text: String(updated.length) });
        } finally {
          filter.disconnect();
        }
      };
    } catch {
      // If response filtering is unavailable for this request, keep the URL only.
    }

    const { [k]: found = [] } = await chrome.storage.session.get(k);
    if (!found.some((entry) => entry.url === url)) {
      found.push({ id: requestId, url, body: null });
      await chrome.storage.session.set({ [k]: found });
      chrome.action.setBadgeText({ tabId, text: String(found.length) });
    }
  },
  { urls: ["<all_urls>"] }
);

// Capture the real Referer the player sent, so the popup can replay it and get
// past the CDN's hotlink check. Referer is an "extraHeaders" header in Chrome.
chrome.webRequest.onBeforeSendHeaders.addListener(
  ({ url, tabId, requestHeaders }) => {
    if (tabId < 0 || !MANIFEST.test(url)) return;
    const ref = requestHeaders.find((h) => h.name.toLowerCase() === "referer");
    if (ref?.value) chrome.storage.session.set({ [`ref${tabId}`]: ref.value });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// Service workers get killed after ~30s idle, so the list lives in
// storage.session rather than a module-scoped Map.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading" || !info.url) return;
  chrome.storage.session.remove([key(tabId), `ref${tabId}`]);
  chrome.action.setBadgeText({ tabId, text: "" });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(key(tabId));
});

// The popup hands downloads to an offscreen document so they keep running after
// the popup/side panel closes (service workers can't create blob URLs).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "download") startDownload(msg);
});

async function startDownload({ playlistUrl, name, referer }) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Assemble and save HLS video segments in the background.",
    });
  }
  chrome.runtime.sendMessage({ type: "offscreen-download", playlistUrl, name, referer });
}

function concatUint8(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
