chrome.devtools.panels.create(
  "HAR Replay",           // 面板标题
  "icon128.png",         // 面板图标
  "panel.html",           // 面板内容的 HTML 文件
  (panel) => {
    // 面板创建时的回调
    console.log("HAR Replay panel created.");
  }
);
