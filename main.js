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
  autoStart: false,
  uiMode: 'expanded'  // 'expanded' 完整显示 | 'ball' 悬浮球
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
let userResizing = false;  // 仅用户 Ctrl+拖边缘 resize 时为 true

// ====== 悬浮球模式常量与状态 ======
const BALL_WIN = 56;         // 悬浮球窗口边长（与 CSS 中 .ball 48px + 边距对应）
const SNAP_THRESHOLD = 20;   // 拖动释放时距屏幕边缘 < 20px → 半圆贴边隐藏
let ballSnapped = false;     // 是否处于"贴边半圆隐藏"状态
let ballSnapEdge = null;     // 'left' | 'right' | 'top' | 'bottom' | null

// 切换展开/收起模式；收起为悬浮球，展开恢复完整便签
function applyUiMode(mode) {
  if (mode !== 'ball' && mode !== 'expanded') return;
  settings.uiMode = mode;
  saveSettings(settings);
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  userResizing = true;
  try {
    if (mode === 'ball') {
      // 以当前窗口中心为基准，缩小为悬浮球
      const [x, y] = mainWindow.getPosition();
      const [w, h] = mainWindow.getSize();
      let nx = x + Math.round((w - BALL_WIN) / 2);
      let ny = y + Math.round((h - BALL_WIN) / 2);
      nx = Math.max(-BALL_WIN + 4, Math.min(nx, sw - 4));
      ny = Math.max(0, Math.min(ny, sh - BALL_WIN + 4));
      ballSnapped = false;
      ballSnapEdge = null;
      mainWindow.setBounds({ x: nx, y: ny, width: BALL_WIN, height: BALL_WIN });
      // 收起为小球后，设置窗没有存在的必要（避免父窗口缩小时设置窗跳动）
      closeSettingsWindow();
    } else {
      // 恢复完整便签：以球中心为基准展开
      ballSnapped = false;
      ballSnapEdge = null;
      const [x, y] = mainWindow.getPosition();
      const w = settings.size.width, h = settings.size.height;
      let nx = x + Math.round((BALL_WIN - w) / 2);
      let ny = y + Math.round((BALL_WIN - h) / 2);
      nx = Math.max(0, Math.min(nx, sw - 80));
      ny = Math.max(0, Math.min(ny, sh - 40));
      settings.position = { x: nx, y: ny };
      mainWindow.setBounds({ x: nx, y: ny, width: w, height: h });
    }
  } finally {
    userResizing = false;
  }
  saveSettings(settings);
  // 广播模式变化，让主标签与设置窗同步 UI
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send('ui:mode-changed', { uiMode: mode });
  });
}

function createWindow() {
  const themes = getAllThemes();
  currentTheme = themes[settings.theme] || themes.dark;

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const winW = settings.uiMode === 'ball' ? BALL_WIN : settings.size.width;
  const winH = settings.uiMode === 'ball' ? BALL_WIN : settings.size.height;
  let x = settings.position ? settings.position.x : Math.floor((sw - winW) / 2);
  let y = settings.position ? settings.position.y : Math.floor((sh - winH) / 2);

  // 边界保护：确保不跑到屏幕外
  x = Math.max(0, Math.min(x, sw - 80));
  y = Math.max(0, Math.min(y, sh - 40));

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
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

  // 拦截系统发起的 resize（DPI 变化、多显示器跨屏等），仅放行用户 Ctrl+拖边缘
  mainWindow.on('will-resize', (e) => {
    if (!userResizing) {
      e.preventDefault();
    }
  });

  // 兜底：如果窗口尺寸被系统改了，立即纠正回来（目标尺寸随模式变化）
  let correctingSize = false;
  mainWindow.on('resize', () => {
    if (userResizing || correctingSize) return;
    const [w, h] = mainWindow.getSize();
    const tw = settings.uiMode === 'ball' ? BALL_WIN : settings.size.width;
    const th = settings.uiMode === 'ball' ? BALL_WIN : settings.size.height;
    if (w !== tw || h !== th) {
      correctingSize = true;
      mainWindow.setSize(tw, th);
      correctingSize = false;
    }
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
  if (patch.uiMode && patch.uiMode !== 'expanded' && patch.uiMode !== 'ball') {
    delete patch.uiMode;  // 非法值忽略
  }
  if (patch.uiMode) {
    // 模式切换由 applyUiMode 统一处理窗口几何与广播
    applyUiMode(patch.uiMode);
  } else {
    // 通知其他窗口（主标签）实时刷新字体/对齐等设置
    BrowserWindow.getAllWindows().forEach(win => {
      if (win.webContents.id !== e.sender.id) {
        win.webContents.send('settings:patched', { settings: settings });
      }
    });
  }
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

// 拖动：增量移动（展开态与悬浮球共用；球模式贴边在释放时由 ball:end-drag 处理）
ipcMain.on('window:drag', (e, dx, dy) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let nx, ny;
  if (settings.uiMode === 'ball') {
    nx = Math.max(-BALL_WIN + 4, Math.min(x + dx, sw - 4));
    ny = Math.max(0, Math.min(y + dy, sh - 4));
  } else {
    nx = Math.max(-settings.size.width + 40, Math.min(x + dx, sw - 40));
    ny = Math.max(0, Math.min(y + dy, sh - 30));
  }
  const size = settings.uiMode === 'ball'
    ? { width: BALL_WIN, height: BALL_WIN }
    : settings.size;
  // 用 setBounds 代替 setPosition，每次拖动都显式锁定尺寸，杜绝 DPI 触发的系统 resize
  mainWindow.setBounds({ x: nx, y: ny, width: size.width, height: size.height });
});

// 调整大小：传增量 dw/dh 与拖动方向 edges（悬浮球模式不允许调整大小）
ipcMain.on('window:resize', (e, dw, dh, edges) => {
  if (!mainWindow) return;
  if (settings.uiMode === 'ball') return;
  userResizing = true;
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

// 保存位置（尺寸由 resize 处理器维护，不盲目从窗口回读，防止 DPI 污染）
ipcMain.on('window:save-geometry', () => {
  if (!mainWindow) return;
  userResizing = false;
  const [x, y] = mainWindow.getPosition();
  settings.position = { x, y };
  saveSettings(settings);
});

ipcMain.on('window:focus', () => {
  if (mainWindow) {
    if (mainWindow.setAlwaysOnTop) mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.focus();
  }
});

// ====== 悬浮球模式 IPC ======
// 切换展开/收起模式
ipcMain.on('ui:set-mode', (e, mode) => {
  if (settings.uiMode !== mode) applyUiMode(mode);
});

// 鼠标悬浮在半圆上 → 整个圆浮现（仍保持贴边状态，离开后缩回）
ipcMain.on('ball:undock', () => {
  if (!mainWindow || settings.uiMode !== 'ball' || !ballSnapped || !ballSnapEdge) return;
  const [x, y] = mainWindow.getPosition();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let nx = x, ny = y;
  if (ballSnapEdge === 'left') nx = 0;
  else if (ballSnapEdge === 'right') nx = sw - BALL_WIN;
  else if (ballSnapEdge === 'top') ny = 0;
  else if (ballSnapEdge === 'bottom') ny = sh - BALL_WIN;
  userResizing = true;
  mainWindow.setBounds({ x: nx, y: ny, width: BALL_WIN, height: BALL_WIN });
  userResizing = false;
});

// 鼠标离开球 → 若处于贴边状态则缩回半圆
ipcMain.on('ball:leave', () => {
  if (!mainWindow || settings.uiMode !== 'ball' || !ballSnapped || !ballSnapEdge) return;
  const [x, y] = mainWindow.getPosition();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let nx = x, ny = y;
  if (ballSnapEdge === 'left') nx = -(BALL_WIN / 2);
  else if (ballSnapEdge === 'right') nx = sw - (BALL_WIN / 2);
  else if (ballSnapEdge === 'top') ny = -(BALL_WIN / 2);
  else if (ballSnapEdge === 'bottom') ny = sh - (BALL_WIN / 2);
  userResizing = true;
  mainWindow.setBounds({ x: nx, y: ny, width: BALL_WIN, height: BALL_WIN });
  userResizing = false;
});

// 球拖动结束：moved=true 表示确实拖动过 → 判断是否贴边半圆隐藏
ipcMain.on('ball:end-drag', (e, moved) => {
  if (!mainWindow || settings.uiMode !== 'ball') return;
  if (!moved) return;  // 只是点击（如双击展开），不触发贴边
  const [x, y] = mainWindow.getPosition();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let edge = null;
  if (x <= SNAP_THRESHOLD) edge = 'left';
  else if (sw - (x + BALL_WIN) <= SNAP_THRESHOLD) edge = 'right';
  else if (y <= SNAP_THRESHOLD) edge = 'top';
  else if (sh - (y + BALL_WIN) <= SNAP_THRESHOLD) edge = 'bottom';

  let nx = x, ny = y;
  if (edge === 'left') nx = -(BALL_WIN / 2);
  else if (edge === 'right') nx = sw - (BALL_WIN / 2);
  else if (edge === 'top') ny = -(BALL_WIN / 2);
  else if (edge === 'bottom') ny = sh - (BALL_WIN / 2);

  ballSnapped = !!edge;
  ballSnapEdge = edge;
  userResizing = true;
  mainWindow.setBounds({ x: nx, y: ny, width: BALL_WIN, height: BALL_WIN });
  userResizing = false;
  settings.position = { x: nx, y: ny };
  saveSettings(settings);
});

// 重置位置与大小：恢复默认尺寸并居中（若处于悬浮球模式则先展开）
ipcMain.on('window:reset', () => {
  if (!mainWindow) return;
  if (settings.uiMode === 'ball') applyUiMode('expanded');
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const nw = 240, nh = 88;
  const nx = Math.floor((sw - nw) / 2);
  const ny = Math.floor((sh - nh) / 2);
  settings.size = { width: nw, height: nh };
  settings.position = { x: nx, y: ny };
  mainWindow.setBounds({ x: nx, y: ny, width: nw, height: nh });
  saveSettings(settings);
});

// 仅重置大小，保留当前位置（若处于悬浮球模式则先展开）
ipcMain.on('window:reset-size', () => {
  if (!mainWindow) return;
  if (settings.uiMode === 'ball') applyUiMode('expanded');
  const [x, y] = mainWindow.getPosition();
  const nw = 240, nh = 88;
  settings.size = { width: nw, height: nh };
  mainWindow.setBounds({ x, y, width: nw, height: nh });
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
