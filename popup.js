document.addEventListener('DOMContentLoaded', () => {
  // ... (UI Element selection and other listeners remain the same) ...
  const globalToggle = document.getElementById('globalToggle');
  const globalStatus = document.getElementById('globalStatus');
  const uploadButton = document.getElementById('uploadButton');
  const harFileInput = document.getElementById('harFileInput');
  const fileList = document.getElementById('fileList');
  const endpointList = document.getElementById('endpointList');
  const endpointHeader = document.getElementById('endpointHeader');
  const endpointSearch = document.getElementById('endpointSearch');

  chrome.runtime.sendMessage({type: 'getGlobalState'}, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Could not get state:", chrome.runtime.lastError.message);
      return;
    }
    updateGlobalToggle(response.isReplayGloballyActive);
    updateFileListUI(response.files);
    updateEndpointListUI(response.endpoints);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'globalStateUpdate':
        updateGlobalToggle(message.isReplayGloballyActive);
        break;
      case 'fileListUpdate':
        updateFileListUI(message.files);
        updateEndpointListUI(message.endpoints);
        break;
    }
  });

  // --- (Event listeners for toggle, upload, search are unchanged) ---
  globalToggle.addEventListener('change', () => { /* ... */
  });
  uploadButton.addEventListener('click', () => { /* ... */
  });
  endpointSearch.addEventListener('input', (e) => { /* ... */
  });

  // --- (updateGlobalToggle is unchanged) ---
  function updateGlobalToggle(isActive) { /* ... */
  }

  // [MODIFIED] This function is rewritten for the new UI
  function updateFileListUI(files) {
    fileList.innerHTML = '';
    if (!files || files.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No HAR files loaded.';
      li.style.padding = '8px 12px';
      li.style.color = '#6c757d';
      fileList.appendChild(li);
      return;
    }
    files.forEach(fileInfo => {
      const li = document.createElement('li');
      li.className = 'file-item';

      const span = document.createElement('span');
      span.className = 'file-name';
      span.textContent = fileInfo.filename;
      span.title = fileInfo.filename; // Tooltip for long names

      const deleteButton = document.createElement('button');
      deleteButton.textContent = '🗑️';
      deleteButton.className = 'btn-danger';
      deleteButton.title = 'Delete this HAR';
      deleteButton.onclick = () => {
        if (confirm(`Are you sure you want to delete ${fileInfo.filename}?`)) {
          chrome.runtime.sendMessage({type: 'deleteHar', id: fileInfo.id});
        }
      };

      li.appendChild(span);
      li.appendChild(deleteButton);
      fileList.appendChild(li);
    });
  }

  // --- (updateEndpointListUI is unchanged) ---
  function updateEndpointListUI(endpoints) { /* ... */
  }

  // --- PASTE UNCHANGED FUNCTIONS HERE ---
  // (For brevity, please ensure the full code for unchanged functions is present)
  globalToggle.addEventListener('change', () => {
    chrome.runtime.sendMessage({type: 'toggleGlobalReplay', active: globalToggle.checked});
  });
  uploadButton.addEventListener('click', () => {
    if (harFileInput.files.length === 0) {
      alert('Please select HAR files.');
      return;
    }
    for (const file of harFileInput.files) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const harData = JSON.parse(e.target.result);
          chrome.runtime.sendMessage({type: 'loadHar', filename: file.name, data: harData});
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
    const items = document.querySelectorAll('#endpointList .endpoint-item');
    items.forEach(item => {
      const itemTerm = item.getAttribute('data-search-term') || '';
      item.style.display = itemTerm.includes(searchTerm) ? 'flex' : 'none';
    });
  });

  function updateGlobalToggle(isActive) {
    globalToggle.checked = isActive;
    globalStatus.textContent = `Replay is ${isActive ? 'ACTIVE' : 'INACTIVE'}`;
    globalStatus.style.color = isActive ? '#28a745' : '#dc3545';
  }

  function updateEndpointListUI(endpoints) {
    endpointList.innerHTML = '';
    endpointHeader.textContent = `Loaded Endpoints (${endpoints ? endpoints.length : 0})`;
    if (!endpoints || endpoints.length === 0) {
      endpointList.innerHTML = '<li style="padding: 8px 12px;">No endpoints loaded.</li>';
      return;
    }
    const methodColors = {GET: '#007bff', POST: '#28a745', PUT: '#ffc107', DELETE: '#dc3545', OTHERS: '#6c757d'};
    endpoints.forEach(ep => {
      const li = document.createElement('li');
      li.className = 'endpoint-item';
      li.setAttribute('data-search-term', `${ep.method.toLowerCase()} ${ep.path.toLowerCase()}`);
      const pathUrl = `http://localhost:3000${ep.path}`;
      li.innerHTML = `<span class="method" style="background-color: ${methodColors[ep.method] || methodColors.OTHERS};">${ep.method}</span><a class="path" href="${pathUrl}" target="_blank" title="Preview in new tab: ${pathUrl}">${ep.path}</a><span class="count">${ep.count}</span>`;
      endpointList.appendChild(li);
    });
  }

});
