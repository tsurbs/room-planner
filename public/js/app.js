import { CATALOG, CATEGORIES } from './catalog.js';
import {
  createDefaultLayout,
  createEmptyLayout,
  validateLayout,
  cloneLayout,
} from './default-layout.js';
import * as sync from './sync.js';
import {
  buildLayoutCommand,
  applyInverse,
  applyForward,
  findApplicableCommand,
} from './shared-history.js';

const STORAGE_KEY = 'room-planner-layout';
const STORAGE_SLOTS_KEY = 'room-planner-saves';
const PANELS_STORAGE_KEY = 'room-planner-panels';
const PX_PER_FT = 14;
const BG_TRACE_ID = 'trace';
const BG_DEFAULT_OPACITY = 0.5;
const BG_MAX_PX = 4096;
const MOBILE_MQ = '(max-width: 768px)';
const DRAG_MOVE_THRESHOLD = 4;

const state = {
  layout: createDefaultLayout(),
  mode: 'furnish', // 'furnish' | 'walls'
  selection: [], // { kind: 'item'|'wall'|'label', id }[]
  drag: null,
  dragPending: null,
  pinch: null,
  pan: { x: 40, y: 40 },
  zoom: 1,
  history: [],
  historyIndex: -1,
  /** @type {import('./shared-history.js').LayoutCommand[]} */
  sharedUndo: [],
  /** @type {import('./shared-history.js').LayoutCommand[]} */
  sharedRedo: [],
  /** Layout snapshot after last local committed edit (shared mode diff baseline). */
  sharedBaseline: null,
  spaceHeld: false,
  catalogQuery: '',
  panels: { left: false, right: false },
  placingLabel: false,
  placingCatalogType: null,
  wallDrawTool: false,
  lastLabelTap: { id: null, t: 0 },
};

function isMobileTouchUI() {
  return window.matchMedia(MOBILE_MQ).matches;
}

function handleMetrics() {
  const hs = isMobileTouchUI() ? 7 : 5;
  const hSize = isMobileTouchUI() ? 14 : 10;
  const wallR = isMobileTouchUI() ? 10 : 6;
  const rotR = isMobileTouchUI() ? 10 : 6;
  const rotOff = isMobileTouchUI() ? 18 : 14;
  return { hs, hSize, wallR, rotR, rotOff };
}

function itemSelectionTransform(item) {
  const p = worldToScreen(item.x, item.y);
  const pw = ftToPx(item.w);
  const ph = ftToPx(item.h);
  const rot = item.rotation || 0;
  return {
    transform: `translate(${p.x},${p.y}) rotate(${rot},${pw / 2},${ph / 2})`,
    pw,
    ph,
  };
}

/** Resize/rotate handles on a top layer so room labels cannot block pointer hits. */
function appendItemSelectionHandles(g, pw, ph) {
  g.appendChild(
    el('rect', {
      x: -1,
      y: -1,
      width: pw + 2,
      height: ph + 2,
      fill: 'none',
      stroke: 'var(--selection)',
      'stroke-width': 1.5,
      'pointer-events': 'none',
    })
  );
  const { hs, hSize, rotR, rotOff } = handleMetrics();
  const rotHitR = rotR + (isMobileTouchUI() ? 10 : 6);
  [
    { x: 0, y: 0, corner: 'nw' },
    { x: pw, y: 0, corner: 'ne' },
    { x: 0, y: ph, corner: 'sw' },
    { x: pw, y: ph, corner: 'se' },
  ].forEach((h) => {
    g.appendChild(
      el('rect', {
        x: h.x - hs,
        y: h.y - hs,
        width: hSize,
        height: hSize,
        class: 'resize-handle',
        'data-resize': h.corner,
      })
    );
  });
  g.appendChild(
    el('circle', {
      cx: pw / 2,
      cy: -rotOff,
      r: rotR,
      class: 'rotate-handle',
      'data-rotate': '1',
      'pointer-events': 'none',
    })
  );
  g.appendChild(
    el('circle', {
      cx: pw / 2,
      cy: -rotOff,
      r: rotHitR,
      fill: 'rgba(0,0,0,0.01)',
      class: 'rotate-handle-hit',
      'data-rotate': '1',
    })
  );
}

function renderItemSelectionOverlay(svg) {
  if (state.mode !== 'furnish' || state.selection.length !== 1) return;
  const sel = primarySelection();
  if (sel?.kind !== 'item') return;
  const item = getItem(sel.id);
  if (!item) return;
  const { transform, pw, ph } = itemSelectionTransform(item);
  const g = el('g', {
    class: 'selection-handles-layer',
    'data-item-id': item.id,
    transform,
  });
  appendItemSelectionHandles(g, pw, ph);
  svg.appendChild(g);
}

const $ = (sel) => document.querySelector(sel);
const canvas = () => $('#floor-canvas');
const svgNS = 'http://www.w3.org/2000/svg';

function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function paintToolbarIconsOnce() {
  const L = globalThis.lucide;
  if (!L?.createIcons) return false;
  try {
    L.createIcons({
      attrs: {
        stroke: 'currentColor',
        'stroke-width': 2,
      },
    });
  } catch {
    L.createIcons();
  }
  return true;
}

function initToolbarIcons() {
  if (paintToolbarIconsOnce()) return;
  if (typeof document !== 'undefined' && document.readyState !== 'complete') {
    window.addEventListener(
      'load',
      () => {
        paintToolbarIconsOnce();
      },
      { once: true },
    );
  }
}

function setAppModalOpen(on) {
  document.querySelector('.app')?.classList.toggle('app-modal-open', !!on);
}

function setStatus(text) {
  $('#status-msg').textContent = text;
}

function loadPanelState() {
  try {
    const raw = sessionStorage.getItem(PANELS_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (typeof data.left === 'boolean') state.panels.left = data.left;
      if (typeof data.right === 'boolean') state.panels.right = data.right;
    }
  } catch (_) {}
  // Desktop panel prefs use overlay side sheets on mobile and can hide the canvas.
  if (isMobileTouchUI()) {
    state.panels.left = true;
    state.panels.right = true;
  }
}

function savePanelState() {
  sessionStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(state.panels));
}

function applyPanelState() {
  const app = $('.app');
  if (!app) return;
  app.classList.toggle('left-collapsed', state.panels.left);
  app.classList.toggle('right-collapsed', state.panels.right);
  ['left', 'right'].forEach((side) => {
    const collapsed = state.panels[side];
    $(`#panel-${side}`)?.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    $(`#panel-toggle-${side}`)?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    $(`#btn-panel-${side}`)?.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
  });
  resizeCanvas();
}

/** Collapse overlay panels and fit the plan — safe to call after layout/viewport settles. */
function ensureMobileLayout() {
  if (!isMobileTouchUI()) return;
  state.panels.left = true;
  state.panels.right = true;
  applyPanelState();
  fitPlanToView();
}

/** Hide catalog/properties overlays so the canvas is tappable. */
function collapseMobilePanelsForCanvas() {
  if (!isMobileTouchUI()) return;
  let changed = false;
  ['left', 'right'].forEach((side) => {
    if (!state.panels[side]) {
      state.panels[side] = true;
      changed = true;
    }
  });
  if (changed) {
    savePanelState();
    applyPanelState();
  }
}

function togglePanel(side) {
  if (side !== 'left' && side !== 'right') return;
  state.panels[side] = !state.panels[side];
  savePanelState();
  applyPanelState();
}

function ftToPx(v) {
  return v * PX_PER_FT * state.zoom;
}

function pxToFt(v) {
  return v / (PX_PER_FT * state.zoom);
}

function snapFt(v, grid = 0.25) {
  return Math.round(v / grid) * grid;
}

function snapRotationDeg(deg, step) {
  return (((Math.round(deg / step) * step) % 360) + 360) % 360;
}

const LAYOUT_DRAG_SYNC = new Set([
  'item-move',
  'label-move',
  'resize',
  'bg-move',
  'bg-resize',
  'rotate-drag',
  'wall-move',
  'wall-endpoint',
  'wall-draw',
]);

const HISTORY_MAX = 50;

function initSharedHistory(layout) {
  state.sharedUndo = [];
  state.sharedRedo = [];
  state.sharedBaseline = cloneLayout(layout);
  updateUndoButtons();
}

function syncSharedBaseline() {
  state.sharedBaseline = cloneLayout(state.layout);
}

function pushSharedHistory() {
  const before = state.sharedBaseline || cloneLayout(state.layout);
  const cmd = buildLayoutCommand(before, state.layout);
  if (!cmd.changes.length) return;
  state.sharedUndo.push(cmd);
  if (state.sharedUndo.length > HISTORY_MAX) state.sharedUndo.shift();
  state.sharedRedo = [];
  syncSharedBaseline();
  updateUndoButtons();
  sync.scheduleLayoutSync({ immediate: true });
}

function pushHistory() {
  if (sync.isPlanSessionActive()) {
    pushSharedHistory();
    return;
  }
  state.history = state.history.slice(0, state.historyIndex + 1);
  const snap = cloneLayout(state.layout);
  const tip = state.history[state.historyIndex];
  if (tip && JSON.stringify(tip) === JSON.stringify(snap)) return;
  state.history.push(snap);
  if (state.history.length > HISTORY_MAX) {
    state.history.shift();
  } else {
    state.historyIndex++;
  }
  updateUndoButtons();
  saveLocalDraft();
}

function restoreHistoryIndex(index) {
  if (index < 0 || index >= state.history.length) return false;
  state.historyIndex = index;
  state.layout = cloneLayout(state.history[index]);
  state.selection = [];
  render();
  updateUndoButtons();
  sync.onLocalEdit();
  if (!sync.isPlanSessionActive()) saveLocalDraft();
  return true;
}

function renderDuringLayoutDrag() {
  render();
  if (state.drag && LAYOUT_DRAG_SYNC.has(state.drag.type)) {
    sync.onLayoutPreview();
  }
}

function sharedUndoApply() {
  const hit = findApplicableCommand(state.sharedUndo, state.layout, 'undo');
  if (!hit) return false;
  state.sharedUndo.splice(hit.index, 1);
  applyInverse(hit.cmd, state.layout);
  state.sharedRedo.push(hit.cmd);
  if (state.sharedRedo.length > HISTORY_MAX) state.sharedRedo.shift();
  syncSharedBaseline();
  state.selection = [];
  render();
  updateUndoButtons();
  sync.scheduleLayoutSync({ immediate: true });
  return true;
}

function sharedRedoApply() {
  const hit = findApplicableCommand(state.sharedRedo, state.layout, 'redo');
  if (!hit) return false;
  state.sharedRedo.splice(hit.index, 1);
  applyForward(hit.cmd, state.layout);
  state.sharedUndo.push(hit.cmd);
  if (state.sharedUndo.length > HISTORY_MAX) state.sharedUndo.shift();
  syncSharedBaseline();
  state.selection = [];
  render();
  updateUndoButtons();
  sync.scheduleLayoutSync({ immediate: true });
  return true;
}

function undo() {
  if (sync.isPlanSessionActive()) {
    if (!sharedUndoApply()) {
      toast('Nothing to undo');
      return;
    }
    toast('Undo');
    return;
  }
  if (state.historyIndex <= 0) return;
  if (!restoreHistoryIndex(state.historyIndex - 1)) return;
  toast('Undo');
}

function redo() {
  if (sync.isPlanSessionActive()) {
    if (!sharedRedoApply()) {
      toast('Nothing to redo');
      return;
    }
    toast('Redo');
    return;
  }
  if (state.historyIndex >= state.history.length - 1) return;
  if (!restoreHistoryIndex(state.historyIndex + 1)) return;
  toast('Redo');
}

function updateUndoButtons() {
  const btnUndo = $('#btn-undo');
  const btnRedo = $('#btn-redo');
  if (sync.isPlanSessionActive()) {
    const canUndo = !!findApplicableCommand(state.sharedUndo, state.layout, 'undo');
    const canRedo = !!findApplicableCommand(state.sharedRedo, state.layout, 'redo');
    if (btnUndo) {
      btnUndo.disabled = !canUndo;
      btnUndo.title = canUndo ? 'Undo your last change' : 'Undo unavailable';
    }
    if (btnRedo) {
      btnRedo.disabled = !canRedo;
      btnRedo.title = canRedo ? 'Redo' : 'Redo unavailable';
    }
    return;
  }
  if (btnUndo) {
    btnUndo.disabled = state.historyIndex <= 0;
    btnUndo.title = 'Undo';
  }
  if (btnRedo) {
    btnRedo.disabled = state.historyIndex >= state.history.length - 1;
    btnRedo.title = 'Redo';
  }
}

function getWall(id) {
  return state.layout.walls.find((w) => w.id === id);
}

function getItem(id) {
  return state.layout.items.find((i) => i.id === id);
}

function getRoomLabel(id) {
  return (state.layout.roomLabels || []).find((r) => r.id === id);
}

function getBackgroundImage() {
  return state.layout.backgroundImage || null;
}

function updateTraceImageButton() {
  const btn = $('#btn-trace-image');
  if (!btn) return;
  const has = !!getBackgroundImage()?.src;
  btn.classList.toggle('active', has && isSelected('background', BG_TRACE_ID));
  btn.title = has
    ? 'Trace image — click to select; upload replaces image'
    : 'Trace image — upload PNG/JPG or paste from clipboard';
}

function setBackgroundImageFromDataUrl(dataUrl, imgW, imgH) {
  const { width: bw, height: bh } = state.layout.bounds;
  const maxW = bw * 0.85;
  const maxH = bh * 0.85;
  const aspect = imgW / imgH;
  let width = maxW;
  let height = width / aspect;
  if (height > maxH) {
    height = maxH;
    width = height * aspect;
  }
  state.layout.backgroundImage = {
    src: dataUrl,
    x: snapFt((bw - width) / 2),
    y: snapFt((bh - height) / 2),
    width: snapFt(width),
    height: snapFt(height),
    opacity: BG_DEFAULT_OPACITY,
    locked: false,
  };
  pushHistory();
  selectOne('background', BG_TRACE_ID);
  render();
  updateTraceImageButton();
}

function loadBackgroundImageFile(file) {
  if (!file?.type?.startsWith('image/')) {
    toast('Use a PNG or JPG image');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth > BG_MAX_PX || img.naturalHeight > BG_MAX_PX) {
        toast('Large image — export JSON may be slow');
      }
      setBackgroundImageFromDataUrl(dataUrl, img.naturalWidth, img.naturalHeight);
      toast('Trace image added');
    };
    img.onerror = () => toast('Could not load image');
    img.src = dataUrl;
  };
  reader.onerror = () => toast('Could not read file');
  reader.readAsDataURL(file);
}

function removeBackgroundImage() {
  if (!getBackgroundImage()) return;
  delete state.layout.backgroundImage;
  state.selection = state.selection.filter((s) => s.kind !== 'background');
  pushHistory();
  render();
  updateTraceImageButton();
  toast('Trace image removed');
}

function ensureRoomLabels() {
  if (!state.layout.roomLabels) state.layout.roomLabels = [];
}

function addRoomLabel(x, y, name = 'Label') {
  ensureRoomLabels();
  const label = {
    id: uid('lbl'),
    name,
    x: snapFt(x),
    y: snapFt(y),
    fontSize: 11,
  };
  state.layout.roomLabels.push(label);
  pushHistory();
  selectOne('label', label.id);
  render();
  toast('Label added');
}

function wallLength(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

function formatWallLength(ft) {
  const totalIn = Math.round(ft * 12);
  const feet = Math.floor(totalIn / 12);
  const inches = totalIn % 12;
  if (inches === 0) return `${feet}′`;
  if (feet === 0) return `${inches}″`;
  return `${feet}′ ${inches}″`;
}

function hideWallLengthTip() {
  const tip = $('#wall-length-tip');
  if (!tip) return;
  tip.classList.add('hidden');
  tip.setAttribute('aria-hidden', 'true');
}

function updateWallLengthTip(evt, wallId) {
  const tip = $('#wall-length-tip');
  if (!tip) return;
  if (!wallId) {
    hideWallLengthTip();
    return;
  }
  const w = getWall(wallId);
  if (!w) {
    hideWallLengthTip();
    return;
  }
  tip.textContent = formatWallLength(wallLength(w));
  tip.style.left = `${evt.clientX + 12}px`;
  tip.style.top = `${evt.clientY + 12}px`;
  tip.classList.remove('hidden');
  tip.setAttribute('aria-hidden', 'false');
}

function updateWallHoverFromPointer(evt) {
  const hit = hitTest(evt);
  if (hit?.kind === 'wall') updateWallLengthTip(evt, hit.id);
  else hideWallLengthTip();
}

function pointOnWall(w, t) {
  return {
    x: w.x1 + (w.x2 - w.x1) * t,
    y: w.y1 + (w.y2 - w.y1) * t,
  };
}

function isSelected(kind, id) {
  return state.selection.some((s) => s.kind === kind && s.id === id);
}

function primarySelection() {
  return state.selection[0] || null;
}

function clearSelection() {
  state.selection = [];
  renderProperties();
  render();
}

function selectOne(kind, id) {
  state.selection = id ? [{ kind, id }] : [];
  renderProperties();
  render();
}

function focusLabelNameField() {
  renderProperties();
  requestAnimationFrame(() => {
    const input = $('#lbl-name');
    input?.focus();
    input?.select();
  });
}

function cancelPlacingLabel() {
  if (!state.placingLabel) return false;
  state.placingLabel = false;
  $('.canvas-wrap')?.classList.remove('placing-label');
  return true;
}

function cancelPlacingCatalog() {
  if (!state.placingCatalogType) return false;
  state.placingCatalogType = null;
  $('.canvas-wrap')?.classList.remove('placing-item');
  return true;
}

function cancelMobileModes() {
  const a = cancelPlacingLabel();
  const b = cancelPlacingCatalog();
  const hadWallTool = state.wallDrawTool;
  state.wallDrawTool = false;
  return a || b || hadWallTool;
}

function toggleSelection(kind, id) {
  const idx = state.selection.findIndex((s) => s.kind === kind && s.id === id);
  if (idx >= 0) state.selection.splice(idx, 1);
  else state.selection.push({ kind, id });
  renderProperties();
  render();
}

function selectHit(hit, additive) {
  if (!hit) {
    clearSelection();
    return;
  }
  if (additive) toggleSelection(hit.kind, hit.id);
  else selectOne(hit.kind, hit.id);
}

function addItem(type, x, y) {
  const cat = CATALOG[type];
  if (!cat) return;
  const item = {
    id: uid('item'),
    type,
    x: snapFt(x),
    y: snapFt(y),
    w: cat.w,
    h: cat.h,
    rotation: 0,
  };
  state.layout.items.push(item);
  pushHistory();
  selectOne('item', item.id);
  render();
  toast(`Added ${cat.label}`);
}

function deleteSelected() {
  if (!state.selection.length) return;
  if (state.selection.some((s) => s.kind === 'background')) {
    removeBackgroundImage();
    return;
  }
  const itemIds = new Set(
    state.selection.filter((s) => s.kind === 'item').map((s) => s.id)
  );
  const wallIds = new Set(
    state.selection.filter((s) => s.kind === 'wall').map((s) => s.id)
  );
  const labelIds = new Set(
    state.selection.filter((s) => s.kind === 'label').map((s) => s.id)
  );
  state.layout.items = state.layout.items.filter((i) => !itemIds.has(i.id));
  state.layout.walls = state.layout.walls.filter((w) => !wallIds.has(w.id));
  if (wallIds.size) {
    state.layout.openings = (state.layout.openings || []).filter(
      (o) => !wallIds.has(o.wallId)
    );
  }
  if (labelIds.size) {
    state.layout.roomLabels = (state.layout.roomLabels || []).filter(
      (r) => !labelIds.has(r.id)
    );
  }
  pushHistory();
  clearSelection();
  toast('Deleted');
}

function rotateSelected(deg = 90) {
  let changed = false;
  state.selection.forEach((s) => {
    if (s.kind !== 'item') return;
    const item = getItem(s.id);
    if (!item) return;
    item.rotation = ((item.rotation || 0) + deg + 360) % 360;
    changed = true;
  });
  if (!changed) return;
  pushHistory();
  render();
}

function nudgeSelected(dx, dy) {
  let moved = false;
  state.selection.forEach((s) => {
    if (s.kind === 'background') {
      const bg = getBackgroundImage();
      if (!bg || bg.locked) return;
      bg.x = snapFt(bg.x + dx);
      bg.y = snapFt(bg.y + dy);
      moved = true;
    } else if (s.kind === 'item') {
      const item = getItem(s.id);
      if (!item) return;
      item.x = snapFt(item.x + dx);
      item.y = snapFt(item.y + dy);
      moved = true;
    } else if (s.kind === 'label') {
      const lbl = getRoomLabel(s.id);
      if (!lbl) return;
      lbl.x = snapFt(lbl.x + dx);
      lbl.y = snapFt(lbl.y + dy);
      moved = true;
    }
  });
  if (moved) {
    pushHistory();
    render();
  }
}

function duplicateSelected() {
  const newIds = [];
  state.selection.forEach((s) => {
    if (s.kind !== 'item') return;
    const src = getItem(s.id);
    if (!src) return;
    const copy = {
      ...src,
      id: uid('item'),
      x: snapFt(src.x + 0.5),
      y: snapFt(src.y + 0.5),
    };
    state.layout.items.push(copy);
    newIds.push(copy.id);
  });
  if (!newIds.length) return;
  pushHistory();
  state.selection = newIds.map((id) => ({ kind: 'item', id }));
  render();
  toast('Duplicated');
}

function bringItemForward(id) {
  const items = state.layout.items;
  const i = items.findIndex((it) => it.id === id);
  if (i < 0 || i >= items.length - 1) return;
  [items[i], items[i + 1]] = [items[i + 1], items[i]];
  pushHistory();
  render();
}

function sendItemBackward(id) {
  const items = state.layout.items;
  const i = items.findIndex((it) => it.id === id);
  if (i <= 0) return;
  [items[i], items[i - 1]] = [items[i - 1], items[i]];
  pushHistory();
  render();
}

function updatePanCursor() {
  const wrap = $('.canvas-wrap');
  const svg = canvas();
  const grabbing = state.drag?.type === 'pan';
  const grab = state.spaceHeld && !grabbing;
  wrap?.classList.toggle('cursor-grab', grab);
  wrap?.classList.toggle('cursor-grabbing', grabbing);
  svg?.classList.toggle('cursor-grab', grab);
  svg?.classList.toggle('cursor-grabbing', grabbing);
}

/* —— Persistence —— */
function saveLocalDraft() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.layout));
  } catch (_) {}
}

function saveToLocal(slotName) {
  const name = (slotName || 'autosave').trim() || 'autosave';
  const saves = JSON.parse(localStorage.getItem(STORAGE_SLOTS_KEY) || '{}');
  saves[name] = {
    savedAt: new Date().toISOString(),
    layout: cloneLayout(state.layout),
  };
  localStorage.setItem(STORAGE_SLOTS_KEY, JSON.stringify(saves));
  saveLocalDraft();
  refreshSessionsPanel();
  toast(`Saved locally as “${name}”`);
}

function loadFromLocal(name) {
  const saves = JSON.parse(localStorage.getItem(STORAGE_SLOTS_KEY) || '{}');
  const entry = saves[name];
  if (!entry?.layout) {
    toast('No save found');
    return;
  }
  if (!validateLayout(entry.layout)) {
    toast('Invalid layout data');
    return;
  }
  state.layout = cloneLayout(entry.layout);
  state.selection = [];
  pushHistory();
  render();
  toast(`Loaded “${name}”`);
}

function loadLocalDraft() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    toast('No local draft found');
    return;
  }
  try {
    const data = JSON.parse(raw);
    if (!validateLayout(data)) throw new Error('Invalid');
    state.layout = cloneLayout(data);
    state.selection = [];
    pushHistory();
    render();
    toast('Restored local draft');
  } catch {
    toast('Could not restore local draft');
  }
}

function refreshSessionsPanel() {
  const recentEl = $('#recent-sessions-list');
  const localEl = $('#local-restore-list');
  const leaveBtn = $('#btn-leave-session');
  if (leaveBtn) {
    leaveBtn.classList.toggle('hidden', !sync.isPlanSessionActive());
  }
  if (!recentEl && !localEl) return;

  const recent = sync.listRecentPlans();
  const currentId = sync.getPlanIdFromLocation();
  if (recentEl) {
    if (!recent.length) {
      recentEl.innerHTML =
        '<p class="empty-state">No shared plans yet. Use Share to create a link.</p>';
    } else {
      recentEl.innerHTML = recent
        .map((p) => {
          const short = p.id.slice(0, 8);
          const when = p.openedAt
            ? new Date(p.openedAt).toLocaleString()
            : '';
          const active = p.id === currentId ? ' session-item--active' : '';
          const label = p.label || short;
          return `<button type="button" class="catalog-item session-item${active}" data-join-plan="${p.id}"><span>${label}</span><span class="dims">${short} · ${when}</span></button>`;
        })
        .join('');
      recentEl.querySelectorAll('[data-join-plan]').forEach((btn) => {
        btn.addEventListener('click', () => joinSharedPlan(btn.dataset.joinPlan));
      });
    }
  }

  if (localEl) {
    const items = [];
    const draftRaw = localStorage.getItem(STORAGE_KEY);
    if (draftRaw) {
      try {
        const draft = JSON.parse(draftRaw);
        if (validateLayout(draft)) {
          items.push({
            key: '__draft__',
            label: 'Last local edit',
            savedAt: null,
          });
        }
      } catch (_) {}
    }
    const saves = JSON.parse(localStorage.getItem(STORAGE_SLOTS_KEY) || '{}');
    Object.keys(saves)
      .sort((a, b) => new Date(saves[b].savedAt) - new Date(saves[a].savedAt))
      .forEach((n) => {
        items.push({ key: n, label: n, savedAt: saves[n].savedAt });
      });
    if (!items.length) {
      localEl.innerHTML =
        '<p class="empty-state">Nothing saved locally. Use “Save locally” in the toolbar menu.</p>';
    } else {
      localEl.innerHTML = items
        .map((it) => {
          const when = it.savedAt
            ? new Date(it.savedAt).toLocaleString()
            : 'unsaved draft';
          return `<button type="button" class="catalog-item session-item" data-load-local="${it.key}"><span>${it.label}</span><span class="dims">${when}</span></button>`;
        })
        .join('');
      localEl.querySelectorAll('[data-load-local]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.dataset.loadLocal === '__draft__') loadLocalDraft();
          else loadFromLocal(btn.dataset.loadLocal);
        });
      });
    }
  }
}

async function joinSharedPlan(id) {
  if (!id) return;
  if (
    sync.getPlanIdFromLocation() === id &&
    sync.getSyncConnectionStatus() === 'live'
  ) {
    toast('Already in this session');
    return;
  }
  await sync.joinPlanSession(id, syncDeps(), toast);
  refreshSessionsPanel();
}

function tryLoadAutosave() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (validateLayout(data)) {
      state.layout = data;
      return true;
    }
  } catch (_) {}
  return false;
}

function exportJson() {
  const json = JSON.stringify(state.layout, null, 2);
  $('#export-text').value = json;
  $('#modal-export').classList.remove('hidden');
  setAppModalOpen(true);
}

function importJson(text) {
  try {
    const data = JSON.parse(text);
    if (!validateLayout(data)) throw new Error('Invalid schema');
    state.layout = data;
    state.selection = [];
    pushHistory();
    render();
    $('#modal-import').classList.add('hidden');
    setAppModalOpen(false);
    toast('Layout imported');
  } catch (e) {
    toast('Import failed: ' + e.message);
  }
}

function clearAutosaveStorage() {
  localStorage.removeItem(STORAGE_KEY);
  const saves = JSON.parse(localStorage.getItem(STORAGE_SLOTS_KEY) || '{}');
  if (saves.autosave) {
    delete saves.autosave;
    localStorage.setItem(STORAGE_SLOTS_KEY, JSON.stringify(saves));
    refreshSessionsPanel();
  }
}

function resetDefault() {
  if (!confirm('Reset to default floorplan? Unsaved changes will be lost.')) return;
  state.layout = createDefaultLayout();
  state.selection = [];
  pushHistory();
  render();
  toast('Reset to default');
}

function clearFloorplan() {
  if (
    !confirm(
      'Clear the entire floorplan? All walls, furniture, openings, and labels will be removed. Unsaved changes will be lost.'
    )
  ) {
    return;
  }
  const hadBg = !!getBackgroundImage()?.src;
  let keepBg = false;
  if (hadBg) {
    keepBg = !confirm(
      'Also remove the trace background image?\n\nOK — remove image too\nCancel — keep trace image on blank canvas'
    );
  }
  const savedBg = keepBg && hadBg ? cloneLayout(getBackgroundImage()) : null;
  state.layout = createEmptyLayout();
  if (savedBg) state.layout.backgroundImage = savedBg;
  state.selection = [];
  clearAutosaveStorage();
  pushHistory();
  render();
  updateTraceImageButton();
  toast(keepBg && hadBg ? 'Floorplan cleared (image kept)' : 'Floorplan cleared');
}

function syncDeps() {
  return {
    getState: () => state,
    render,
    pushHistory,
    cloneLayout,
    validateLayout,
    toast,
    updateUndoButtons,
    initSharedHistory,
    syncSharedBaseline,
  };
}

/* —— SVG rendering —— */
function worldToScreen(x, y) {
  return {
    x: state.pan.x + ftToPx(x),
    y: state.pan.y + ftToPx(y),
  };
}

function screenToWorld(sx, sy) {
  return {
    x: pxToFt(sx - state.pan.x),
    y: pxToFt(sy - state.pan.y),
  };
}

function renderBackgroundLayer(svg) {
  const bg = getBackgroundImage();
  if (!bg?.src) return;

  const p = worldToScreen(bg.x, bg.y);
  const pw = ftToPx(bg.width);
  const ph = ftToPx(bg.height);
  const sel = isSelected('background', BG_TRACE_ID);
  const gBg = el('g', { class: `background-layer ${sel ? 'selected' : ''}` });

  gBg.appendChild(
    el('image', {
      href: bg.src,
      x: p.x,
      y: p.y,
      width: pw,
      height: ph,
      opacity: bg.opacity ?? BG_DEFAULT_OPACITY,
      preserveAspectRatio: 'none',
      class: 'trace-image',
    })
  );

  if (state.mode === 'furnish') {
    gBg.appendChild(
      el('rect', {
        x: p.x,
        y: p.y,
        width: pw,
        height: ph,
        fill: 'transparent',
        class: 'trace-hit',
        'data-bg': '1',
      })
    );
  }

  if (sel && state.mode === 'furnish') {
    gBg.appendChild(
      el('rect', {
        x: p.x - 1,
        y: p.y - 1,
        width: pw + 2,
        height: ph + 2,
        fill: 'none',
        stroke: 'var(--selection)',
        'stroke-width': 1.5,
        'pointer-events': 'none',
        class: 'trace-outline',
      })
    );
    if (!bg.locked) {
      const { hs, hSize } = handleMetrics();
      [
        { x: p.x, y: p.y, corner: 'nw' },
        { x: p.x + pw, y: p.y, corner: 'ne' },
        { x: p.x, y: p.y + ph, corner: 'sw' },
        { x: p.x + pw, y: p.y + ph, corner: 'se' },
      ].forEach((h) => {
        gBg.appendChild(
          el('rect', {
            x: h.x - hs,
            y: h.y - hs,
            width: hSize,
            height: hSize,
            class: 'resize-handle trace-handle',
            'data-bg-resize': h.corner,
          })
        );
      });
    }
  }

  svg.appendChild(gBg);
}

function render() {
  const svg = canvas();
  if (!svg) return;
  svg.innerHTML = '';
  svg.setAttribute('class', `mode-${state.mode}`);

  renderBackgroundLayer(svg);

  const { width, height } = state.layout.bounds;
  const gGrid = el('g', { class: 'grid-layer' });
  for (let x = 0; x <= width; x += 1) {
    const p1 = worldToScreen(x, 0);
    const p2 = worldToScreen(x, height);
    gGrid.appendChild(
      el('line', {
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        class: x % 5 === 0 ? 'grid-major' : 'grid-minor',
        opacity: x % 5 === 0 ? 0.6 : 0.25,
      })
    );
  }
  for (let y = 0; y <= height; y += 1) {
    const p1 = worldToScreen(0, y);
    const p2 = worldToScreen(width, y);
    gGrid.appendChild(
      el('line', {
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        class: y % 5 === 0 ? 'grid-major' : 'grid-minor',
        opacity: y % 5 === 0 ? 0.6 : 0.25,
      })
    );
  }
  svg.appendChild(gGrid);

  const gLabels = el('g', { class: 'labels-layer' });
  (state.layout.roomLabels || []).forEach((r) => {
    const p = worldToScreen(r.x, r.y);
    const sel = isSelected('label', r.id);
    const fs = r.fontSize || 11;
    const g = el('g', {
      class: `room-label-group ${sel ? 'selected' : ''}`,
      'data-label-id': r.id,
    });
    const hitPad = isMobileTouchUI() ? 8 : 2;
    const hitW = Math.max(isMobileTouchUI() ? 56 : 48, r.name.length * fs * 0.55);
    g.appendChild(
      el('rect', {
        x: p.x - hitPad,
        y: p.y - hitPad,
        width: hitW + hitPad,
        height: fs + hitPad * 2 + 4,
        fill: 'transparent',
        class: 'room-label-hit',
        'data-label-id': r.id,
      })
    );
    const t = el('text', {
      x: p.x,
      y: p.y + fs,
      class: `room-label ${sel ? 'selected' : ''}`,
      'data-label-id': r.id,
      'font-size': fs,
    });
    t.textContent = r.name;
    g.appendChild(t);
    if (sel) {
      g.appendChild(
        el('rect', {
          x: p.x - 3,
          y: p.y - 3,
          width: hitW + 2,
          height: fs + 10,
          fill: 'none',
          stroke: 'var(--selection)',
          'stroke-width': 1.5,
          'pointer-events': 'none',
        })
      );
    }
    gLabels.appendChild(g);
  });

  const gWalls = el('g', { class: 'walls-layer' });
  state.layout.walls.forEach((w) => {
    const p1 = worldToScreen(w.x1, w.y1);
    const p2 = worldToScreen(w.x2, w.y2);
    const sel = isSelected('wall', w.id);
    if (state.mode === 'furnish') {
      gWalls.appendChild(
        el('line', {
          x1: p1.x,
          y1: p1.y,
          x2: p2.x,
          y2: p2.y,
          class: 'wall-hit-area',
          'data-wall-id': w.id,
        })
      );
    }
    const line = el('line', {
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      class: `wall-line ${w.exterior ? 'exterior' : ''} ${sel ? 'selected' : ''}`,
      'data-wall-id': w.id,
    });
    if (state.mode === 'walls') {
      line.classList.add('wall-hit');
      line.style.strokeWidth = sel ? 5 : w.exterior ? 8 : 6;
      line.style.cursor = 'pointer';
    } else {
      line.style.pointerEvents = 'none';
    }
    gWalls.appendChild(line);

    if (state.mode === 'walls' && sel) {
      const { wallR } = handleMetrics();
      [p1, p2].forEach((p, idx) => {
        const h = el('circle', {
          cx: p.x,
          cy: p.y,
          r: wallR,
          class: 'wall-endpoint-handle',
          'data-wall-id': w.id,
          'data-endpoint': idx === 0 ? 'start' : 'end',
        });
        gWalls.appendChild(h);
      });
    }
  });
  svg.appendChild(gWalls);

  const gOpen = el('g', { class: 'openings-layer' });
  (state.layout.openings || []).forEach((o) => {
    const w = getWall(o.wallId);
    if (!w) return;
    const len = wallLength(w);
    const hw = (o.width || 3) / 2 / len;
    const t0 = Math.max(0, o.t - hw);
    const t1 = Math.min(1, o.t + hw);
    const a = worldToScreen(
      w.x1 + (w.x2 - w.x1) * t0,
      w.y1 + (w.y2 - w.y1) * t0
    );
    const b = worldToScreen(
      w.x1 + (w.x2 - w.x1) * t1,
      w.y1 + (w.y2 - w.y1) * t1
    );
    gOpen.appendChild(
      el('line', {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        class: `opening-${o.kind}`,
        stroke: o.kind === 'window' ? '#7eb8da' : '#999',
        'stroke-width': o.kind === 'window' ? 4 : 2,
      })
    );
  });
  svg.appendChild(gOpen);

  const gItems = el('g', { class: 'items-layer' });
  state.layout.items.forEach((item) => {
    const cat = CATALOG[item.type] || { label: item.type };
    const sel = isSelected('item', item.id);
    const rot = item.rotation || 0;
    const p = worldToScreen(item.x, item.y);
    const pw = ftToPx(item.w);
    const ph = ftToPx(item.h);

    const g = el('g', {
      class: `item ${sel ? 'selected' : ''}`,
      'data-item-id': item.id,
      transform: `translate(${p.x},${p.y}) rotate(${rot},${pw / 2},${ph / 2})`,
    });

    const rect = el('rect', {
      x: 0,
      y: 0,
      width: pw,
      height: ph,
      rx: cat.round ? pw / 2 : 2,
      class: `item-rect ${cat.fixture ? 'fixture' : ''} ${sel ? 'selected' : ''}`,
      opacity: cat.opacity ?? 1,
    });
    g.appendChild(rect);

    const label = el('text', {
      x: pw / 2,
      y: ph / 2 + 3,
      class: 'item-label',
      'text-anchor': 'middle',
    });
    label.textContent = cat.label.split(' ')[0];
    g.appendChild(label);

    gItems.appendChild(g);
  });
  svg.appendChild(gItems);
  svg.appendChild(gLabels);

  sync.renderPeers(svg, worldToScreen);
  renderItemSelectionOverlay(svg);

  const bgNote = getBackgroundImage()?.src ? ' · trace image' : '';
  setStatus(
    `${state.mode === 'walls' ? 'Edit walls' : 'Furnish'} · ${state.layout.items.length} items${bgNote} · zoom ${(state.zoom * 100).toFixed(0)}%`
  );
  renderProperties();
  updateTraceImageButton();
}

function el(tag, attrs = {}) {
  const node = document.createElementNS(svgNS, tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.setAttribute('class', v);
    else node.setAttribute(k, v);
  });
  return node;
}

function renderProperties() {
  const panel = $('#props-panel');
  if (!panel) return;
  if (!state.selection.length) {
    const bgHint = getBackgroundImage()?.src
      ? ' Click the trace image (empty areas) or use <strong>Trace image</strong> in the toolbar to select it.'
      : ' Use <strong>Trace image</strong> to upload or paste a floorplan photo behind the grid.';
    panel.innerHTML = `<p class="empty-state">Select furniture, a wall, or a room label. Double-click a label to edit its text.${bgHint}</p>`;
    return;
  }
  if (state.selection.length > 1) {
    const n = state.selection.filter((s) => s.kind === 'item').length;
    const w = state.selection.filter((s) => s.kind === 'wall').length;
    const l = state.selection.filter((s) => s.kind === 'label').length;
    const parts = [];
    if (n) parts.push(`${n} item${n > 1 ? 's' : ''}`);
    if (w) parts.push(`${w} wall${w > 1 ? 's' : ''}`);
    if (l) parts.push(`${l} label${l > 1 ? 's' : ''}`);
    panel.innerHTML = `
      <p class="empty-state" style="padding-top:0">${parts.join(', ')} selected.</p>
      <button type="button" class="btn" id="prop-delete">Delete selection</button>
    `;
    $('#prop-delete')?.addEventListener('click', deleteSelected);
    return;
  }
  const sel = primarySelection();
  if (sel.kind === 'background') {
    const bg = getBackgroundImage();
    if (!bg) {
      clearSelection();
      return;
    }
    panel.innerHTML = `
      <p class="empty-state" style="padding-top:0;margin-bottom:8px;font-size:11px">Trace background image</p>
      <div class="prop-row">
        <label>X (ft)<input type="number" id="bg-x" value="${bg.x}" step="0.25"></label>
        <label>Y (ft)<input type="number" id="bg-y" value="${bg.y}" step="0.25"></label>
      </div>
      <div class="prop-row">
        <label>Width (ft)<input type="number" id="bg-w" value="${bg.width}" step="0.25" min="1"></label>
        <label>Height (ft)<input type="number" id="bg-h" value="${bg.height}" step="0.25" min="1"></label>
      </div>
      <label>Opacity<input type="range" id="bg-opacity" min="0.1" max="1" step="0.05" value="${bg.opacity ?? BG_DEFAULT_OPACITY}"></label>
      <label style="display:flex;align-items:center;gap:6px;margin:8px 0;font-size:12px">
        <input type="checkbox" id="bg-locked" ${bg.locked ? 'checked' : ''}> Lock position (while tracing walls)
      </label>
      <button type="button" class="btn" id="bg-replace">Replace image…</button>
      <button type="button" class="btn" id="bg-remove">Remove trace image</button>
    `;
    const applyBg = () => {
      pushHistory();
      render();
    };
    $('#bg-x')?.addEventListener('change', (e) => {
      bg.x = parseFloat(e.target.value) || 0;
      applyBg();
    });
    $('#bg-y')?.addEventListener('change', (e) => {
      bg.y = parseFloat(e.target.value) || 0;
      applyBg();
    });
    $('#bg-w')?.addEventListener('change', (e) => {
      bg.width = Math.max(1, parseFloat(e.target.value) || bg.width);
      applyBg();
    });
    $('#bg-h')?.addEventListener('change', (e) => {
      bg.height = Math.max(1, parseFloat(e.target.value) || bg.height);
      applyBg();
    });
    $('#bg-opacity')?.addEventListener('input', (e) => {
      bg.opacity = parseFloat(e.target.value);
      render();
    });
    $('#bg-opacity')?.addEventListener('change', () => pushHistory());
    $('#bg-locked')?.addEventListener('change', (e) => {
      bg.locked = e.target.checked;
      applyBg();
    });
    $('#bg-replace')?.addEventListener('click', () => $('#bg-image-file')?.click());
    $('#bg-remove')?.addEventListener('click', removeBackgroundImage);
    return;
  }
  if (sel.kind === 'label') {
    const lbl = getRoomLabel(sel.id);
    if (!lbl) {
      clearSelection();
      return;
    }
    panel.innerHTML = `
      <p class="empty-state" style="padding-top:0;margin-bottom:8px;font-size:11px">Room label</p>
      <label>Text<input type="text" id="lbl-name" value="${lbl.name.replace(/"/g, '&quot;')}"></label>
      <div class="prop-row">
        <label>X (ft)<input type="number" id="lbl-x" value="${lbl.x}" step="0.25"></label>
        <label>Y (ft)<input type="number" id="lbl-y" value="${lbl.y}" step="0.25"></label>
      </div>
      <label>Font size<input type="number" id="lbl-fs" value="${lbl.fontSize || 11}" step="1" min="8" max="32"></label>
      <button type="button" class="btn" id="prop-delete">Delete label</button>
    `;
    const applyLabel = (key, val) => {
      if (key === 'name') lbl.name = String(val).trim() || lbl.name;
      else lbl[key] = val;
      pushHistory();
      render();
    };
    $('#lbl-name')?.addEventListener('change', (e) => applyLabel('name', e.target.value));
    $('#lbl-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyLabel('name', e.target.value);
        e.target.blur();
      }
    });
    ['lbl-x', 'lbl-y', 'lbl-fs'].forEach((id) => {
      $(`#${id}`)?.addEventListener('change', (e) => {
        const key = id === 'lbl-fs' ? 'fontSize' : id.replace('lbl-', '');
        applyLabel(key, parseFloat(e.target.value) || 0);
      });
    });
    $('#prop-delete')?.addEventListener('click', deleteSelected);
    return;
  }
  if (sel.kind === 'item') {
    const item = getItem(sel.id);
    const cat = CATALOG[item.type];
    panel.innerHTML = `
      <div class="prop-row">
        <label>Type<input readonly value="${cat?.label || item.type}"></label>
        <label>Rotation°<input type="number" id="prop-rot" value="${item.rotation || 0}" step="90"></label>
      </div>
      <div class="prop-row">
        <label>X (ft)<input type="number" id="prop-x" value="${item.x}" step="0.25"></label>
        <label>Y (ft)<input type="number" id="prop-y" value="${item.y}" step="0.25"></label>
      </div>
      <div class="prop-row">
        <label>Width (ft)<input type="number" id="prop-w" value="${item.w}" step="0.25" min="0.5"></label>
        <label>Depth (ft)<input type="number" id="prop-h" value="${item.h}" step="0.25" min="0.5"></label>
      </div>
      <button type="button" class="btn" id="prop-rotate">Rotate 90°</button>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <button type="button" class="btn" id="prop-forward" title="Bring forward">↑ layer</button>
        <button type="button" class="btn" id="prop-back" title="Send backward">↓ layer</button>
        <button type="button" class="btn" id="prop-dup">Duplicate</button>
        <button type="button" class="btn" id="prop-delete">Delete</button>
      </div>
    `;
    ['prop-x', 'prop-y', 'prop-w', 'prop-h', 'prop-rot'].forEach((id) => {
      $(`#${id}`)?.addEventListener('change', (e) => {
        const key = id.replace('prop-', '');
        const map = { x: 'x', y: 'y', w: 'w', h: 'h', rot: 'rotation' };
        item[map[key]] = parseFloat(e.target.value) || 0;
        pushHistory();
        render();
      });
    });
    $('#prop-rotate')?.addEventListener('click', () => rotateSelected(90));
    $('#prop-forward')?.addEventListener('click', () => bringItemForward(item.id));
    $('#prop-back')?.addEventListener('click', () => sendItemBackward(item.id));
    $('#prop-dup')?.addEventListener('click', duplicateSelected);
    $('#prop-delete')?.addEventListener('click', deleteSelected);
  } else {
    const w = getWall(sel.id);
    panel.innerHTML = `
      <div class="prop-row">
        <label>Start X<input type="number" id="w-x1" value="${w.x1}" step="0.25"></label>
        <label>Start Y<input type="number" id="w-y1" value="${w.y1}" step="0.25"></label>
      </div>
      <div class="prop-row">
        <label>End X<input type="number" id="w-x2" value="${w.x2}" step="0.25"></label>
        <label>End Y<input type="number" id="w-y2" value="${w.y2}" step="0.25"></label>
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin:8px 0;font-size:12px">
        <input type="checkbox" id="w-ext" ${w.exterior ? 'checked' : ''}> Exterior wall
      </label>
      <button type="button" class="btn" id="prop-delete">Delete wall</button>
    `;
    const bind = (id, key, isCheck) => {
      $(`#${id}`)?.addEventListener('change', (e) => {
        w[key] = isCheck ? e.target.checked : parseFloat(e.target.value) || 0;
        pushHistory();
        render();
      });
    };
    bind('w-x1', 'x1');
    bind('w-y1', 'y1');
    bind('w-x2', 'x2');
    bind('w-y2', 'y2');
    bind('w-ext', 'exterior', true);
    $('#prop-delete')?.addEventListener('click', deleteSelected);
  }
}

/* —— Pointer interaction —— */
const IMMEDIATE_DRAG_TYPES = new Set([
  'resize',
  'bg-resize',
  'rotate-drag',
  'wall-endpoint',
  'wall-draw',
  'pan',
]);

/** Wait for pointer movement before starting drag (click = select only). */
const DRAG_DEFER_UNTIL_MOVE_TYPES = new Set([
  'item-move',
  'label-move',
  'bg-move',
  'wall-move',
]);

function clientToSvg(clientX, clientY) {
  const svg = canvas();
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function assignDrag(drag, evt) {
  const svg = canvas();
  if (!svg) return;
  const immediate =
    IMMEDIATE_DRAG_TYPES.has(drag.type) ||
    !DRAG_DEFER_UNTIL_MOVE_TYPES.has(drag.type);
  if (immediate) {
    state.dragPending = null;
    state.drag = drag;
  } else {
    state.drag = null;
    state.dragPending = {
      ...drag,
      clientX: evt.clientX,
      clientY: evt.clientY,
      pointerId: evt.pointerId,
    };
  }
  svg.setPointerCapture(evt.pointerId);
  if (drag.type === 'pan') updatePanCursor();
}

function promotePendingDrag(evt) {
  if (!state.dragPending || state.drag) return false;
  const dx = evt.clientX - state.dragPending.clientX;
  const dy = evt.clientY - state.dragPending.clientY;
  if (Math.hypot(dx, dy) < DRAG_MOVE_THRESHOLD) return false;
  const { clientX, clientY, pointerId, ...drag } = state.dragPending;
  state.drag = drag;
  state.dragPending = null;
  if (drag.type === 'pan') updatePanCursor();
  return true;
}

function revertPendingDrag() {
  const p = state.dragPending;
  if (!p) return;
  if (p.type === 'item-move' && p.origins) {
    Object.entries(p.origins).forEach(([id, orig]) => {
      const item = getItem(id);
      if (item) {
        item.x = orig.x;
        item.y = orig.y;
      }
    });
    render();
  } else if (p.type === 'item-move' && p.orig) {
    const item = getItem(p.id);
    if (item) {
      item.x = p.orig.x;
      item.y = p.orig.y;
      render();
    }
  } else if (p.type === 'label-move' && p.orig) {
    const lbl = getRoomLabel(p.id);
    if (lbl) {
      lbl.x = p.orig.x;
      lbl.y = p.orig.y;
      render();
    }
  }
  state.dragPending = null;
}

/** Finish a click that never promoted to drag — keep selection, don't clear on release outside. */
function finalizePendingPointer(evt, pending) {
  if (!pending) return;
  const hit = hitTest(evt);
  if (pending.type === 'item-move') {
    if (hit?.kind === 'item') selectHit(hit, false);
    else selectOne('item', pending.id);
    return;
  }
  if (pending.type === 'label-move') {
    if (hit?.kind === 'label') {
      const now = Date.now();
      if (state.lastLabelTap.id === hit.id && now - state.lastLabelTap.t < 400) {
        selectOne('label', hit.id);
        focusLabelNameField();
        state.lastLabelTap = { id: null, t: 0 };
        return;
      }
      state.lastLabelTap = { id: hit.id, t: now };
    } else {
      state.lastLabelTap = { id: null, t: 0 };
    }
    selectOne('label', pending.id);
    return;
  }
  if (pending.type === 'bg-move') {
    if (hit?.kind === 'background') selectOne('background', BG_TRACE_ID);
    return;
  }
  if (pending.type === 'wall-move') {
    if (hit?.kind === 'wall') selectHit(hit, false);
    else selectOne('wall', pending.id);
    return;
  }
  if (pending.type === 'pan' && !hit) {
    clearSelection();
  }
}

function handleMobileTap(evt, pending = null) {
  const pt = getSvgPoint(evt);
  const hit = hitTest(evt);

  if (pending) return;

  if (state.placingCatalogType && state.mode === 'furnish' && !hit) {
    const cat = CATALOG[state.placingCatalogType];
    const w = screenToWorld(pt.x, pt.y);
    addItem(
      state.placingCatalogType,
      w.x - (cat?.w || 2) / 2,
      w.y - (cat?.h || 2) / 2
    );
    cancelPlacingCatalog();
    return;
  }

  if (state.placingLabel && state.mode === 'furnish' && !hit) {
    const w = screenToWorld(pt.x, pt.y);
    addRoomLabel(w.x, w.y);
    cancelPlacingLabel();
    return;
  }

  if (hit?.kind === 'label') {
    const now = Date.now();
    if (state.lastLabelTap.id === hit.id && now - state.lastLabelTap.t < 400) {
      selectOne('label', hit.id);
      focusLabelNameField();
      state.lastLabelTap = { id: null, t: 0 };
      return;
    }
    state.lastLabelTap = { id: hit.id, t: now };
    if (!isSelected('label', hit.id)) selectOne('label', hit.id);
    return;
  }

  state.lastLabelTap = { id: null, t: 0 };

  if (hit?.kind === 'item' && !isSelected('item', hit.id)) {
    selectHit(hit, false);
    return;
  }

  if (!hit) clearSelection();
}

function touchMidAndDist(touches) {
  const a = touches[0];
  const b = touches[1];
  return {
    mid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
    dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
  };
}

function applyPinchFrame(mid, dist) {
  const p = state.pinch;
  if (!p || dist < 1) return;
  const svgPt = clientToSvg(mid.x, mid.y);
  const world = screenToWorld(svgPt.x, svgPt.y);
  const newZoom = Math.min(2.5, Math.max(0.4, p.startZoom * (dist / p.startDist)));
  state.zoom = newZoom;
  state.pan.x = svgPt.x - ftToPx(world.x);
  state.pan.y = svgPt.y - ftToPx(world.y);
  render();
}

function beginPinchGesture(touches) {
  if (state.drag) {
    state.drag = null;
    updatePanCursor();
  }
  revertPendingDrag();
  const { mid, dist } = touchMidAndDist(touches);
  state.pinch = {
    startDist: dist,
    startZoom: state.zoom,
  };
}

function onTouchStart(e) {
  if (!isMobileTouchUI()) return;
  if (e.touches.length >= 2) {
    e.preventDefault();
    beginPinchGesture(e.touches);
  }
}

function onTouchMove(e) {
  if (!isMobileTouchUI() || !state.pinch || e.touches.length < 2) return;
  e.preventDefault();
  const { mid, dist } = touchMidAndDist(e.touches);
  applyPinchFrame(mid, dist);
}

function onTouchEnd(e) {
  if (!isMobileTouchUI()) return;
  if (e.touches.length < 2) state.pinch = null;
}

function bindMobileTouch() {
  const wrap = $('.canvas-wrap');
  if (!wrap) return;
  wrap.addEventListener('touchstart', onTouchStart, { passive: false });
  wrap.addEventListener('touchmove', onTouchMove, { passive: false });
  wrap.addEventListener('touchend', onTouchEnd);
  wrap.addEventListener('touchcancel', onTouchEnd);
}

function getSvgPoint(evt) {
  const svg = canvas();
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const ctm = svg.getScreenCTM().inverse();
  return pt.matrixTransform(ctm);
}

function hitTest(evt) {
  const target = evt.target;
  const bgResize = target.dataset?.bgResize || target.getAttribute?.('data-bg-resize');
  if (bgResize) return { kind: 'background', id: BG_TRACE_ID, resize: bgResize };
  if (target.dataset?.bg || target.getAttribute?.('data-bg')) {
    return { kind: 'background', id: BG_TRACE_ID };
  }
  const labelId =
    target.getAttribute?.('data-label-id') ||
    target.closest?.('[data-label-id]')?.getAttribute('data-label-id');
  if (labelId) return { kind: 'label', id: labelId };
  const itemId = target.closest?.('[data-item-id]')?.getAttribute('data-item-id');
  if (itemId) {
    const resizeEl = target.closest?.('[data-resize]');
    const rotateEl = target.closest?.('[data-rotate]');
    return {
      kind: 'item',
      id: itemId,
      resize: resizeEl?.getAttribute('data-resize') || undefined,
      rotate: rotateEl ? true : undefined,
    };
  }
  const wallId = target.getAttribute?.('data-wall-id');
  if (wallId) {
    return {
      kind: 'wall',
      id: wallId,
      endpoint: target.getAttribute('data-endpoint'),
    };
  }
  return null;
}

function shouldPan(evt) {
  if (isMobileTouchUI()) {
    return evt.button === 1 || state.spaceHeld || evt.altKey;
  }
  return (
    evt.button === 1 ||
    state.spaceHeld ||
    evt.altKey ||
    (evt.pointerType === 'touch' && evt.buttons === 0 && evt.isPrimary === false)
  );
}

function startPan(evt) {
  assignDrag({ type: 'pan', start: getSvgPoint(evt), origPan: { ...state.pan } }, evt);
}

function onPointerDown(evt) {
  const svg = canvas();
  hideWallLengthTip();
  // Block native text selection so drag/pan/select handlers receive pointer moves.
  if (evt.button === 0 || evt.button === 1) evt.preventDefault();

  const pt = getSvgPoint(evt);
  const hit = hitTest(evt);

  if (shouldPan(evt)) {
    startPan(evt);
    return;
  }

  if (evt.button !== 0) return;
  if (state.pinch) return;

  if (state.mode === 'walls') {
    if (hit?.kind === 'wall') {
      selectHit(hit, evt.shiftKey);
      const w = getWall(hit.id);
      assignDrag(
        {
          type: hit.endpoint ? 'wall-endpoint' : 'wall-move',
          id: hit.id,
          endpoint: hit.endpoint,
          start: pt,
          orig: cloneLayout(w),
        },
        evt
      );
      return;
    }
    if (evt.shiftKey || (isMobileTouchUI() && state.wallDrawTool)) {
      const w = screenToWorld(pt.x, pt.y);
      const wall = {
        id: uid('wall'),
        x1: snapFt(w.x),
        y1: snapFt(w.y),
        x2: snapFt(w.x),
        y2: snapFt(w.y),
      };
      state.layout.walls.push(wall);
      selectOne('wall', wall.id);
      assignDrag({ type: 'wall-draw', id: wall.id, start: pt }, evt);
      return;
    }
    clearSelection();
    startPan(evt);
    return;
  }

  if (state.mode === 'furnish') {
    if (state.placingCatalogType && !hit) {
      return;
    }
    if (hit?.kind === 'background') {
      const bg = getBackgroundImage();
      if (!bg) return;
      if (bg.locked && !hit.resize) {
        selectOne('background', BG_TRACE_ID);
        return;
      }
      if (!isSelected('background', BG_TRACE_ID)) selectOne('background', BG_TRACE_ID);
      if (hit.resize && !bg.locked) {
        assignDrag(
          {
            type: 'bg-resize',
            corner: hit.resize,
            start: pt,
            orig: { x: bg.x, y: bg.y, w: bg.width, h: bg.height },
            aspect: bg.width / bg.height,
          },
          evt
        );
      } else if (!bg.locked) {
        assignDrag({ type: 'bg-move', start: pt, orig: { x: bg.x, y: bg.y } }, evt);
      }
      return;
    }
    if (hit?.kind === 'label') {
      cancelPlacingCatalog();
      cancelPlacingLabel();
      if (!isMobileTouchUI()) {
        if (!isSelected('label', hit.id)) selectHit(hit, evt.shiftKey);
        else if (evt.shiftKey) selectHit(hit, true);
      }
      const lbl = getRoomLabel(hit.id);
      assignDrag(
        { type: 'label-move', id: hit.id, start: pt, orig: { x: lbl.x, y: lbl.y } },
        evt
      );
      return;
    }
    if (state.placingLabel && !isMobileTouchUI()) {
      const w = screenToWorld(pt.x, pt.y);
      addRoomLabel(w.x, w.y);
      cancelPlacingLabel();
      return;
    }
    if (hit?.kind === 'item') {
      const item = getItem(hit.id);
      if (evt.altKey) {
        const copy = {
          ...item,
          id: uid('item'),
          x: snapFt(item.x),
          y: snapFt(item.y),
        };
        state.layout.items.push(copy);
        selectOne('item', copy.id);
        assignDrag(
          {
            type: 'item-move',
            id: copy.id,
            start: pt,
            orig: { x: copy.x, y: copy.y },
            duplicated: true,
          },
          evt
        );
        return;
      }
      if (!isMobileTouchUI()) {
        const onHandle = hit.resize || hit.rotate;
        if (onHandle) {
          if (!isSelected('item', hit.id)) selectOne('item', hit.id);
        } else if (!isSelected('item', hit.id)) {
          selectHit(hit, evt.shiftKey);
        } else if (evt.shiftKey) {
          selectHit(hit, true);
        }
      }

      const target = getItem(hit.id);
      if (hit.resize) {
        assignDrag(
          {
            type: 'resize',
            id: hit.id,
            corner: hit.resize,
            start: pt,
            orig: { x: target.x, y: target.y, w: target.w, h: target.h },
            aspect: target.w / target.h,
          },
          evt
        );
      } else if (hit.rotate) {
        const cx = target.x + target.w / 2;
        const cy = target.y + target.h / 2;
        const world = screenToWorld(pt.x, pt.y);
        assignDrag(
          {
            type: 'rotate-drag',
            id: hit.id,
            start: pt,
            centerX: cx,
            centerY: cy,
            startAngle: Math.atan2(world.y - cy, world.x - cx),
            origRot: target.rotation || 0,
          },
          evt
        );
      } else {
        const origins = {};
        state.selection
          .filter((s) => s.kind === 'item')
          .forEach((s) => {
            const it = getItem(s.id);
            if (it) origins[s.id] = { x: it.x, y: it.y };
          });
        assignDrag(
          {
            type: 'item-move',
            id: hit.id,
            start: pt,
            orig: { x: target.x, y: target.y },
            origins,
          },
          evt
        );
      }
      return;
    }
    clearSelection();
    startPan(evt);
    return;
  }
}

function applyResize(item, corner, dxf, dyf, lockAspect, evt) {
  const o = state.drag.orig;
  const min = 0.5;
  let x = o.x;
  let y = o.y;
  let w = o.w;
  let h = o.h;
  if (corner === 'se') {
    w = o.w + dxf;
    h = o.h + dyf;
  } else if (corner === 'nw') {
    x = o.x + dxf;
    y = o.y + dyf;
    w = o.w - dxf;
    h = o.h - dyf;
  } else if (corner === 'ne') {
    y = o.y + dyf;
    w = o.w + dxf;
    h = o.h - dyf;
  } else if (corner === 'sw') {
    x = o.x + dxf;
    w = o.w - dxf;
    h = o.h + dyf;
  }
  if (lockAspect) {
    const ratio = state.drag.aspect || o.w / o.h;
    if (Math.abs(dxf) > Math.abs(dyf)) h = w / ratio;
    else w = h * ratio;
    if (corner === 'nw' || corner === 'sw') x = o.x + o.w - w;
    if (corner === 'nw' || corner === 'ne') y = o.y + o.h - h;
  }
  item.x = snapFt(x);
  item.y = snapFt(y);
  item.w = Math.max(min, snapFt(w));
  item.h = Math.max(min, snapFt(h));
}

function onPointerMove(evt) {
  if (state.pinch) return;

  const pt0 = getSvgPoint(evt);
  const w0 = screenToWorld(pt0.x, pt0.y);
  sync.presenceTick(w0.x, w0.y);

  if (state.dragPending && !state.drag) {
    promotePendingDrag(evt);
  }

  if (!state.drag) {
    updateWallHoverFromPointer(evt);
    return;
  }
  hideWallLengthTip();
  const pt = getSvgPoint(evt);
  const dragStart = state.drag.start;
  const dx = dragStart ? pt.x - dragStart.x : 0;
  const dy = dragStart ? pt.y - dragStart.y : 0;

  if (state.drag.type === 'pan') {
    state.pan.x = state.drag.origPan.x + dx;
    state.pan.y = state.drag.origPan.y + dy;
    render();
    return;
  }

  if (state.drag.type === 'label-move') {
    const lbl = getRoomLabel(state.drag.id);
    if (lbl) {
      lbl.x = snapFt(state.drag.orig.x + pxToFt(dx));
      lbl.y = snapFt(state.drag.orig.y + pxToFt(dy));
    }
    renderDuringLayoutDrag();
    return;
  }

  if (state.drag.type === 'item-move') {
    const dxf = pxToFt(dx);
    const dyf = pxToFt(dy);
    if (state.drag.origins) {
      Object.entries(state.drag.origins).forEach(([id, orig]) => {
        const item = getItem(id);
        if (!item) return;
        item.x = snapFt(orig.x + dxf);
        item.y = snapFt(orig.y + dyf);
      });
    } else {
      const item = getItem(state.drag.id);
      item.x = snapFt(state.drag.orig.x + dxf);
      item.y = snapFt(state.drag.orig.y + dyf);
    }
    renderDuringLayoutDrag();
    return;
  }

  if (state.drag.type === 'resize') {
    const item = getItem(state.drag.id);
    applyResize(item, state.drag.corner, pxToFt(dx), pxToFt(dy), evt.shiftKey, evt);
    renderDuringLayoutDrag();
    return;
  }

  if (state.drag.type === 'bg-move') {
    const bg = getBackgroundImage();
    if (bg) {
      bg.x = snapFt(state.drag.orig.x + pxToFt(dx));
      bg.y = snapFt(state.drag.orig.y + pxToFt(dy));
    }
    renderDuringLayoutDrag();
    return;
  }

  if (state.drag.type === 'bg-resize') {
    const bg = getBackgroundImage();
    if (bg) {
      const stub = {
        x: bg.x,
        y: bg.y,
        w: bg.width,
        h: bg.height,
      };
      applyResize(stub, state.drag.corner, pxToFt(dx), pxToFt(dy), evt.shiftKey, evt);
      bg.x = stub.x;
      bg.y = stub.y;
      bg.width = stub.w;
      bg.height = stub.h;
    }
    renderDuringLayoutDrag();
    return;
  }

  if (state.drag.type === 'rotate-drag') {
    const item = getItem(state.drag.id);
    const cx = state.drag.centerX ?? item.x + item.w / 2;
    const cy = state.drag.centerY ?? item.y + item.h / 2;
    const world = screenToWorld(pt.x, pt.y);
    const angle = Math.atan2(world.y - cy, world.x - cx);
    let delta = ((angle - state.drag.startAngle) * 180) / Math.PI;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    let rotation = ((state.drag.origRot + delta) % 360 + 360) % 360;
    if (evt.shiftKey) rotation = snapRotationDeg(rotation, 15);
    item.rotation = rotation;
    renderDuringLayoutDrag();
    return;
  }

  if (state.drag.type === 'wall-move') {
    const w = getWall(state.drag.id);
    const o = state.drag.orig;
    const dxf = pxToFt(dx);
    const dyf = pxToFt(dy);
    w.x1 = snapFt(o.x1 + dxf);
    w.y1 = snapFt(o.y1 + dyf);
    w.x2 = snapFt(o.x2 + dxf);
    w.y2 = snapFt(o.y2 + dyf);
    renderDuringLayoutDrag();
    return;
  }

  if (state.drag.type === 'wall-endpoint') {
    const w = getWall(state.drag.id);
    const o = state.drag.orig;
    if (state.drag.endpoint === 'start') {
      w.x1 = snapFt(o.x1 + pxToFt(dx));
      w.y1 = snapFt(o.y1 + pxToFt(dy));
    } else {
      w.x2 = snapFt(o.x2 + pxToFt(dx));
      w.y2 = snapFt(o.y2 + pxToFt(dy));
    }
    renderDuringLayoutDrag();
    return;
  }

  if (state.drag.type === 'wall-draw') {
    const w = getWall(state.drag.id);
    const end = screenToWorld(pt.x, pt.y);
    w.x2 = snapFt(end.x);
    w.y2 = snapFt(end.y);
    renderDuringLayoutDrag();
  }
}

function dragMutatedLayout(drag) {
  if (!drag) return false;
  if (drag.type === 'item-move') {
    if (drag.origins) {
      return Object.entries(drag.origins).some(([id, orig]) => {
        const it = getItem(id);
        return it && (it.x !== orig.x || it.y !== orig.y);
      });
    }
    const item = getItem(drag.id);
    return item && (item.x !== drag.orig.x || item.y !== drag.orig.y);
  }
  if (drag.type === 'label-move') {
    const lbl = getRoomLabel(drag.id);
    return lbl && (lbl.x !== drag.orig.x || lbl.y !== drag.orig.y);
  }
  if (drag.type === 'wall-move' || drag.type === 'wall-endpoint') {
    const w = getWall(drag.id);
    const o = drag.orig;
    if (!w || !o) return false;
    return w.x1 !== o.x1 || w.y1 !== o.y1 || w.x2 !== o.x2 || w.y2 !== o.y2;
  }
  if (drag.type === 'bg-move' && drag.orig) {
    const bg = getBackgroundImage();
    return bg && (bg.x !== drag.orig.x || bg.y !== drag.orig.y);
  }
  if (drag.type === 'bg-resize' && drag.orig) {
    const bg = getBackgroundImage();
    return (
      bg &&
      (bg.x !== drag.orig.x ||
        bg.y !== drag.orig.y ||
        bg.width !== drag.orig.w ||
        bg.height !== drag.orig.h)
    );
  }
  if (drag.type === 'resize' && drag.orig) {
    const item = getItem(drag.id);
    return (
      item &&
      (item.x !== drag.orig.x ||
        item.y !== drag.orig.y ||
        item.w !== drag.orig.w ||
        item.h !== drag.orig.h)
    );
  }
  if (drag.type === 'rotate-drag') {
    const item = getItem(drag.id);
    return item && (item.rotation || 0) !== (drag.origRot || 0);
  }
  if (drag.type === 'wall-draw') {
    const w = getWall(drag.id);
    return w && (w.x1 !== w.x2 || w.y1 !== w.y2);
  }
  return true;
}

function onPointerUp(evt) {
  if (state.pinch) return;

  if (state.dragPending && !state.drag) {
    const pending = state.dragPending;
    finalizePendingPointer(evt, pending);
    revertPendingDrag();
    try {
      canvas()?.releasePointerCapture(evt.pointerId);
    } catch (_) {}
    return;
  }

  if (!state.drag && isMobileTouchUI()) {
    handleMobileTap(evt);
  }

  if (state.drag) {
    const historyTypes = [
      'item-move',
      'label-move',
      'resize',
      'bg-move',
      'bg-resize',
      'rotate-drag',
      'wall-move',
      'wall-endpoint',
      'wall-draw',
    ];
    const drag = state.drag;
    if (historyTypes.includes(drag.type)) {
      if (drag.type === 'item-move' && drag.origins) {
        Object.keys(drag.origins).forEach((id) => {
          const item = getItem(id);
          if (item) {
            item.x = snapFt(item.x);
            item.y = snapFt(item.y);
          }
        });
      } else if (drag.type === 'item-move') {
        const item = getItem(drag.id);
        if (item) {
          item.x = snapFt(item.x);
          item.y = snapFt(item.y);
        }
      } else if (drag.type === 'label-move') {
        const lbl = getRoomLabel(drag.id);
        if (lbl) {
          lbl.x = snapFt(lbl.x);
          lbl.y = snapFt(lbl.y);
        }
      } else if (drag.type === 'resize') {
        const item = getItem(drag.id);
        if (item) {
          item.x = snapFt(item.x);
          item.y = snapFt(item.y);
          item.w = snapFt(item.w);
          item.h = snapFt(item.h);
        }
      } else if (drag.type === 'bg-move') {
        const bg = getBackgroundImage();
        if (bg) {
          bg.x = snapFt(bg.x);
          bg.y = snapFt(bg.y);
        }
      } else if (drag.type === 'bg-resize') {
        const bg = getBackgroundImage();
        if (bg) {
          bg.x = snapFt(bg.x);
          bg.y = snapFt(bg.y);
          bg.width = snapFt(bg.width);
          bg.height = snapFt(bg.height);
        }
      } else if (drag.type === 'rotate-drag') {
        const item = getItem(drag.id);
        if (item) item.rotation = snapRotationDeg(item.rotation || 0, evt.shiftKey ? 15 : 5);
      }
      if (dragMutatedLayout(drag)) pushHistory();
    }
    state.drag = null;
    updatePanCursor();
    canvas()?.releasePointerCapture(evt.pointerId);
  }
}

function onWheel(evt) {
  evt.preventDefault();
  const delta = evt.deltaY > 0 ? 0.92 : 1.08;
  const pt = getSvgPoint(evt);
  const world = screenToWorld(pt.x, pt.y);
  state.zoom = Math.min(2.5, Math.max(0.4, state.zoom * delta));
  state.pan.x = pt.x - ftToPx(world.x);
  state.pan.y = pt.y - ftToPx(world.y);
  render();
}

function onDrop(evt) {
  evt.preventDefault();
  const type = evt.dataTransfer.getData('application/x-item-type');
  if (!type) return;
  const pt = getSvgPoint(evt);
  const w = screenToWorld(pt.x, pt.y);
  addItem(type, w.x - (CATALOG[type]?.w || 2) / 2, w.y - (CATALOG[type]?.h || 2) / 2);
}

function onLabelDblClick(evt) {
  if (state.mode !== 'furnish') return;
  const hit = hitTest(evt);
  if (hit?.kind !== 'label') return;
  evt.preventDefault();
  evt.stopPropagation();
  state.drag = null;
  selectOne('label', hit.id);
  focusLabelNameField();
}

/* —— Mode & UI —— */
function setMode(mode) {
  state.mode = mode;
  cancelMobileModes();
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  render();
  toast(mode === 'walls' ? 'Edit floorplan — Shift+drag to draw wall' : 'Furnish mode');
}

function catalogMatchesQuery(type, v, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    type.toLowerCase().includes(q) ||
    v.label.toLowerCase().includes(q) ||
    (v.category || '').toLowerCase().includes(q)
  );
}

function buildCatalog() {
  const root = $('#catalog-list');
  const query = state.catalogQuery;
  root.innerHTML = CATEGORIES.map((cat) => {
    const items = Object.entries(CATALOG).filter(
      ([type, v]) => v.category === cat.id && catalogMatchesQuery(type, v, query)
    );
    if (!items.length) return '';
    const buttons = items
      .map(
        ([type, v]) => `
      <button type="button" class="catalog-item" draggable="${isMobileTouchUI() ? 'false' : 'true'}" data-type="${type}" data-label="${v.label}">
        <span class="thumb ${v.round ? 'round' : ''}" style="width:${Math.min(28, v.w * 4)}px;height:${Math.min(20, v.h * 4)}px"></span>
        <span><span>${v.label}</span><br><span class="dims">${v.w}′×${v.h}′</span></span>
      </button>`
      )
      .join('');
    return `<details class="catalog-group" open><summary>${cat.label}</summary>${buttons}</details>`;
  }).join('');

  if (!root.innerHTML.trim()) {
    root.innerHTML = `<p class="empty-state">No catalog items match “${query}”.</p>`;
  }

  root.querySelectorAll('.catalog-item').forEach((btn) => {
    btn.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-item-type', btn.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
    });
    btn.addEventListener('click', () => {
      if (!isMobileTouchUI()) return;
      cancelPlacingLabel();
      state.placingCatalogType = btn.dataset.type;
      $('.canvas-wrap')?.classList.add('placing-item');
      collapseMobilePanelsForCanvas();
      toast(`Tap the floor to place ${btn.dataset.label}`);
    });
  });
}

function bindHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 's') {
      e.preventDefault();
      saveToLocal('autosave');
    } else if (mod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (mod && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      clearFloorplan();
    } else if (e.key === 'v' || e.key === 'V') setMode('furnish');
    else if (e.key === 'e' || e.key === 'E') setMode('walls');
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if (e.key === 'r' || e.key === 'R') rotateSelected(90);
    else if (e.key === 'Escape') {
      if (!cancelMobileModes()) clearSelection();
    }
    else if (e.key === 'd' && mod) {
      e.preventDefault();
      duplicateSelected();
    } else if (e.key === ']' && !mod) {
      const sel = primarySelection();
      if (sel?.kind === 'item') bringItemForward(sel.id);
    } else if (e.key === '[' && !mod) {
      const sel = primarySelection();
      if (sel?.kind === 'item') sendItemBackward(sel.id);
    } else if (e.key === '{' && !mod) {
      e.preventDefault();
      togglePanel('left');
    } else if (e.key === '}' && !mod) {
      e.preventDefault();
      togglePanel('right');
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (!state.spaceHeld) {
        state.spaceHeld = true;
        updatePanCursor();
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      nudgeSelected(-0.25, 0);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      nudgeSelected(0.25, 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      nudgeSelected(0, -0.25);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      nudgeSelected(0, 0.25);
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      state.spaceHeld = false;
      updatePanCursor();
    }
  });
}

function bindToolbarMore() {
  const wrap = $('#toolbar-more');
  const trigger = $('#btn-toolbar-more');
  if (!wrap || !trigger) return;

  const close = () => {
    wrap.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = wrap.classList.toggle('is-open');
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  wrap.querySelectorAll('.toolbar-more-menu .btn').forEach((btn) => {
    btn.addEventListener('click', close);
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

function bindUI() {
  initToolbarIcons();
  bindToolbarMore();
  $('#btn-mode-furnish')?.addEventListener('click', () => setMode('furnish'));
  $('#btn-mode-walls')?.addEventListener('click', () => setMode('walls'));
  $('#btn-undo')?.addEventListener('click', undo);
  $('#btn-redo')?.addEventListener('click', redo);
  $('#btn-save')?.addEventListener('click', () => saveToLocal('autosave'));
  $('#btn-export')?.addEventListener('click', exportJson);
  $('#btn-import')?.addEventListener('click', () => {
    $('#import-text').value = '';
    $('#modal-import').classList.remove('hidden');
    setAppModalOpen(true);
  });
  $('#btn-reset')?.addEventListener('click', resetDefault);
  $('#btn-clear')?.addEventListener('click', clearFloorplan);
  $('#btn-add-wall')?.addEventListener('click', () => {
    setMode('walls');
    if (isMobileTouchUI()) {
      state.wallDrawTool = true;
      collapseMobilePanelsForCanvas();
      toast('Drag on the canvas to draw a wall');
    } else {
      toast('Shift+drag on canvas to draw a new wall');
    }
  });
  $('#btn-add-label')?.addEventListener('click', () => {
    setMode('furnish');
    cancelPlacingCatalog();
    state.placingLabel = true;
    $('.canvas-wrap')?.classList.add('placing-label');
    if (isMobileTouchUI()) collapseMobilePanelsForCanvas();
    toast(isMobileTouchUI() ? 'Tap the canvas to place a label' : 'Click the canvas to place a label');
  });
  $('#btn-trace-image')?.addEventListener('click', () => {
    setMode('furnish');
    if (getBackgroundImage()?.src) {
      selectOne('background', BG_TRACE_ID);
      toast('Trace image selected — drag to move, corners to scale');
    } else {
      $('#bg-image-file')?.click();
    }
  });
  $('#bg-image-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadBackgroundImageFile(file);
    e.target.value = '';
  });
  document.addEventListener('paste', (e) => {
    if (e.target.matches('input, textarea')) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          setMode('furnish');
          loadBackgroundImageFile(file);
        }
        break;
      }
    }
  });
  $('#import-confirm')?.addEventListener('click', () => importJson($('#import-text').value));
  $('#import-cancel')?.addEventListener('click', () => {
    $('#modal-import').classList.add('hidden');
    setAppModalOpen(false);
  });
  $('#export-close')?.addEventListener('click', () => {
    $('#modal-export').classList.add('hidden');
    setAppModalOpen(false);
  });
  $('#export-copy')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#export-text').value);
    toast('Copied to clipboard');
  });

  $('#btn-share')?.addEventListener('click', () => {
    sync.shareNewPlan(syncDeps(), toast).then(() => refreshSessionsPanel());
  });
  $('#btn-leave-session')?.addEventListener('click', () => {
    const loc = new URL(window.location.href);
    loc.searchParams.delete('plan');
    loc.searchParams.delete('planId');
    window.history.replaceState({}, '', loc);
    location.reload();
  });

  $('#catalog-search')?.addEventListener('input', (e) => {
    state.catalogQuery = e.target.value.trim();
    buildCatalog();
  });

  const bindPanelToggle = (side) => {
    const toggle = () => togglePanel(side);
    $(`#btn-panel-${side}`)?.addEventListener('click', toggle);
    $(`#panel-toggle-${side}`)?.addEventListener('click', toggle);
  };
  bindPanelToggle('left');
  bindPanelToggle('right');

  const wrap = $('.canvas-wrap');
  const svg = canvas();
  const blockSelect = (e) => e.preventDefault();
  wrap?.addEventListener('selectstart', blockSelect);
  wrap?.addEventListener('pointerdown', onPointerDown);
  wrap?.addEventListener('pointermove', onPointerMove);
  wrap?.addEventListener('pointerleave', hideWallLengthTip);
  wrap?.addEventListener('pointerup', onPointerUp);
  wrap?.addEventListener('pointercancel', onPointerUp);
  bindMobileTouch();
  svg?.addEventListener('contextmenu', (e) => e.preventDefault());
  svg?.addEventListener('auxclick', (e) => e.preventDefault());
  svg?.addEventListener('wheel', onWheel, { passive: false });
  svg?.addEventListener('dragover', (e) => e.preventDefault());
  svg?.addEventListener('drop', onDrop);
  svg?.addEventListener('dblclick', onLabelDblClick);

  document.body.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-item-type')) e.preventDefault();
  });
}

function resizeCanvas() {
  const wrap = $('.canvas-wrap');
  const svg = canvas();
  svg.setAttribute('width', wrap.clientWidth);
  svg.setAttribute('height', wrap.clientHeight);
  render();
}

function fitPlanToView(paddingFt = 2) {
  const wrap = $('.canvas-wrap');
  if (!wrap || wrap.clientWidth <= 0 || wrap.clientHeight <= 0) return;

  const walls = state.layout.walls || [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  walls.forEach((w) => {
    minX = Math.min(minX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2);
    maxX = Math.max(maxX, w.x1, w.x2);
    maxY = Math.max(maxY, w.y1, w.y2);
  });
  if (!Number.isFinite(minX)) {
    const { width, height } = state.layout.bounds;
    minX = 0;
    minY = 0;
    maxX = width;
    maxY = height;
  }

  const pad = paddingFt;
  const wFt = Math.max(1, maxX - minX + pad * 2);
  const hFt = Math.max(1, maxY - minY + pad * 2);
  const zoomX = wrap.clientWidth / (wFt * PX_PER_FT);
  const zoomY = wrap.clientHeight / (hFt * PX_PER_FT);
  state.zoom = Math.min(2.5, Math.max(0.4, Math.min(zoomX, zoomY) * 0.92));

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  state.pan.x = wrap.clientWidth / 2 - cx * PX_PER_FT * state.zoom;
  state.pan.y = wrap.clientHeight / 2 - cy * PX_PER_FT * state.zoom;
  render();
}

async function init() {
  loadPanelState();
  buildCatalog();

  const planParam = sync.getPlanIdFromLocation();
  if (planParam) {
    await sync.startPlanSession(planParam, syncDeps());
  } else {
    if (!tryLoadAutosave()) state.layout = createDefaultLayout();
    pushHistory();
  }

  bindUI();
  bindHotkeys();
  sync.bindDisplayNameInput();
  refreshSessionsPanel();
  applyPanelState();
  ensureMobileLayout();
  requestAnimationFrame(() => ensureMobileLayout());
  window.addEventListener('resize', resizeCanvas);
  window.matchMedia(MOBILE_MQ).addEventListener('change', (e) => {
    if (e.matches) ensureMobileLayout();
  });
  setMode('furnish');
}

init().catch((e) => console.error(e));
