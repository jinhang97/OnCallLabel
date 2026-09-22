// renderer.js - 渲染进程：UI 逻辑、交互、主题应用

(() => {
  'use strict';

  const body = document.body;
  const label = document.getElementById('label');
  const labelText = document.getElementById('label-text');
  const editBox = document.getElementById('edit-box');
  const editInput = document.getElementById('edit-input');
  const statusDot = document.getElementById('status-dot');
  const hint = document.getElementById('hint');
  const ballView = document.getElementById('ball-view');
  const ball = document.getElementById('ball');
  const ballIcon = document.getElementById('ball-icon');

  const EDGE_THRESHOLD = 8;  // 边缘 8px 进入 resize 热区

  let currentTheme = null;
  let currentSettings = null;

  // 交互状态
  let mode = 'idle';   // 'idle' | 'move' | 'resize' | 'edit'
  let resizeEdges = {};
  let startScreenX = 0, startScreenY = 0;
  let lastScreenX = 0, lastScreenY = 0;
  let lastDragScreenX = 0, lastDragScreenY = 0;
  let lastResizeScreenX = 0, lastResizeScreenY = 0;

  // ====== 工具 ======
  // TODO 清单图标（内联 SVG data URI，颜色跟随主题文字色）
  function todoIconDataUri(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color || '#E6E6E6'}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6h10M9.5 12h10M9.5 18h10"/><path d="M3.5 5.6l1.6 1.7 3.2-3.6"/><path d="M3.5 11.6l1.6 1.7 3.2-3.6"/><path d="M3.5 17.6l1.6 1.7 3.2-3.6"/></svg>`;
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  function applyTheme(theme) {
    if (!theme) return;
    currentTheme = theme;
    label.style.background = theme.background;
    label.style.color = theme.textColor;
    label.style.borderColor = theme.borderColor;
    label.style.boxShadow = `0 4px 16px ${theme.shadowColor}`;
    // 主题色给 edit input 的边框一点变化
    editInput.style.borderColor = theme.accent || '#4A90E2';
    statusDot.style.color = theme.accent || '#43C59B';
    // 主题应用到悬浮球（背景 / 边框 / TODO 图标颜色），球无阴影
    ball.style.backgroundColor = theme.background;
    ball.style.borderColor = theme.borderColor;
    ball.style.color = theme.textColor;
    ballIcon.style.backgroundImage = todoIconDataUri(theme.textColor);
  }

  function applySettings(s) {
    currentSettings = s;
    if (s.labelText !== undefined) labelText.textContent = s.labelText;
    applyFontStyle(s);
    // 状态点初始为 active
    body.setAttribute('data-state', 'active');
  }

  // 应用字体样式：大小 / 粗体 / 斜体 / 对齐
  function applyFontStyle(s) {
    if (!s) return;
    if (s.fontSize) labelText.style.fontSize = s.fontSize + 'px';
    const weight = s.bold ? '700' : '400';
    const style = s.italic ? 'italic' : 'normal';
    const align = ['left', 'center', 'right'].includes(s.textAlign) ? s.textAlign : 'center';
    labelText.style.fontWeight = weight;
    labelText.style.fontStyle = style;
    labelText.style.textAlign = align;
    // 编辑框也同步
    editInput.style.fontWeight = weight;
    editInput.style.fontStyle = style;
    editInput.style.textAlign = align;
    if (s.fontSize) editInput.style.fontSize = s.fontSize + 'px';
  }

  // 切换展开/收起模式：仅更新 UI 状态；窗口几何切换由主进程 applyUiMode 处理
  function applyUiMode(uiMode) {
    const m = uiMode === 'ball' ? 'ball' : 'expanded';
    body.setAttribute('data-ui-mode', m);
    if (m === 'ball') {
      // 收起为球时结束可能的编辑态
      if (mode === 'edit') setEditing(false);
      ball.classList.remove('dragging');
    }
  }

  function setEditing(editing) {
    body.setAttribute('data-editing', editing ? 'true' : 'false');
    if (editing) {
      editBox.classList.remove('hidden');
      editInput.value = currentSettings.labelText || '';
      editInput.focus();
      editInput.select();
      mode = 'edit';
      hint.textContent = 'Enter 完成 · Alt+Enter 换行 · Esc 取消';
      hint.style.opacity = '0.6';
    } else {
      editBox.classList.add('hidden');
      if (mode === 'edit') mode = 'idle';
      hint.textContent = 'Ctrl+双击编辑 · 双击收起 · 拖动移动';
    }
  }

  function detectEdge(e) {
    const rect = label.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = rect.width, h = rect.height;
    const t = EDGE_THRESHOLD;

    const left = x < t;
    const right = x > w - t;
    const top = y < t;
    const bottom = y > h - t;

    let edge = null;
    if (top && left) edge = 'top-left';
    else if (top && right) edge = 'top-right';
    else if (bottom && left) edge = 'bottom-left';
    else if (bottom && right) edge = 'bottom-right';
    else if (left) edge = 'left';
    else if (right) edge = 'right';
    else if (top) edge = 'top';
    else if (bottom) edge = 'bottom';
    return edge;
  }

  function edgesFromString(edgeStr) {
    return {
      left: edgeStr && edgeStr.includes('left'),
      right: edgeStr && edgeStr.includes('right'),
      top: edgeStr && edgeStr.includes('top'),
      bottom: edgeStr && edgeStr.includes('bottom')
    };
  }

  // ====== 鼠标事件 ======
  label.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;  // 仅左键
    if (mode === 'edit') return;  // 编辑中不响应

    startScreenX = e.screenX;
    startScreenY = e.screenY;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;

    const ctrl = e.ctrlKey;
    if (ctrl) {
      // Ctrl + 边缘 → 调整大小
      const edge = detectEdge(e);
      if (edge) {
        mode = 'resize';
        resizeEdges = edgesFromString(edge);
        label.setAttribute('data-edge', edge);
        lastResizeScreenX = e.screenX;
        lastResizeScreenY = e.screenY;
        e.preventDefault();
        return;
      }
    }
    // 否则 → 拖动移动
    mode = 'move';
    label.classList.add('dragging');
    lastDragScreenX = e.screenX;
    lastDragScreenY = e.screenY;
  });

  document.addEventListener('mousemove', (e) => {
    // 更新 Ctrl 状态（用于光标显示）
    body.setAttribute('data-ctrl', e.ctrlKey ? 'true' : 'false');

    if (mode === 'idle') {
      // 在标签上时检测边缘 → 设置 data-edge 用于光标
      if (e.target === label || label.contains(e.target)) {
        const edge = detectEdge(e);
        if (edge && e.ctrlKey) {
          label.setAttribute('data-edge', edge);
        } else {
          label.removeAttribute('data-edge');
        }
      } else {
        label.removeAttribute('data-edge');
      }
      return;
    }

    if (mode === 'move') {
      const dx = e.screenX - lastDragScreenX;
      const dy = e.screenY - lastDragScreenY;
      lastDragScreenX = e.screenX;
      lastDragScreenY = e.screenY;
      window.oncall.dragBy(dx, dy);
      return;
    }

    if (mode === 'resize') {
      const dw = e.screenX - lastResizeScreenX;
      const dh = e.screenY - lastResizeScreenY;
      lastResizeScreenX = e.screenX;
      lastResizeScreenY = e.screenY;
      window.oncall.resizeBy(dw, dh, resizeEdges);
      return;
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (mode === 'move') {
      if (body.getAttribute('data-ui-mode') === 'ball') {
        // 悬浮球拖动结束：moved=true 才会触发贴边半圆隐藏
        ball.classList.remove('dragging');
        const moved = Math.abs(lastDragScreenX - startScreenX) > 3
          || Math.abs(lastDragScreenY - startScreenY) > 3;
        window.oncall.ballEndDrag(moved);
      } else {
        label.classList.remove('dragging');
        window.oncall.saveGeometry();
      }
    } else if (mode === 'resize') {
      window.oncall.saveGeometry();
      label.removeAttribute('data-edge');
    }
    if (mode !== 'edit') {
      mode = 'idle';
    }
  });

  // 双击：Ctrl+双击 → 编辑；普通双击 → 收起为悬浮球（与收起态双击展开对称）
  label.addEventListener('dblclick', (e) => {
    if (mode === 'edit') return; // 编辑态下双击用于选词，不收起
    if (e.ctrlKey) {
      e.preventDefault();
      setEditing(true);
    } else {
      window.oncall.setUiMode('ball');
    }
  });

  // 编辑框：Enter 完成编辑 / Alt+Enter 换行 / Esc 取消
  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.altKey) {
      // 单纯 Enter：完成编辑
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Enter' && e.altKey) {
      // Alt+Enter：在光标位置插入换行
      e.preventDefault();
      insertNewlineAtCursor();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
    e.stopPropagation();
  });

  // 在 textarea 光标位置插入换行符
  function insertNewlineAtCursor() {
    const ta = editInput;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    ta.value = val.slice(0, start) + '\n' + val.slice(end);
    // 光标移到换行后
    const pos = start + 1;
    ta.setSelectionRange(pos, pos);
    ta.focus();
  }
  editInput.addEventListener('blur', () => {
    // blur 时如果还在编辑就提交
    if (mode === 'edit') commitEdit();
  });

  async function commitEdit() {
    // 去掉首尾空白（保留中间换行），但若全是空白则不保存
    const v = editInput.value.replace(/^\s+|\s+$/g, '');
    if (v) {
      await window.oncall.setLabelText(v);
      labelText.textContent = v;
      currentSettings.labelText = v;
    }
    setEditing(false);
  }
  function cancelEdit() {
    setEditing(false);
  }

  // 右键 → 打开设置窗
  label.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.oncall.openSettings();
  });

  // 齿轮按钮点击 → 打开设置窗
  const settingsBtn = document.getElementById('settings-btn');
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.oncall.openSettings();
  });
  settingsBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  // ====== 悬浮球交互 ======
  ball.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // 若处于贴边半圆状态，先整体浮现再拖动，避免拖动起点跳变
    window.oncall.ballUndock();
    startScreenX = e.screenX;
    startScreenY = e.screenY;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    lastDragScreenX = e.screenX;
    lastDragScreenY = e.screenY;
    mode = 'move';
    ball.classList.add('dragging');
  });

  // 左键双击 → 展开为完整便签
  ball.addEventListener('dblclick', (e) => {
    e.preventDefault();
    window.oncall.setUiMode('expanded');
  });

  // 右键 → 设置
  ball.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.oncall.openSettings();
  });

  // 贴边半圆：鼠标悬浮 → 整个圆浮现；离开窗口 → 缩回半圆
  ballView.addEventListener('mouseenter', () => {
    window.oncall.ballUndock();
  });
  ballView.addEventListener('mouseleave', () => {
    window.oncall.ballLeave();
  });

  // ====== 监听主进程 ======
  window.oncall.onOpacityChanged((data) => {
    if (!data) return;
    body.setAttribute('data-state', data.state);
  });
  window.oncall.onThemeChanged((data) => {
    if (data && data.theme) {
      applyTheme(data.theme);
      body.setAttribute('data-theme', data.id);
    }
  });
  // 设置窗修改了字体/对齐等 → 实时刷新
  window.oncall.onSettingsPatched((data) => {
    if (data && data.settings) {
      currentSettings = data.settings;
      if (data.settings.labelText !== undefined) {
        labelText.textContent = data.settings.labelText;
      }
      applyFontStyle(data.settings);
    }
  });
  // 模式切换（展开/悬浮球）→ 同步 UI
  window.oncall.onUiModeChanged((data) => {
    if (data && data.uiMode) applyUiMode(data.uiMode);
  });
  // 从设置窗发起编辑
  window.oncall.onEditStart(() => {
    setEditing(true);
  });

  // ====== 初始化 ======
  (async function init() {
    const data = await window.oncall.getSettings();
    applySettings(data.settings);
    applyTheme(data.theme);
    body.setAttribute('data-theme', data.settings.theme || 'dark');
    body.setAttribute('data-state', 'active');
    applyUiMode(data.settings.uiMode);
    // 偶尔提示淡出
    setTimeout(() => {
      hint.style.transition = 'opacity 1.2s ease';
      hint.style.opacity = '0';
    }, 4500);
  })();
})();
