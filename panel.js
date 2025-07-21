document.addEventListener('DOMContentLoaded', () => {
  // UI Elements
  const toggleReplay = document.getElementById('toggleReplay');
  const replayStatus = document.getElementById('replayStatus');
  // [NEW]
  const replayDescription = document.getElementById('replayDescription');
  // ... other elements
  const uploadButton = document.getElementById('uploadButton');
  const harFileInput = document.getElementById('harFileInput');
  const fileList = document.getElementById('fileList');
  const endpointList = document.getElementById('endpointList');
  const endpointHeader = document.getElementById('endpointHeader');
  const endpointSearch = document.getElementById('endpointSearch');

  let backgroundPort;

  function setupPort() {
    if (backgroundPort) {
      backgroundPort.onDisconnect.removeListener(handleDisconnect);
      backgroundPort.disconnect();
    }
    backgroundPort = chrome.runtime.connect({name: 'devtools-panel'});
    backgroundPort.onMessage.addListener(handleMessage);
    backgroundPort.onDisconnect.addListener(handleDisconnect);
    backgroundPort.postMessage({
      type: 'init',
      tabId: chrome.devtools.inspectedWindow.tabId
    });
  }

  function handleDisconnect() {
    backgroundPort = null;
    console.log("Background port disconnected. It will reconnect on the next action.");
  }

  // [MODIFIED] The main message handler
  function handleMessage(message) {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'statusUpdate':
        updateReplayControl(message.replayActive, message.canDebug);
        break;
      case 'fileListUpdate':
        updateFileListUI(message.files);
        break;
      case 'endpointListUpdate':
        updateEndpointListUI(message.endpoints);
        break;
      // [REMOVED] The alert for the 'error' message type is gone.
      // You can add a more gentle notification here if desired.
    }
  }

  // [NEW] A dedicated function to update the entire replay control section
  function updateReplayControl(isActive, canDebug) {
    toggleReplay.checked = isActive && canDebug;
    toggleReplay.disabled = !canDebug;
    replayStatus.textContent = `Replay is ${isActive && canDebug ? 'ACTIVE' : 'INACTIVE'}`;
    replayStatus.style.color = isActive && canDebug ? 'green' : 'red';

    if (canDebug) {
      replayDescription.textContent = 'Enable to start intercepting requests for this tab.';
    } else {
      replayDescription.textContent = 'Replay is not available on this page (e.g., internal Chrome pages or other extensions).';
    }
  }

  function sendMessageToBackground(message) {
    // ... (This function remains unchanged)
    try {
      if (!backgroundPort) {
        setupPort();
      }
      backgroundPort.postMessage(message);
    } catch (error) {
      console.error("Failed to send message, retrying.", error);
      setupPort();
      backgroundPort.postMessage(message);
    }
  }

  // Initial setup
  setupPort();

  // Event Listeners (all are unchanged)
  toggleReplay.addEventListener('change', () => { /* ... */
  });
  uploadButton.addEventListener('click', () => { /* ... */
  });
  endpointSearch.addEventListener('input', (e) => { /* ... */
  });

  // UI Rendering Functions (all are unchanged)
  function updateFileListUI(files) { /* ... */
  }

  function updateEndpointListUI(endpoints) { /* ... */
  }

  // --- Keep the unchanged functions for brevity ---
  toggleReplay.addEventListener('change', () => {
    sendMessageToBackground({
      type: 'toggleReplay',
      active: toggleReplay.checked,
      tabId: chrome.devtools.inspectedWindow.tabId
    });
  });
  uploadButton.addEventListener('click', () => {
    if (harFileInput.files.length === 0) {
      return;
    }
    for (const file of harFileInput.files) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const harData = JSON.parse(e.target.result);
          sendMessageToBackground({type: 'loadHar', filename: file.name, data: harData});
        } catch (err) {
          alert(`Error parsing ${file.name}: ${err.message}`);
        }
      };
      reader.readAsText(file);
    }
    harFileInput.value = '';
  });
  endpointSearch.addEventListener('input', (e) => {
    const searchTerm = e.target.value.toLowerCase().trim();
    const items = document.querySelectorAll('.endpoint-item');
    items.forEach(item => {
      const itemTerm = item.getAttribute('data-search-term') || '';
      item.style.display = itemTerm.includes(searchTerm) ? 'flex' : 'none';
    });
  });

  function updateFileListUI(files) {
    fileList.innerHTML = '';
    if (!files || files.length === 0) {
      fileList.innerHTML = '<li>No HAR files loaded.</li>';
      return;
    }
    files.forEach(fileInfo => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = fileInfo.filename;
      li.appendChild(span);
      const deleteButton = document.createElement('button');
      deleteButton.textContent = '🗑️';
      deleteButton.className = 'delete';
      deleteButton.title = 'Delete this HAR';
      deleteButton.onclick = () => {
        if (confirm(`Are you sure you want to delete ${fileInfo.filename}?`)) {
          sendMessageToBackground({type: 'deleteHar', id: fileInfo.id});
        }
      };
      li.appendChild(deleteButton);
      fileList.appendChild(li);
    });
  }

  function updateEndpointListUI(endpoints) {
    endpointList.innerHTML = '';
    endpointHeader.textContent = `Loaded Endpoints (${endpoints ? endpoints.length : 0})`;
    if (!endpoints || endpoints.length === 0) {
      endpointList.innerHTML = '<li>No endpoints loaded from HAR files.</li>';
      return;
    }
    endpoints.forEach(ep => {
      const li = document.createElement('li');
      li.className = 'endpoint-item';
      li.setAttribute('data-search-term', `${ep.method.toLowerCase()} ${ep.path.toLowerCase()}`);
      const methodBadge = document.createElement('span');
      methodBadge.className = `method-badge method-${ep.method.toLowerCase()}`;
      methodBadge.textContent = ep.method;
      const pathSpan = document.createElement('span');
      pathSpan.className = 'endpoint-path';
      pathSpan.textContent = ep.path;
      pathSpan.title = ep.path;
      const countBadge = document.createElement('span');
      countBadge.className = 'count-badge';
      countBadge.textContent = `${ep.currentIndex + 1} / ${ep.count}`;
      countBadge.title = `This endpoint has ${ep.count} possible responses.`;
      li.appendChild(methodBadge);
      li.appendChild(pathSpan);
      li.appendChild(countBadge);
      endpointList.appendChild(li);
    });
  }

});
