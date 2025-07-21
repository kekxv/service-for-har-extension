// --- 全局状态 ---
let harDataMap = new Map();
let loadedHars = []; // { id, filename }
let activeTabs = new Map(); // tabId -> port
const debugTargets = new Set();
const debuggerVersion = "1.3";

// --- 存储与状态管理 ---
async function saveState() {
  const dataResult = await chrome.storage.local.get('loadedHarsData');
  const allHarData = dataResult.loadedHarsData || {};

  const updatedHarsData = {};
  loadedHars.forEach(harInfo => {
    if (allHarData[harInfo.id]) {
      updatedHarsData[harInfo.id] = allHarData[harInfo.id];
    }
  });

  await chrome.storage.local.set({
    loadedHarsInfo: loadedHars.map(h => ({id: h.id, filename: h.filename})),
    loadedHarsData: updatedHarsData
  });
}

async function loadState() {
  const result = await chrome.storage.local.get(['loadedHarsInfo', 'loadedHarsData']);
  loadedHars = result.loadedHarsInfo || [];
  await rebuildHarDataMap();
  console.log("Initial state loaded from storage.");
}

async function rebuildHarDataMap() {
  harDataMap.clear();
  const dataResult = await chrome.storage.local.get('loadedHarsData');
  const allHarData = dataResult.loadedHarsData || {};

  for (const harInfo of loadedHars) {
    const harJson = allHarData[harInfo.id];
    if (!harJson) continue;
    if (!harJson.log || !harJson.log.entries) continue;

    for (const entry of harJson.log.entries) {
      if (!entry?.request?.url || !entry.response) continue;
      try {
        const method = entry.request.method.toUpperCase();
        const urlObject = new URL(entry.request.url, "http://dummy.base");
        const urlPath = urlObject.pathname;
        const pathMap = harDataMap.get(method) || new Map();
        if (!harDataMap.has(method)) harDataMap.set(method, pathMap);
        const state = pathMap.get(urlPath) || {entries: [], currentIndex: 0};
        if (!pathMap.has(urlPath)) pathMap.set(urlPath, state);
        state.entries.push(entry);
      } catch (e) {
        console.warn(`Skipping invalid entry in ${harInfo.filename}:`, entry.request.url, e.message);
      }
    }
  }
}

function getEndpointListData() {
  const endpoints = [];
  for (const [method, pathMap] of harDataMap.entries()) {
    for (const [path, state] of pathMap.entries()) {
      endpoints.push({method, path, count: state.entries.length, currentIndex: state.currentIndex});
    }
  }
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return endpoints;
}

function broadcastUpdate() {
  const endpoints = getEndpointListData();
  const fileInfo = loadedHars.map(h => ({id: h.id, filename: h.filename}));
  for (const port of activeTabs.values()) {
    port.postMessage({type: 'fileListUpdate', files: fileInfo});
    port.postMessage({type: 'endpointListUpdate', endpoints: endpoints});
  }
}

// 插件启动时加载状态
loadState();

// --- 调试器和请求拦截逻辑 --- (此部分无改动)
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== 'Fetch.requestPaused') return;
  const {requestId, request} = params;
  const tabId = source.tabId;
  try {
    const urlObject = new URL(request.url);
    const methodUpper = request.method.toUpperCase();
    const replayState = harDataMap.get(methodUpper)?.get(urlObject.pathname);
    if (!replayState || replayState.entries.length === 0) {
      await chrome.debugger.sendCommand({tabId}, "Fetch.continueRequest", {requestId});
      return;
    }
    const {entries, currentIndex} = replayState;
    const entry = entries[currentIndex];
    replayState.currentIndex = (currentIndex + 1) % entries.length;
    const response = entry.response;
    const headers = response.headers
      .filter(h => !['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(h.name.toLowerCase()))
      .map(h => ({name: h.name, value: h.value}));
    let body = '';
    if (response.content?.text) {
      body = response.content.encoding === 'base64' ? response.content.text : btoa(unescape(encodeURIComponent(response.content.text)));
    }
    await chrome.debugger.sendCommand({tabId}, "Fetch.fulfillRequest", {
      requestId,
      responseCode: response.status,
      responseHeaders: headers,
      body: body
    });
  } catch (e) {
    console.error("Error during replay:", e);
    try {
      await chrome.debugger.sendCommand({tabId}, "Fetch.continueRequest", {requestId});
    } catch (continueError) {
      console.error("Failed to continue original request after error:", continueError);
    }
  }
});

// --- 与 DevTools 面板通信 ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'devtools-panel') return;
  let tabId;

  const messageHandler = async (message) => {
    tabId = message.tabId || tabId;
    if (!tabId) return;

    switch (message.type) {
      case 'init':
        activeTabs.set(tabId, port);
        let canDebug = false;
        try {
          const tab = await chrome.tabs.get(tabId);
          // [MODIFIED] Check if the URL is debuggable
          if (tab && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('devtools://') && !tab.url.startsWith('chrome-extension://')) {
            canDebug = true;
          }
        } catch (e) {
          console.warn(`Could not get tab info for tabId ${tabId}`, e);
        }

        // [MODIFIED] Send the 'canDebug' flag along with the status
        port.postMessage({
          type: 'statusUpdate',
          replayActive: debugTargets.has(tabId),
          canDebug: canDebug
        });
        port.postMessage({
          type: 'fileListUpdate',
          files: loadedHars.map(h => ({id: h.id, filename: h.filename}))
        });
        port.postMessage({
          type: 'endpointListUpdate',
          endpoints: getEndpointListData()
        });
        break;

      case 'toggleReplay':
        // The safety check here is now a fallback, the UI should prevent this call.
        const currentTab = await chrome.tabs.get(tabId);
        if (!currentTab.url || currentTab.url.startsWith('chrome://') || currentTab.url.startsWith('devtools://') || currentTab.url.startsWith('chrome-extension://')) {
          // Fails silently, the UI is already disabled.
          console.warn("Attempted to toggle replay on a non-debuggable page. Ignored.");
          port.postMessage({type: 'statusUpdate', replayActive: false, canDebug: false});
          return;
        }

        if (message.active) {
          try {
            await chrome.debugger.attach({tabId}, debuggerVersion);
            await chrome.debugger.sendCommand({tabId}, "Fetch.enable", {patterns: [{urlPattern: "*"}]});
            debugTargets.add(tabId);
          } catch (e) {
            port.postMessage({type: 'statusUpdate', replayActive: false, canDebug: true});
            return;
          }
        } else {
          if (debugTargets.has(tabId)) {
            await chrome.debugger.detach({tabId});
            debugTargets.delete(tabId);
          }
        }
        port.postMessage({type: 'statusUpdate', replayActive: debugTargets.has(tabId), canDebug: true});
        break;
      case 'loadHar':
        // ... (此 case 无改动)
        const newHar = { id: `har_${Date.now()}_${Math.random()}`, filename: message.filename };
        loadedHars.push(newHar);
        const dataResult = await chrome.storage.local.get('loadedHarsData');
        const allHarData = dataResult.loadedHarsData || {};
        allHarData[newHar.id] = message.data;
        await chrome.storage.local.set({ loadedHarsData: allHarData });
        await saveState();
        await rebuildHarDataMap();
        broadcastUpdate(); // 广播给所有面板
        break;
      case 'deleteHar':
        // ... (此 case 无改动)
        loadedHars = loadedHars.filter(h => h.id !== message.id);
        await saveState();
        await rebuildHarDataMap();
        broadcastUpdate(); // 广播给所有面板
        break;
    }
  };
  port.onMessage.addListener(messageHandler);
  port.onDisconnect.addListener(async () => {
    if (tabId && debugTargets.has(tabId)) {
      await chrome.debugger.detach({ tabId });
      debugTargets.delete(tabId);
    }
    activeTabs.delete(tabId);
    port.onMessage.removeListener(messageHandler);
  });
});
