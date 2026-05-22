/**
 * Multiplayer sync: PartyKit WebSocket + plan snapshot API.
 * @see README — meta `room-planner-partykit`, optional `room-planner-api-base`, LWW semantics.
 */
import {
  cloneLayout,
  validateLayout,
  createEmptyLayout,
} from './default-layout.js';

const BG_SYNC_WARN_LEN = 500_000;
const PRESENCE_MS = 45;
const PEER_STALE_MS = 18_000;
const LAYOUT_PREVIEW_MS = 50;
const LAYOUT_COMMIT_MS = 100;
const SESSION_NAME_KEY = 'room-planner-display-name';
const SESSION_PEER_KEY = 'room-planner-peer-id';
const RECENT_PLANS_KEY = 'room-planner-recent-plans';
const MAX_RECENT_PLANS = 10;

let planId = null;
/** @type {WebSocket | null} */
let ws = null;
let syncedRevision = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let commitTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let previewTimer = null;
/** @type {number | null} */
let lastPresence = 0;
/** @type {{ getState: () => any, render: () => void, pushHistory: () => void, cloneLayout: (l: any) => any, validateLayout: (l: any) => boolean, toast: (m: string) => void, updateUndoButtons: () => void } | null} */
let deps = null;

/** @type {Map<string, { worldX: number, worldY: number, name: string, color: string, dragging?: boolean, targetKind?: string, targetId?: string, at: number }>} */
const peers = new Map();

let connectionStatus = 'offline';

function getMetaPartyHost() {
  const el = document.querySelector('meta[name="room-planner-partykit"]');
  const meta = el?.getAttribute('content')?.trim() || '';
  if (meta) return meta;
  const w = typeof window !== 'undefined' && window.__RP_PARTYKIT_HOST__;
  return typeof w === 'string' ? w.trim() : '';
}

/** Same-origin `/api/plans` by default; set meta or window.__RP_API_BASE__ when static hosting hits a deployed API. */
function getPlansApiOrigin() {
  const el = document.querySelector('meta[name="room-planner-api-base"]');
  const meta = el?.getAttribute('content')?.trim() ?? '';
  if (meta) return meta.replace(/\/+$/, '');
  const w = typeof window !== 'undefined' && window.__RP_API_BASE__;
  return typeof w === 'string' ? w.trim().replace(/\/+$/, '') : '';
}

function planApiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const base = getPlansApiOrigin();
  if (!base) return p;
  return `${base}${p}`;
}

export function getPlanIdFromLocation() {
  const q = new URLSearchParams(window.location.search);
  return q.get('plan') || q.get('planId') || '';
}

export function isPlanSessionActive() {
  return !!planId;
}

export function getSyncConnectionStatus() {
  return connectionStatus;
}

export function stripHeavyBackgroundForSync(layout, toast) {
  const c = cloneLayout(layout);
  const src = c.backgroundImage?.src;
  if (typeof src === 'string' && src.length > BG_SYNC_WARN_LEN) {
    delete c.backgroundImage;
    toast?.(
      'Trace image omitted from sync (too large). Export JSON or shrink image to share.'
    );
  }
  return c;
}

function ensurePeerId() {
  let id = sessionStorage.getItem(SESSION_PEER_KEY);
  if (!id) {
    id = `p-${Math.random().toString(36).slice(2, 12)}`;
    sessionStorage.setItem(SESSION_PEER_KEY, id);
  }
  return id;
}

export function getDisplayName() {
  const inp = document.querySelector('#sync-display-name');
  if (inp && inp.value?.trim()) return inp.value.trim();
  let n = sessionStorage.getItem(SESSION_NAME_KEY);
  if (!n) {
    n = `Guest-${Math.floor(100 + Math.random() * 900)}`;
    sessionStorage.setItem(SESSION_NAME_KEY, n);
  }
  return n;
}

export function bindDisplayNameInput() {
  const inp = document.querySelector('#sync-display-name');
  if (!inp) return;
  const saved = sessionStorage.getItem(SESSION_NAME_KEY);
  if (saved) inp.value = saved;
  inp.addEventListener('change', () => {
    const v = inp.value.trim() || getDisplayName();
    sessionStorage.setItem(SESSION_NAME_KEY, v);
    inp.value = v;
  });
}

function colorForPeer(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `hsl(${(h >>> 0) % 360}, 65%, 42%)`;
}

function setBadge(text, mode = '') {
  const el = document.querySelector('#sync-badge');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('sync-badge--ok', 'sync-badge--warn', 'sync-badge--bad');
  if (mode === 'ok') el.classList.add('sync-badge--ok');
  else if (mode === 'warn') el.classList.add('sync-badge--warn');
  else if (mode === 'bad') el.classList.add('sync-badge--bad');
}

function updateBadgeFromWs() {
  if (!planId) return;
  const host = getMetaPartyHost();
  if (!host) {
    setBadge('Offline (set party meta)', 'bad');
    return;
  }
  if (connectionStatus === 'live') {
    const n = peers.size;
    setBadge(n ? `Synced · ${n} online` : 'Synced', 'ok');
  } else if (connectionStatus === 'connecting') {
    setBadge('Connecting…', 'warn');
  } else {
    setBadge('Offline', 'bad');
  }
}

function cachePlan(id, layout, revision) {
  try {
    localStorage.setItem(
      `plan-cache:${id}`,
      JSON.stringify({ layout, revision, cachedAt: new Date().toISOString() })
    );
  } catch (_) {}
}

function readCache(id) {
  try {
    const raw = localStorage.getItem(`plan-cache:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function partyWsUrl(id) {
  const base = getMetaPartyHost();
  if (!base) return '';
  try {
    const u = new URL('/parties/plan/' + encodeURIComponent(id), base);
    return u.href;
  } catch {
    return '';
  }
}

async function fetchPlanSnapshot(id) {
  let res;
  try {
    res = await fetch(planApiUrl(`/api/plans/${encodeURIComponent(id)}`));
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function layoutSyncFingerprint(layout) {
  return JSON.stringify(stripHeavyBackgroundForSync(cloneLayout(layout)));
}

function filterSelectionToLayout(selection, layout) {
  if (!selection?.length) return [];
  return selection.filter((sel) => {
    if (sel.kind === 'item') {
      return layout.items?.some((it) => it.id === sel.id);
    }
    if (sel.kind === 'wall') {
      return layout.walls?.some((w) => w.id === sel.id);
    }
    if (sel.kind === 'label') {
      return (layout.roomLabels || []).some((r) => r.id === sel.id);
    }
    if (sel.kind === 'background') {
      return !!layout.backgroundImage?.src;
    }
    return false;
  });
}

/** Entity ids the local user is actively dragging (not merely selected). */
function getActiveDragIds(st) {
  const drag = st.drag;
  if (!drag) {
    return { items: new Set(), walls: new Set(), labels: new Set(), background: false };
  }
  const t = drag.type;
  const items = new Set();
  const walls = new Set();
  const labels = new Set();
  if (t === 'item-move' || t === 'resize' || t === 'rotate-drag') {
    if (drag.origins) Object.keys(drag.origins).forEach((id) => items.add(id));
    else if (drag.id) items.add(drag.id);
  } else if (t === 'wall-move' || t === 'wall-endpoint') {
    walls.add(drag.id);
  } else if (t === 'label-move') {
    labels.add(drag.id);
  } else if (t === 'bg-move' || t === 'bg-resize') {
    return { items, walls, labels, background: true };
  }
  return { items, walls, labels, background: false };
}

/** Apply remote layout but keep in-flight local drag poses (selection alone does not lock). */
function mergeRemoteWithLocalDrag(st, remoteLayout) {
  const merged = deps.cloneLayout(remoteLayout);
  const active = getActiveDragIds(st);
  if (
    !active.items.size &&
    !active.walls.size &&
    !active.labels.size &&
    !active.background
  ) {
    return merged;
  }
  active.items.forEach((id) => {
    const local = st.layout.items?.find((it) => it.id === id);
    const remote = merged.items?.find((it) => it.id === id);
    if (local && remote) {
      remote.x = local.x;
      remote.y = local.y;
      remote.w = local.w;
      remote.h = local.h;
      remote.rotation = local.rotation;
    }
  });
  active.walls.forEach((id) => {
    const local = st.layout.walls?.find((w) => w.id === id);
    const remote = merged.walls?.find((w) => w.id === id);
    if (local && remote) {
      remote.x1 = local.x1;
      remote.y1 = local.y1;
      remote.x2 = local.x2;
      remote.y2 = local.y2;
    }
  });
  active.labels.forEach((id) => {
    const local = st.layout.roomLabels?.find((r) => r.id === id);
    const remote = merged.roomLabels?.find((r) => r.id === id);
    if (local && remote) {
      remote.x = local.x;
      remote.y = local.y;
    }
  });
  if (active.background && st.layout.backgroundImage) {
    merged.backgroundImage = deps.cloneLayout({
      backgroundImage: st.layout.backgroundImage,
    }).backgroundImage;
  }
  return merged;
}

function applyRemoteState(layout, revision, updatedAt) {
  if (!deps) return;
  const st = deps.getState();
  if (typeof revision === 'number' && revision < syncedRevision) return;
  if (!deps.validateLayout(layout)) return;

  const remoteBase = deps.cloneLayout(layout);
  const incomingFp = layoutSyncFingerprint(remoteBase);
  const localFp = layoutSyncFingerprint(st.layout);
  const revisionAdvanced =
    typeof revision === 'number' && revision > syncedRevision;

  if (!revisionAdvanced && incomingFp === localFp) {
    if (typeof revision === 'number') syncedRevision = revision;
    return;
  }

  const nextLayout = mergeRemoteWithLocalDrag(st, remoteBase);
  const preservedSelection = filterSelectionToLayout(st.selection, nextLayout);
  st.layout = nextLayout;
  st.selection = preservedSelection;
  st.history = [deps.cloneLayout(st.layout)];
  st.historyIndex = 0;
  deps.updateUndoButtons();
  if (typeof revision === 'number') syncedRevision = revision;
  deps.render();
  if (planId) cachePlan(planId, st.layout, syncedRevision);
  const uAt = updatedAt ? ` · ${new Date(updatedAt).toLocaleString()}` : '';
  setStatusLine(`Cloud + live${uAt}`);
}

function setStatusLine(msg) {
  const el = document.querySelector('#sync-saved');
  if (el) el.textContent = msg;
}

export function listRecentPlans() {
  try {
    const raw = localStorage.getItem(RECENT_PLANS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function recordRecentPlan(id, label) {
  if (!id) return;
  const name =
    (typeof label === 'string' && label.trim()) ||
    (typeof id === 'string' && id.slice(0, 8)) ||
    'Plan';
  const entry = { id, label: name, openedAt: new Date().toISOString() };
  const prev = listRecentPlans().filter((p) => p.id !== id);
  prev.unshift(entry);
  try {
    localStorage.setItem(
      RECENT_PLANS_KEY,
      JSON.stringify(prev.slice(0, MAX_RECENT_PLANS))
    );
  } catch (_) {}
}

export async function joinPlanSession(id, d, toastFn) {
  if (!id) return;
  const loc = new URL(window.location.href);
  loc.searchParams.set('plan', id);
  window.history.replaceState({}, '', loc);
  recordRecentPlan(id);
  try {
    await startPlanSession(id, d);
    toastFn?.('Joined shared plan');
  } catch {
    toastFn?.('Could not join — check PartyKit meta and reload');
  }
}

export async function startPlanSession(id, d) {
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
    ws = null;
  }
  peers.clear();

  planId = id;
  deps = d;
  syncedRevision = 0;
  recordRecentPlan(id, d.getState()?.layout?.name);
  bindDisplayNameInput();

  let snap = await fetchPlanSnapshot(id);
  if (!snap) {
    const c = readCache(id);
    if (c?.layout && validateLayout(c.layout)) {
      snap = {
        layout: c.layout,
        revision: c.revision || 1,
        updatedAt: c.cachedAt,
      };
      d.toast?.('Loaded cached plan (server unreachable)');
    }
  }
  if (snap?.layout && validateLayout(snap.layout)) {
    const st = d.getState();
    st.layout = d.cloneLayout(snap.layout);
    st.selection = [];
    syncedRevision = typeof snap.revision === 'number' ? snap.revision : 1;
    st.history = [d.cloneLayout(st.layout)];
    st.historyIndex = 0;
    d.updateUndoButtons();
    d.render();
    cachePlan(id, st.layout, syncedRevision);
    setStatusLine(`Cloud snapshot · rev ${syncedRevision}`);
  } else {
    const st = d.getState();
    st.layout = createEmptyLayout();
    st.selection = [];
    syncedRevision = 1;
    st.history = [d.cloneLayout(st.layout)];
    st.historyIndex = 0;
    d.updateUndoButtons();
    d.render();
    cachePlan(id, st.layout, syncedRevision);
    setStatusLine('Blank plan (create & share)');
  }

  const url = partyWsUrl(id);
  if (!url) {
    connectionStatus = 'offline';
    setBadge('Offline-only (no PartyKit host)', 'bad');
    setStatusLine('Shared plan · offline-only');
    return;
  }

  connectionStatus = 'connecting';
  updateBadgeFromWs();
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    connectionStatus = 'live';
    updateBadgeFromWs();
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'state' && msg.layout) {
      const rev =
        typeof msg.revision === 'number' ? msg.revision : syncedRevision;
      applyRemoteState(msg.layout, rev, msg.updatedAt);
      updateBadgeFromWs();
    } else if (msg.type === 'presence' && msg.peerId) {
      peers.set(msg.peerId, {
        worldX: Number(msg.worldX) || 0,
        worldY: Number(msg.worldY) || 0,
        name: String(msg.name || 'Guest'),
        color: msg.color || colorForPeer(msg.peerId),
        dragging: !!msg.dragging,
        targetKind: msg.targetKind,
        targetId: msg.targetId,
        at: Date.now(),
      });
      prunePeers();
      deps?.render();
      updateBadgeFromWs();
    }
  });

  ws.addEventListener('close', () => {
    connectionStatus = 'offline';
    updateBadgeFromWs();
  });
  ws.addEventListener('error', () => {
    connectionStatus = 'offline';
    updateBadgeFromWs();
  });
}

function prunePeers() {
  const now = Date.now();
  for (const [k, v] of peers) {
    if (now - v.at > PEER_STALE_MS) peers.delete(k);
  }
}

function sendLayoutPayload() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !deps || !planId) return;
  const st = deps.getState();
  const prepared = stripHeavyBackgroundForSync(st.layout, deps.toast);
  const updatedAt = new Date().toISOString();
  cachePlan(planId, prepared, syncedRevision);
  ws.send(
    JSON.stringify({
      type: 'layout',
      layout: prepared,
      revision: syncedRevision,
      updatedAt,
    })
  );
}

function flushLayoutSyncTimers() {
  if (commitTimer) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
}

/** Debounced layout broadcast after committed edits (undo, property changes, drag end). */
export function onLocalEdit() {
  scheduleLayoutSync({ immediate: false });
}

/** Throttled layout broadcast while dragging or resizing (live furniture sync). */
export function onLayoutPreview() {
  if (!planId || !deps) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    requestAnimationFrame(() => sendLayoutPayload());
  }, LAYOUT_PREVIEW_MS);
}

export function scheduleLayoutSync({ immediate = false } = {}) {
  if (!planId || !deps) return;
  if (immediate) {
    flushLayoutSyncTimers();
    requestAnimationFrame(() => sendLayoutPayload());
    return;
  }
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    requestAnimationFrame(() => sendLayoutPayload());
  }, LAYOUT_COMMIT_MS);
}

export function presenceTick(worldX, worldY) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !deps || !planId) return;
  const now = Date.now();
  if (now - lastPresence < PRESENCE_MS) return;
  lastPresence = now;
  const st = deps.getState();
  let targetKind;
  let targetId;
  const dt = st.drag?.type || '';
  if (dt.startsWith('item')) {
    targetKind = 'item';
    targetId = st.drag.id;
  } else if (dt.startsWith('wall')) {
    targetKind = 'wall';
    targetId = st.drag.id;
  } else if (dt.startsWith('label')) {
    targetKind = 'label';
    targetId = st.drag.id;
  } else if (dt.startsWith('bg')) {
    targetKind = 'background';
    targetId = 'trace';
  }
  ws.send(
    JSON.stringify({
      type: 'presence',
      peerId: ensurePeerId(),
      name: getDisplayName(),
      color: colorForPeer(ensurePeerId()),
      worldX,
      worldY,
      dragging: !!st.drag,
      targetKind,
      targetId,
    })
  );
}

const svgNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const node = document.createElementNS(svgNS, tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.setAttribute('class', v);
    else if (v != null) node.setAttribute(k, v);
  });
  return node;
}

export function renderPeers(svg, worldToScreen) {
  if (!svg || !planId || !getMetaPartyHost()) return;
  prunePeers();
  let layer = svg.querySelector('#sync-peers');
  if (!layer) {
    layer = el('g', { id: 'sync-peers', class: 'sync-peers' });
    svg.appendChild(layer);
  }
  layer.innerHTML = '';
  const myId = ensurePeerId();
  peers.forEach((p, pid) => {
    if (pid === myId) return;
    const scr = worldToScreen(p.worldX, p.worldY);
    const g = el('g', {
      class: 'sync-peer',
      transform: `translate(${scr.x}, ${scr.y})`,
    });
    const tri = el('path', {
      d: 'M0,-11 L9,7 L-9,7 Z',
      fill: p.color,
      stroke: 'rgba(255,255,255,0.9)',
      'stroke-width': 1,
      class: 'sync-peer-cursor',
    });
    g.appendChild(tri);
    const text = el('text', {
      x: 11,
      y: 4,
      class: 'sync-peer-name',
      fill: p.color,
    });
    text.textContent = p.name;
    g.appendChild(text);
    layer.appendChild(g);
  });
}

/**
 * @param {Parameters<typeof startPlanSession>[1]} d
 */
export async function shareNewPlan(d, toastFn) {
  const postUrl = planApiUrl('/api/plans');
  let res;
  try {
    res = await fetch(postUrl, { method: 'POST', mode: 'cors' });
  } catch {
    toastFn?.(
      'Share unavailable (network). Use the deployed app, run vercel dev, or open via http (not file:).'
    );
    return;
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const hint = typeof payload?.hint === 'string' ? payload.hint : '';
    const errTxt = typeof payload?.error === 'string' ? payload.error : '';
    const detail = hint || errTxt;
    /** Static/http.server hits usually 404 `/api/plans`, often with an HTML body (parse → null). */
    const looksMissingApiRoute =
      res.status === 404 ||
      (payload == null &&
        Number.isFinite(res.status) &&
        res.status >= 400 &&
        res.status < 500);
    if (looksMissingApiRoute) {
      toastFn?.(
        'Share needs /api/plans (not available on plain localhost:8080). Run vercel dev or use the deployed site; optional: meta room-planner-api-base pointing at production.'
      );
    } else if (res.status === 503 || res.status >= 500) {
      toastFn?.(
        detail
          ? `Share failed — ${detail}`
          : 'Share failed — cloud storage unavailable. Set KV_REST_API_URL and KV_REST_API_TOKEN on Vercel.'
      );
    } else {
      toastFn?.(detail ? `Could not share — ${detail}` : 'Could not create shared plan');
    }
    return;
  }

  const { id } = payload || {};
  if (!id) {
    toastFn?.('Invalid plan response');
    return;
  }
  const shareLoc = new URL(window.location.href);
  shareLoc.searchParams.set('plan', id);
  window.history.replaceState({}, '', shareLoc);
  try {
    await navigator.clipboard.writeText(shareLoc.toString());
    toastFn?.('Share link copied');
  } catch {
    toastFn?.(`Share link: ?plan=${id}`);
  }
  recordRecentPlan(id);
  try {
    await startPlanSession(id, d);
  } catch {
    toastFn?.('Share link updated, but live session failed to start. Reload or check PartyKit/meta.');
  }
}
