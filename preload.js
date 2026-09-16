// preload.js - 安全桥接：通过 contextBridge 暴露受限 API 给渲染进程

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oncall', {
  // 读取设置 + 当前主题
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),

  // 标签文本
  setLabelText: (text) => ipcRenderer.invoke('label:setText', text),

  // 主题
  listThemes: () => ipcRenderer.invoke('themes:list'),
  applyTheme: (themeId) => ipcRenderer.invoke('theme:apply', themeId),
  getAllThemes: () => ipcRenderer.invoke('themes:get-all'),

  // 窗口操作
  dragBy: (dx, dy) => ipcRenderer.send('window:drag', dx, dy),
  resizeBy: (dw, dh, edges) => ipcRenderer.send('window:resize', dw, dh, edges),
  saveGeometry: () => ipcRenderer.send('window:save-geometry'),
  focusWindow: () => ipcRenderer.send('window:focus'),
  resetWindow: () => ipcRenderer.send('window:reset'),
  resetSize: () => ipcRenderer.send('window:reset-size'),
  quitApp: () => ipcRenderer.send('app:quit'),

  // 设置弹窗
  openSettings: () => ipcRenderer.send('settings:open'),
  closeSettings: () => ipcRenderer.send('settings:close'),

  // 开机自启动
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  setAutoStart: (enabled) => ipcRenderer.invoke('autostart:set', enabled),

  // 编辑（设置窗发起）
  startEdit: () => ipcRenderer.send('edit:start'),

  // 监听主进程事件
  onOpacityChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('opacity:changed', handler);
    return () => ipcRenderer.removeListener('opacity:changed', handler);
  },
  onThemeChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('theme:changed', handler);
    return () => ipcRenderer.removeListener('theme:changed', handler);
  },
  onEditStart: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('edit:start', handler);
    return () => ipcRenderer.removeListener('edit:start', handler);
  },
  onSettingsPatched: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('settings:patched', handler);
    return () => ipcRenderer.removeListener('settings:patched', handler);
  }
});
