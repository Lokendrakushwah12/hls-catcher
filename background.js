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
// the popup/side panel closes. The offscreen doc only has chrome.runtime, so
// the service worker owns the two APIs it lacks: declarativeNetRequest (referer
// spoofing) and downloads (saving the assembled blob).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "download") {
    startDownload(msg);
    return;
  }
  if (msg.type === "spoof") {
    spoofHost(msg.host, msg.referer).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (msg.type === "save") {
    saveBlob(msg.blobUrl, msg.filename, sendResponse);
    return true; // response is deferred until the download completes
  }
});

async function startDownload({ playlistUrl, audioUrl, name, format, referer }) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Assemble, remux and save HLS video segments in the background.",
    });
  }
  chrome.runtime.sendMessage({ type: "offscreen-download", playlistUrl, audioUrl, name, format, referer });
}

// DNR rule 778 covers the offscreen doc's fetches. Merge into the existing rule
// (read it back) so a service-worker restart mid-download can't drop hosts.
async function spoofHost(host, referer) {
  const current = (await chrome.declarativeNetRequest.getSessionRules()).find((r) => r.id === 778);
  const hosts = new Set(current?.condition.requestDomains || []);
  hosts.add(host);
  const ref = referer || `https://${host}/`;
  const origin = new URL(ref).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [778],
    addRules: [{
      id: 778,
      priority: 1,
      condition: { requestDomains: [...hosts], resourceTypes: ["xmlhttprequest"] },
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "referer", operation: "set", value: ref },
          { header: "origin", operation: "set", value: origin },
        ],
      },
    }],
  });
}

// Save the offscreen's blob URL, and only respond once the download finishes -
// that keeps the offscreen doc (and its blob) alive until Chrome has the bytes.
function saveBlob(blobUrl, filename, sendResponse) {
  chrome.downloads
    .download({ url: blobUrl, filename })
    .then((id) => {
      const onChanged = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === "complete" || delta.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(onChanged);
          sendResponse(delta.state.current === "complete" ? { ok: true } : { error: "download interrupted" });
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    })
    .catch((e) => sendResponse({ error: e.message }));
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
