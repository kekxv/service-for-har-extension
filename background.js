// --- Global State ---
let isReplayGloballyActive = false;
let harDataMap = new Map();
let loadedHars = []; // Array of { id, filename }
const debugTargets = new Set();
const debuggerVersion = "1.3";
const loadingUrl = chrome.runtime.getURL('loading.html');

// State for the redirect-on-navigate interception trick
const pendingNavigations = new Map();
const navigationLock = new Set();


// --- State Management & HAR Processing ---

/**
 * Loads the initial state from chrome.storage.local when the extension starts.
 */
async function loadInitialState() {
  const result = await chrome.storage.local.get(['isReplayGloballyActive', 'loadedHarsInfo']);
  isReplayGloballyActive = result.isReplayGloballyActive || false;
  loadedHars = result.loadedHarsInfo || [];
  await rebuildHarDataMap();
  await updateIcon();
  if (isReplayGloballyActive) {
    await attachToAllValidTabs();
  }
}

/**
 * Saves the array of loaded HAR file info to storage.
 * The actual HAR data is saved/deleted separately to avoid overwriting.
 */
async function saveState() {
  await chrome.storage.local.set({
    loadedHarsInfo: loadedHars.map(h => ({id: h.id, filename: h.filename}))
  });
}

/**
 * Clears and rebuilds the in-memory harDataMap from all HAR data stored in chrome.storage.
 */
async function rebuildHarDataMap() {
  harDataMap.clear();
  const dataResult = await chrome.storage.local.get('loadedHarsData');
  const allHarData = dataResult.loadedHarsData || {};

  for (const harInfo of loadedHars) {
    const harJson = allHarData[harInfo.id];
    if (!harJson || !harJson.log || !harJson.log.entries) continue;

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
        console.warn(`Skipping invalid entry in ${harInfo.filename}:`, e.message);
      }
    }
  }
}

/**
 * Creates a flat list of loaded endpoints for the popup UI.
 */
function getEndpointListData() {
  const endpoints = [];
  for (const [method, pathMap] of harDataMap.entries()) {
    for (const [path, state] of pathMap.entries()) {
      endpoints.push({method, path, count: state.entries.length});
    }
  }
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return endpoints;
}


// --- Global Control & Debugger Logic ---

/**
 * Turns the global replay functionality on or off.
 */
async function toggleGlobalReplay(active) {
  isReplayGloballyActive = active;
  await chrome.storage.local.set({isReplayGloballyActive: active});
  await updateIcon();
  if (active) {
    await attachToAllValidTabs();
  } else {
    await detachFromAllTabs();
  }
  chrome.runtime.sendMessage({type: 'globalStateUpdate', isReplayGloballyActive});
}

/**
 * Updates the browser action icon to reflect the current state (on/off).
 */
async function updateIcon() {
  const iconPath = isReplayGloballyActive ? 'icon_on.png' : 'icon_off.png';
  await chrome.action.setIcon({path: iconPath});
}

/**
 * Iterates through all open tabs and attaches the debugger to valid ones.
 */
async function attachToAllValidTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    await attachDebugger(tab.id);
  }
}

/**
 * Detaches the debugger from all currently attached tabs.
 */
async function detachFromAllTabs() {
  for (const tabId of Array.from(debugTargets)) {
    await detachDebugger(tabId);
  }
}

/**
 * Checks if a URL is valid for debugging.
 */
function isValidUrl(url) {
  return url && !url.startsWith('chrome://') && !url.startsWith('devtools://') && !url.startsWith('chrome-extension://');
}

/**
 * Attaches the debugger to a specific tab ID.
 */
async function attachDebugger(tabId) {
  if (debugTargets.has(tabId)) return;
  try {
    await chrome.debugger.attach({tabId}, debuggerVersion);
    await chrome.debugger.sendCommand({tabId}, "Fetch.enable", {patterns: [{urlPattern: "*"}]});
    debugTargets.add(tabId);
  } catch (e) {
    console.warn(`Failed to attach debugger to tab ${tabId}: ${e.message}`);
    // If attach fails during the redirect, we must clean up and redirect back.
    const originalUrl = pendingNavigations.get(tabId);
    if (originalUrl) {
      pendingNavigations.delete(tabId);
      navigationLock.delete(tabId); // Make sure lock is also released
      await chrome.tabs.update(tabId, {url: originalUrl});
    }
  }
}

/**
 * Detaches the debugger from a specific tab ID.
 */
async function detachDebugger(tabId) {
  if (!debugTargets.has(tabId)) return;
  try {
    await chrome.debugger.detach({tabId});
  } catch (e) {
    console.warn(`Failed to detach debugger from tab ${tabId}: ${e.message}`);
  } finally {
    debugTargets.delete(tabId);
  }
}


// --- Event Listeners ---

chrome.runtime.onInstalled.addListener(loadInitialState);
chrome.runtime.onStartup.addListener(loadInitialState);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'getGlobalState':
        sendResponse({
          isReplayGloballyActive,
          files: loadedHars,
          endpoints: getEndpointListData()
        });
        break;
      case 'toggleGlobalReplay':
        await toggleGlobalReplay(message.active);
        break;
      case 'loadHar':
        const newHar = {id: `har_${Date.now()}_${Math.random()}`, filename: message.filename};
        loadedHars.push(newHar);
        const dataResult = await chrome.storage.local.get('loadedHarsData');
        const allHarData = dataResult.loadedHarsData || {};
        allHarData[newHar.id] = message.data;
        await chrome.storage.local.set({loadedHarsData: allHarData});
        await saveState();
        await rebuildHarDataMap();
        chrome.runtime.sendMessage({type: 'fileListUpdate', files: loadedHars, endpoints: getEndpointListData()});
        break;
      case 'deleteHar':
        loadedHars = loadedHars.filter(h => h.id !== message.id);
        const deleteDataResult = await chrome.storage.local.get('loadedHarsData');
        const allDeleteData = deleteDataResult.loadedHarsData || {};
        delete allDeleteData[message.id];
        await chrome.storage.local.set({loadedHarsData: allDeleteData});
        await saveState();
        await rebuildHarDataMap();
        chrome.runtime.sendMessage({type: 'fileListUpdate', files: loadedHars, endpoints: getEndpointListData()});
        break;
    }
  })();
  return true; // Indicates async response
});


// --- Redirect Interception Listeners ---

// 1. Catches navigation attempts before any request is made.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // If this tab is locked, it means we are programmatically redirecting it back. Do nothing.
  if (navigationLock.has(details.tabId)) {
    return;
  }
  // If replay is active, this is a top-level navigation, and the URL is valid...
  if (isReplayGloballyActive && details.frameId === 0 && isValidUrl(details.url) && details.url !== loadingUrl) {
    // ...and we are not already processing this tab...
    if (pendingNavigations.has(details.tabId)) {
      return;
    }
    // ...then save the target URL and redirect to our loading page.
    pendingNavigations.set(details.tabId, details.url);
    chrome.tabs.update(details.tabId, {url: loadingUrl});
    attachDebugger(details.tabId);
  }
});

// 2. Catches when our loading page has finished loading.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url === loadingUrl) {
    const originalUrl = pendingNavigations.get(tabId);
    if (originalUrl) {
      pendingNavigations.delete(tabId);
      // LOCK the tab to prevent onBeforeNavigate from re-intercepting.
      navigationLock.add(tabId);
      await chrome.tabs.update(tabId, {url: originalUrl});
    }
  }
});

// 3. Catches when the *final* navigation is complete to release the lock.
chrome.webNavigation.onCompleted.addListener((details) => {
  if (navigationLock.has(details.tabId)) {
    // UNLOCK the tab so future navigations by the user can be intercepted.
    navigationLock.delete(details.tabId);
  }
});

// 4. Cleans up all state if a tab is closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  pendingNavigations.delete(tabId);
  navigationLock.delete(tabId);
  detachDebugger(tabId);
});


// --- Core Replay Logic ---

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== 'Fetch.requestPaused') return;
  const {requestId, request} = params;
  const tabId = source.tabId;
  try {
    const urlObject = new URL(request.url);
    // Special handling for localhost previews, which might have a different hostname but same path.
    const path = (urlObject.hostname === 'localhost' && urlObject.port === '3000')
      ? urlObject.pathname
      : new URL(request.url).pathname;

    const methodUpper = request.method.toUpperCase();
    const replayState = harDataMap.get(methodUpper)?.get(path);

    if (!replayState || replayState.entries.length === 0) {
      await chrome.debugger.sendCommand({tabId}, "Fetch.continueRequest", {requestId});
      return;
    }

    const {entries, currentIndex} = replayState;
    const entry = entries[currentIndex];
    // Cycle to the next response for the next time this endpoint is called.
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
      // Attempt to continue the request to prevent the page from hanging.
      await chrome.debugger.sendCommand({tabId}, "Fetch.continueRequest", {requestId});
    } catch (continueError) { /* ignore */
    }
  }
});
