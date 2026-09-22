// settings.js - 设置弹窗逻辑

(() => {
  'use strict';

  const themeListEl = document.getElementById('theme-list');
  const fontSizeLabel = document.getElementById('font-size-label');
  const fontMinusBtn = document.getElementById('font-minus');
  const fontPlusBtn = document.getElementById('font-plus');
  const fontBoldBtn = document.getElementById('font-bold');
  const fontItalicBtn = document.getElementById('font-italic');
  const alignBtns = {
    left: document.getElementById('align-left'),
    center: document.getElementById('align-center'),
    right: document.getElementById('align-right')
  };
  const autostartToggle = document.getElementById('autostart-toggle');
  const uiModeToggle = document.getElementById('ui-mode-toggle');

  let currentSettings = null;
  let allThemes = {};

  // ====== 主题列表 ======
  async function buildThemeList() {
    const data = await window.oncall.listThemes();
    allThemes = await window.oncall.getAllThemes();
    themeListEl.innerHTML = '';
    data.list.forEach(t => {
      const item = document.createElement('div');
      item.className = 'theme-item' + (t.id === data.current ? ' active' : '');
      const sw = document.createElement('span');
      sw.className = 'theme-swatch';
      const th = allThemes[t.id];
      sw.style.background = th ? th.background : '#888';
      const name = document.createElement('span');
      name.textContent = t.name;
      item.appendChild(sw);
      item.appendChild(name);
      item.addEventListener('click', async () => {
        const r = await window.oncall.applyTheme(t.id);
        if (r.ok) {
          themeListEl.querySelectorAll('.theme-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
        }
      });
      themeListEl.appendChild(item);
    });
  }

  // ====== 字体 / 对齐 ======
  function syncFontUI() {
    if (!currentSettings) return;
    fontSizeLabel.textContent = currentSettings.fontSize || 18;
    fontBoldBtn.setAttribute('data-active', currentSettings.bold ? 'true' : 'false');
    fontItalicBtn.setAttribute('data-active', currentSettings.italic ? 'true' : 'false');
    const align = ['left', 'center', 'right'].includes(currentSettings.textAlign) ? currentSettings.textAlign : 'center';
    Object.keys(alignBtns).forEach(k => {
      alignBtns[k].setAttribute('data-active', k === align ? 'true' : 'false');
    });
  }

  async function patch(patchObj) {
    const r = await window.oncall.patchSettings(patchObj);
    if (r && r.settings) {
      currentSettings = r.settings;
      syncFontUI();
    }
  }

  fontMinusBtn.addEventListener('click', () => {
    patch({ fontSize: Math.max(10, (currentSettings.fontSize || 18) - 1) });
  });
  fontPlusBtn.addEventListener('click', () => {
    patch({ fontSize: Math.min(72, (currentSettings.fontSize || 18) + 1) });
  });
  fontBoldBtn.addEventListener('click', () => {
    patch({ bold: !currentSettings.bold });
  });
  fontItalicBtn.addEventListener('click', () => {
    patch({ italic: !currentSettings.italic });
  });
  Object.keys(alignBtns).forEach(k => {
    alignBtns[k].addEventListener('click', () => {
      patch({ textAlign: k });
    });
  });

  // ====== 悬浮球模式 ======
  // 开关状态 = 悬浮球模式（checked=ball / unchecked=expanded）
  uiModeToggle.addEventListener('change', async () => {
    const want = uiModeToggle.checked ? 'ball' : 'expanded';
    // patchSettings 内部会调用 applyUiMode：
    // 切到 ball 时主进程会自动关闭本设置窗；切回 expanded 时本窗保留并实时同步
    await window.oncall.patchSettings({ uiMode: want });
  });

  // ====== 开机自启动 ======
  async function refreshAutoStart() {
    const r = await window.oncall.getAutoStart();
    autostartToggle.checked = !!r.enabled;
  }

  autostartToggle.addEventListener('change', async () => {
    const want = autostartToggle.checked;
    const r = await window.oncall.setAutoStart(want);
    // 以系统实际结果为准（可能因权限失败）
    autostartToggle.checked = !!r.enabled;
    if (r.enabled !== want) {
      // 设置未生效时提示（简单用 title）
      autostartToggle.parentElement.title = '设置失败，可能需要管理员权限';
    } else {
      autostartToggle.parentElement.title = '';
    }
  });

  // ====== 操作 ======
  document.getElementById('action-edit').addEventListener('click', () => {
    window.oncall.startEdit();  // 主进程会关闭本窗并让标签进入编辑态
  });

  document.getElementById('action-reset').addEventListener('click', async () => {
    await window.oncall.resetWindow();
    window.oncall.closeSettings();
  });

  document.getElementById('action-reset-size').addEventListener('click', async () => {
    await window.oncall.resetSize();
    window.oncall.closeSettings();
  });

  document.getElementById('action-quit').addEventListener('click', () => {
    window.oncall.quitApp();
  });

  document.getElementById('close-btn').addEventListener('click', () => {
    window.oncall.closeSettings();
  });

  // 主题被切换时重建列表以刷新高亮
  window.oncall.onThemeChanged(() => {
    buildThemeList();
  });

  // 模式切换（可能来自主窗双击展开等）→ 同步开关状态
  window.oncall.onUiModeChanged((data) => {
    if (data && data.uiMode) {
      uiModeToggle.checked = data.uiMode === 'ball';
    }
  });

  // ====== 初始化 ======
  (async function init() {
    const data = await window.oncall.getSettings();
    currentSettings = data.settings;
    syncFontUI();
    uiModeToggle.checked = data.settings.uiMode === 'ball';
    await buildThemeList();
    await refreshAutoStart();
  })();
})();
