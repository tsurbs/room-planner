/**
 * Canvas overlay for computed floor lightmap, synced to SVG pan/zoom.
 */

import { DEFAULT_LIGHT_QUALITY } from './lighting.js';

let worker = null;
let jobId = 0;
let pendingJob = null;
let debounceTimer = null;
let lastResult = null;

/** @type {((pan: {x:number,y:number}, zoom: number, pxPerFt: number) => void) | null} */
let viewSync = null;

/** @type {(() => { layout: object, region: object, show: boolean }) | null} */
let stateProvider = null;

let quality = DEFAULT_LIGHT_QUALITY;

const DEBOUNCE_MS = 120;

/** Layout fields used by lightmap compute — items are intentionally omitted. */
function lightingLayoutSlice(layout) {
  return {
    walls: layout.walls,
    lights: layout.lights,
    roomLabels: layout.roomLabels,
    bounds: layout.bounds,
    lightingRegion: layout.lightingRegion,
  };
}

function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./lighting-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      console.error('lighting worker error', e);
    };
  } catch (err) {
    console.warn('Lighting worker unavailable, using main thread', err);
    worker = null;
  }
  return worker;
}

function onWorkerMessage(evt) {
  const msg = evt.data;
  if (msg.id !== pendingJob?.id) return;
  pendingJob = null;
  if (!msg.ok) {
    console.error('Lightmap compute failed:', msg.error);
    return;
  }
  lastResult = {
    width: msg.width,
    height: msg.height,
    cellsPerFt: msg.cellsPerFt,
    regionX: msg.regionX,
    regionY: msg.regionY,
    data: new Uint8ClampedArray(msg.data),
  };
  drawLightmap();
}

async function computeOnMainThread(layout, region, options, id) {
  const { computeLightmap } = await import('./lighting-simulator.js');
  if (pendingJob?.id !== id) return;
  const result = computeLightmap(layout, region, options);
  if (pendingJob?.id !== id) return;
  pendingJob = null;
  lastResult = result;
  drawLightmap();
}

function scheduleCompute(immediate = false) {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const run = () => {
    const ctx = stateProvider?.();
    if (!ctx?.show || !ctx.layout || !ctx.region) {
      hideCanvas();
      return;
    }
    const lights = ctx.layout.lights || [];
    if (!lights.length) {
      hideCanvas();
      return;
    }

    const id = ++jobId;
    pendingJob = { id };
    const options = { quality, seed: id * 0.013 };

    const w = getWorker();
    const layoutSlice = structuredClone(lightingLayoutSlice(ctx.layout));
    if (w) {
      w.postMessage({
        id,
        layout: layoutSlice,
        region: { ...ctx.region },
        options,
      });
    } else {
      computeOnMainThread(layoutSlice, ctx.region, options, id);
    }
  };

  if (immediate) run();
  else debounceTimer = setTimeout(run, DEBOUNCE_MS);
}

function canvasEl() {
  return document.getElementById('lighting-canvas');
}

function hideCanvas() {
  const c = canvasEl();
  if (c) c.style.visibility = 'hidden';
  lastResult = null;
}

function drawLightmap() {
  const c = canvasEl();
  if (!c || !lastResult || !viewSync) return;

  const { pan, zoom, pxPerFt } = viewSync();
  const { width, height, cellsPerFt, regionX, regionY, data } = lastResult;

  const wrap = c.parentElement;
  if (!wrap) return;
  const wrapW = wrap.clientWidth;
  const wrapH = wrap.clientHeight;
  if (c.width !== wrapW || c.height !== wrapH) {
    c.width = wrapW;
    c.height = wrapH;
  }

  const ctx = c.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, wrapW, wrapH);

  const cellWorld = 1 / cellsPerFt;
  const cellPx = cellWorld * pxPerFt * zoom;

  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) return;
  offCtx.putImageData(new ImageData(data, width, height), 0, 0);

  const destX = pan.x + regionX * pxPerFt * zoom;
  const destY = pan.y + regionY * pxPerFt * zoom;
  const destW = width * cellPx;
  const destH = height * cellPx;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(offscreen, 0, 0, width, height, destX, destY, destW, destH);

  c.style.visibility = 'visible';
}

/** @param {() => { layout, region, show }} provider */
export function initLightingCanvas(provider) {
  stateProvider = provider;
}

/** @param {(pan, zoom, pxPerFt) => object} fn */
export function setLightingViewSync(fn) {
  viewSync = fn;
}

export function setLightingQuality(q) {
  quality = q || DEFAULT_LIGHT_QUALITY;
  invalidateLighting(true);
}

export function getLightingQuality() {
  return quality;
}

/** @param {boolean} immediate */
export function invalidateLighting(immediate = false) {
  scheduleCompute(immediate);
}

export function syncLightingCanvas() {
  drawLightmap();
}

export function setLightingDraftMode(draft) {
  quality = draft ? 'draft' : DEFAULT_LIGHT_QUALITY;
  invalidateLighting(false);
}

export function destroyLightingCanvas() {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (worker) {
    worker.terminate();
    worker = null;
  }
  hideCanvas();
}
