// main.js - Electron 主进程：悬浮标签主控
// 功能：透明置顶窗口、根据前台窗口自动调整不透明度、设置与主题持久化

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ====== Win32 API（koffi 调用，用于检测前台窗口） ======
let user32 = null;
let GetForegroundWindow = null;
let GetWindowTextW = null;
let GetClassNameW = null;
let GetWindowThreadProcessId = null;

function loadUser32() {
  try {
    const koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    GetForegroundWindow = user32.func('void *GetForegroundWindow()');
    GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)');
    GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hWnd, uint16_t *lpClassName, int nMaxCount)');
    GetWindowThreadProcessId = user32.func('unsigned long __stdcall GetWindowThreadProcessId(void *hWnd, unsigned long *lpdwProcessId)');
    return true;
  } catch (err) {
    console.error('[OnCallLabel] 加载 user32.dll 失败:', err);
    return false;
  }
}

// 获取前台窗口信息：返回 { hwnd, title, className, pid } 或 null
function getForegroundInfo() {
  if (!GetForegroundWindow) return null;
  try {
    const hwnd = GetForegroundWindow();
    if (!hwnd) {
      // 没有前台窗口（罕见，几乎不会发生）—— 视为桌面
      return { hwnd: null, title: '', className: '', pid: 0, isDesktop: true };
    }
    const titleBuf = Buffer.alloc(2048);
    const classBuf = Buffer.alloc(2048);
    GetWindowTextW(hwnd, titleBuf, 1024);
    GetClassNameW(hwnd, classBuf, 1024);
    const title = titleBuf.toString('utf16le').replace(/\u0000+$/, '');
    const className = classBuf.toString('utf16le').replace(/\u0000+$/, '');
    // 取 pid
    let pid = 0;
    const pidPtr = Buffer.alloc(4);
    try {
      GetWindowThreadProcessId(hwnd, pidPtr);
      pid = pidPtr.readUInt32LE(0);
    } catch (_) {}
    // 判定桌面/外壳：类名是 Progman / WorkerW（桌面）或 Shell_TrayWnd（任务栏）
    const isShellClass = (className === 'Progman' || className === 'WorkerW' || className === 'Shell_TrayWnd');
    const isDesktop = isShellClass || (title === '' && className === '');
    return { hwnd, title, className, pid, isDesktop };
  } catch (err) {
    console.error('[OnCallLabel] getForegroundInfo 异常:', err);
    return null;
  }
}

// ====== 应用数据目录与设置 ======
const userDataDir = app.getPath('userData');
const settingsPath = path.join(userDataDir, 'settings.json');
const themesDir = path.join(__dirname, 'themes');
const userThemesPath = path.join(userDataDir, 'themes.json');

const defaultSettings = {
  labelText: '随时标签',
  theme: 'dark',
  position: null,  // { x, y } —— null 表示首次居中
  size: { width: 240, height: 88 },
  opacity: { active: 1.0, inactive: 0.35 },
  fontSize: 18,
  bold: true,
  italic: false,
  textAlign: 'center',  // 'left' | 'center' | 'right'
  showBorder: true,
  alwaysOnTop: true,
  autoStart: false
};

const builtinThemes = {
  dark: {
    name: '深邃黑',
    background: 'rgba(30, 30, 36, 0.92)',
    textColor: '#E6E6E6',
    borderColor: 'rgba(255, 255, 255, 0.18)',
    shadowColor: 'rgba(0, 0, 0, 0.55)',
    accent: '#4A90E2'
  },
  light: {
    name: '柔光白',
    background: 'rgba(248, 248, 252, 0.92)',
    textColor: '#1F1F1F',
    borderColor: 'rgba(0, 0, 0, 0.12)',
    shadowColor: 'rgba(0, 0, 0, 0.18)',
    accent: '#0A66C2'
  },
  neon: {
    name: '霓虹青',
    background: 'rgba(8, 12, 20, 0.92)',
    textColor: '#7DF9FF',
    borderColor: 'rgba(125, 249, 255, 0.45)',
    shadowColor: 'rgba(0, 255, 240, 0.30)',
    accent: '#FF2E97'
  },
  paper: {
    name: '便签黄',
    background: 'rgba(255, 244, 181, 0.95)',
    textColor: '#3A2C00',
    borderColor: 'rgba(180, 140, 0, 0.40)',
    shadowColor: 'rgba(120, 80, 0, 0.25)',
    accent: '#B5791E'
  },
  rose: {
    name: '玫瑰粉',
    background: 'rgba(255, 226, 232, 0.94)',
    textColor: '#5A1A2E',
    borderColor: 'rgba(220, 80, 120, 0.40)',
    shadowColor: 'rgba(180, 40, 80, 0.25)',
    accent: '#C7386E'
  }
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Object.assign({}, defaultSettings, parsed);
    }
  } catch (err) {
    console.error('[OnCallLabel] 加载设置失败:', err);
  }
  return Object.assign({}, defaultSettings);
}

function saveSettings(settings) {
  try {
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[OnCallLabel] 保存设置失败:', err);
  }
}

function loadUserThemes() {
  try {
    if (fs.existsSync(userThemesPath)) {
      return JSON.parse(fs.readFileSync(userThemesPath, 'utf8'));
    }
  } catch (err) {
    console.error('[OnCallLabel] 加载自定义主题失败:', err);
  }
  return {};
}

function getAllThemes() {
  return Object.assign({}, builtinThemes, loadUserThemes());
}

// ====== 主窗口 ======
let mainWindow = null;
let settingsWindow = null;
let settings = loadSettings();
let currentTheme = null;
let foregroundTimer = null;
let lastOpacityState = null;  // 'active' | 'inactive'

function createWindow() {
  const themes = getAllThemes();
  currentTheme = themes[settings.theme] || themes.dark;

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let x = settings.position ? settings.position.x : Math.floor((sw - settings.size.width) / 2);
  let y = settings.position ? settings.position.y : Math.floor((sh - settings.size.height) / 2);

  // 边界保护：确保不跑到屏幕外
  x = Math.max(0, Math.min(x, sw - 80));
  y = Math.max(0, Math.min(y, sh - 40));

  mainWindow = new BrowserWindow({
    width: settings.size.width,
    height: settings.size.height,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,  // 我们用 CSS 自己画阴影
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'OnCallLabel',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 置顶层级设为 screen-saver 级，比普通窗口更高
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  // 跳过任务栏（再次保险）
  mainWindow.setSkipTaskbar(true);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    startForegroundWatcher();
  });

  // 窗口移动时记录位置
  mainWindow.on('move', () => {
    const [wx, wy] = mainWindow.getPosition();
    settings.position = { x: wx, y: wy };
    // 不立即写盘，避免频繁 IO；由 before-quit 时统一保存
  });

  // 失焦时统一保存一次
  mainWindow.on('blur', () => {
    saveSettings(settings);
  });

  mainWindow.on('closed', () => {
    stopForegroundWatcher();
    mainWindow = null;
  });

  // 屏蔽右键默认菜单（我们用自己的）
  mainWindow.webContents.on('context-menu', (e) => {
    e.preventDefault();
  });
}

// ====== 前台窗口监听：决定不透明度 ======
function startForegroundWatcher() {
  if (foregroundTimer) clearInterval(foregroundTimer);
  // 每 500ms 检查一次前台窗口
  foregroundTimer = setInterval(updateOpacityByForeground, 500);
  updateOpacityByForeground();  // 立即执行一次
}

function stopForegroundWatcher() {
  if (foregroundTimer) {
    clearInterval(foregroundTimer);
    foregroundTimer = null;
  }
}

function updateOpacityByForeground() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const info = getForegroundInfo();
  if (!info) return;

  // 1. 前台是桌面/外壳（Progman/WorkerW/Shell_TrayWnd） → 100%
  // 2. 我们自己获得焦点（点击标签时） → 100%
  // 3. 其他应用在前台 → 降低不透明度
  let shouldBeActive = false;
  if (info.isDesktop) {
    shouldBeActive = true;
  } else {
    const focused = BrowserWindow.getFocusedWindow();
    const ourFocused = (focused === mainWindow) || mainWindow.isFocused() ||
      (settingsWindow && (focused === settingsWindow || settingsWindow.isFocused()));
    shouldBeActive = ourFocused;
  }

  const target = shouldBeActive ? settings.opacity.active : settings.opacity.inactive;
  const targetState = shouldBeActive ? 'active' : 'inactive';
  if (lastOpacityState !== targetState) {
    lastOpacityState = targetState;
    try {
      mainWindow.setOpacity(target);
      mainWindow.webContents.send('opacity:changed', { opacity: target, state: targetState });
    } catch (err) {
      // ignore
    }
  }
}

// ====== 设置弹窗（独立窗口，避免被小标签区域截断） ======
function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  const WIN_W = 270;
  const WIN_H = 470;

  // 依据主标签位置，计算设置窗弹出位置（优先在右侧，空间不足则左侧）
  let px = 100, py = 100;
  if (mainWindow) {
    const [mx, my] = mainWindow.getPosition();
    const [mw] = mainWindow.getSize();
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    px = mx + mw + 8;
    if (px + WIN_W > sw - 8) px = mx - WIN_W - 8;   // 右侧放不下 → 左侧
    if (px < 8) px = Math.max(8, Math.floor((sw - WIN_W) / 2)); // 都放不下 → 居中
    py = Math.min(my, sh - WIN_H - 8);
    if (py < 8) py = 8;
  }

  settingsWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: px,
    y: py,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'OnCallLabel 设置',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  settingsWindow.setAlwaysOnTop(true, 'screen-saver');
  settingsWindow.setSkipTaskbar(true);
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    settingsWindow.focus();
  });

  // 失焦自动关闭（弹窗行为）
  settingsWindow.on('blur', () => {
    closeSettingsWindow();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  settingsWindow.webContents.on('context-menu', (e) => e.preventDefault());
}

function closeSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
  settingsWindow = null;
}

// ====== 开机自启动（写入 Windows 注册表 Run 项，任务管理器"启动"页可见） ======
// 便携版每次解压到临时目录，需用 PORTABLE_EXECUTABLE_FILE 指向原始便携 exe
function getLauncherPath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function getAutoStartEnabled() {
  try {
    const exePath = getLauncherPath();
    const result = app.getLoginItemSettings({ path: exePath });
    return !!result.openAtLogin;
  } catch (err) {
    console.error('[OnCallLabel] 读取开机启动失败:', err);
    return false;
  }
}

function setAutoStartEnabled(enabled) {
  try {
    const exePath = getLauncherPath();
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: exePath,
      args: ''
    });
    settings.autoStart = !!enabled;
    saveSettings(settings);
    return getAutoStartEnabled();
  } catch (err) {
    console.error('[OnCallLabel] 设置开机启动失败:', err);
    return false;
  }
}

// ====== IPC ======
ipcMain.handle('settings:get', () => {
  return { settings: settings, theme: currentTheme };
});

ipcMain.handle('settings:patch', (e, patch) => {
  settings = Object.assign({}, settings, patch);
  saveSettings(settings);
  // 通知其他窗口（主标签）实时刷新字体/对齐等设置
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents.id !== e.sender.id) {
      win.webContents.send('settings:patched', { settings: settings });
    }
  });
  return { settings: settings, theme: currentTheme };
});

ipcMain.handle('label:setText', (e, text) => {
  settings.labelText = text;
  saveSettings(settings);
  return true;
});

ipcMain.handle('themes:list', () => {
  const all = getAllThemes();
  const list = Object.keys(all).map(k => ({ id: k, name: all[k].name }));
  return { current: settings.theme, list: list };
});

ipcMain.handle('theme:apply', (e, themeId) => {
  const all = getAllThemes();
  if (!all[themeId]) return { ok: false, reason: '主题不存在' };
  settings.theme = themeId;
  currentTheme = all[themeId];
  saveSettings(settings);
  const payload = { id: themeId, theme: currentTheme };
  if (mainWindow) mainWindow.webContents.send('theme:changed', payload);
  if (settingsWindow) settingsWindow.webContents.send('theme:changed', payload);
  return { ok: true, theme: currentTheme };
});

// 设置弹窗
ipcMain.on('settings:open', () => {
  createSettingsWindow();
});
ipcMain.on('settings:close', () => {
  closeSettingsWindow();
});

// 开机自启动
ipcMain.handle('autostart:get', () => {
  return { enabled: getAutoStartEnabled() };
});
ipcMain.handle('autostart:set', (e, enabled) => {
  const actual = setAutoStartEnabled(enabled);
  return { enabled: actual };
});

// 从设置窗发起"编辑文本"：关闭设置窗并通知主窗进入编辑态
ipcMain.on('edit:start', () => {
  closeSettingsWindow();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('edit:start');
  }
});

// 拖动：增量移动
ipcMain.on('window:drag', (e, dx, dy) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let nx = Math.max(-settings.size.width + 40, Math.min(x + dx, sw - 40));
  let ny = Math.max(0, Math.min(y + dy, sh - 30));
  mainWindow.setPosition(nx, ny);
});

// 调整大小：传增量 dw/dh 与拖动方向 edges
ipcMain.on('window:resize', (e, dw, dh, edges) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  let nw = w, nh = h, nx = x, ny = y;
  if (edges.right) nw = Math.max(120, Math.min(800, w + dw));
  if (edges.bottom) nh = Math.max(48, Math.min(400, h + dh));
  if (edges.left) {
    nw = Math.max(120, Math.min(800, w - dw));
    nx = x + (w - nw);
  }
  if (edges.top) {
    nh = Math.max(48, Math.min(400, h - dh));
    ny = y + (h - nh);
  }
  settings.size = { width: nw, height: nh };
  mainWindow.setBounds({ x: nx, y: ny, width: nw, height: nh });
});

ipcMain.on('window:save-geometry', () => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  settings.position = { x, y };
  settings.size = { width: w, height: h };
  saveSettings(settings);
});

ipcMain.on('window:focus', () => {
  if (mainWindow) {
    if (mainWindow.setAlwaysOnTop) mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.focus();
  }
});

// 重置位置与大小：恢复默认尺寸并居中
ipcMain.on('window:reset', () => {
  if (!mainWindow) return;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const nw = 240, nh = 88;
  const nx = Math.floor((sw - nw) / 2);
  const ny = Math.floor((sh - nh) / 2);
  settings.size = { width: nw, height: nh };
  settings.position = { x: nx, y: ny };
  mainWindow.setBounds({ x: nx, y: ny, width: nw, height: nh });
  saveSettings(settings);
});

ipcMain.on('app:quit', () => {
  saveSettings(settings);
  app.quit();
});

// 让渲染进程可以读到内置主题（仅用于"恢复默认"等场景）
ipcMain.handle('themes:get-all', () => getAllThemes());

// ====== 启动 ======
app.whenReady().then(() => {
  loadUser32();   // 加载 Win32
  // 同步开机自启状态：以注册表实际状态为准（用户可能在任务管理器里改过）
  try {
    const actual = getAutoStartEnabled();
    if (settings.autoStart !== actual) {
      settings.autoStart = actual;
      saveSettings(settings);
    }
  } catch (_) {}
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  saveSettings(settings);
});

app.on('window-all-closed', () => {
  // Windows / Linux 上关闭所有窗口即退出
  app.quit();
});
