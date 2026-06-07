/**
 * Canvas overlay for computed floor lightmap, synced to SVG pan/zoom.
 * Uses WebGL2 shadow maps when hardware acceleration is enabled; otherwise CPU worker.
 */

import { DEFAULT_LIGHT_QUALITY } from './lighting.js';
import { isLightingHardwareAccelEnabled } from './lighting-settings.js';
import { createLightingGpu } from './lighting-gl.js';

let worker = null;
let jobId = 0;
let pendingJob = null;
let debounceTimer = null;
let lastResult = null;
/** @type {import('./lighting-gl.js').LightingGpu | null} */
let gpu = null;
let gpuFailed = false;
let hardwareAccel = isLightingHardwareAccelEnabled();

/** @type {((pan: {x:number,y:number}, zoom: number, pxPerFt: number) => void) | null} */
let viewSync = null;

/** @type {(() => { layout: object, region: object, show: boolean }) | null} */
let stateProvider = null;

/** Quality the user picked in Properties — what we render at rest. */
let userQuality = DEFAULT_LIGHT_QUALITY;
/** True while an object/wall/region is being dragged. */
let interacting = false;
let rafHandle = 0;

const DEBOUNCE_MS = 120;

/**
 * Quality to actually compute at right now.
 * GPU is fast enough to keep full quality live during drags; the CPU path
 * drops to draft while interacting to stay responsive.
 */
function effectiveQuality() {
  return interacting && !useGpuPath() ? 'draft' : userQuality;
}

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

function useGpuPath() {
  return hardwareAccel && !gpuFailed;
}

function canvas2dEl() {
  return document.getElementById('lighting-canvas');
}

function canvasGlEl() {
  return document.getElementById('lighting-canvas-gl');
}

function ensureGpu() {
  if (!useGpuPath()) return null;
  if (gpu?.isReady()) return gpu;
  const c = canvasGlEl();
  if (!c) return null;
  gpu = createLightingGpu(c);
  if (!gpu.isReady()) {
    gpu.destroy();
    gpu = null;
    gpuFailed = true;
    console.warn('Lighting GPU unavailable — using CPU lightmap');
    return null;
  }
  return gpu;
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
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
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
    const options = { quality: effectiveQuality(), seed: id * 0.013 };
    const layoutSlice = structuredClone(lightingLayoutSlice(ctx.layout));
    const region = { ...ctx.region };

    if (useGpuPath()) {
      const renderer = ensureGpu();
      if (renderer) {
        try {
          const ok = renderer.compute(layoutSlice, region, options);
          if (pendingJob?.id !== id) return;
          pendingJob = null;
          if (ok) {
            lastResult = null;
            drawLightmap();
            return;
          }
        } catch (err) {
          console.warn('Lighting GPU compute failed, falling back to CPU', err);
          gpuFailed = true;
          if (gpu) {
            gpu.destroy();
            gpu = null;
          }
        }
      }
    }

    const w = getWorker();
    if (w) {
      w.postMessage({ id, layout: layoutSlice, region, options });
    } else {
      computeOnMainThread(layoutSlice, region, options, id);
    }
  };

  if (immediate) {
    run();
  } else if (interacting && useGpuPath()) {
    // GPU recompute is sub-millisecond — coalesce to one update per frame so
    // dragging a light/wall updates the lightmap in real time.
    rafHandle = requestAnimationFrame(() => {
      rafHandle = 0;
      run();
    });
  } else {
    debounceTimer = setTimeout(run, DEBOUNCE_MS);
  }
}

function hideCanvas() {
  const c2d = canvas2dEl();
  const cgl = canvasGlEl();
  if (c2d) c2d.style.visibility = 'hidden';
  if (cgl) cgl.style.visibility = 'hidden';
  lastResult = null;
}

function drawLightmap() {
  if (!viewSync) return;

  const { pan, zoom, pxPerFt } = viewSync();
  const c2d = canvas2dEl();
  const cgl = canvasGlEl();

  if (useGpuPath() && gpu?.isReady() && gpu.meta) {
    if (c2d) c2d.style.visibility = 'hidden';
    if (cgl) {
      gpu.draw(pan, zoom, pxPerFt);
      cgl.style.visibility = 'visible';
    }
    return;
  }

  if (!c2d || !lastResult) return;
  if (cgl) cgl.style.visibility = 'hidden';

  const { width, height, cellsPerFt, regionX, regionY, data } = lastResult;

  const wrap = c2d.parentElement;
  if (!wrap) return;
  const wrapW = wrap.clientWidth;
  const wrapH = wrap.clientHeight;
  if (c2d.width !== wrapW || c2d.height !== wrapH) {
    c2d.width = wrapW;
    c2d.height = wrapH;
  }

  const ctx = c2d.getContext('2d');
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

  c2d.style.visibility = 'visible';
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
  userQuality = q || DEFAULT_LIGHT_QUALITY;
  invalidateLighting(true);
}

export function getLightingQuality() {
  return userQuality;
}

export function isLightingHardwareAccelOn() {
  return hardwareAccel;
}

/** @param {boolean} enabled */
export function setLightingHardwareAccel(enabled) {
  const next = !!enabled;
  if (next === hardwareAccel) return;
  hardwareAccel = next;
  gpuFailed = false;
  if (!next && gpu) {
    gpu.destroy();
    gpu = null;
  }
  invalidateLighting(true);
}

/** @param {boolean} immediate */
export function invalidateLighting(immediate = false) {
  scheduleCompute(immediate);
}

export function syncLightingCanvas() {
  drawLightmap();
}

/**
 * Toggle interactive (drag) mode. While interacting the lightmap recomputes
 * live: full quality on the GPU path, draft quality on the CPU fallback.
 * @param {boolean} active
 */
export function setLightingInteracting(active) {
  const next = !!active;
  if (next === interacting) return;
  interacting = next;
  // Recompute immediately when a drag ends so we settle on full quality at once.
  invalidateLighting(!next);
}

/** @deprecated Back-compat alias for {@link setLightingInteracting}. */
export function setLightingDraftMode(active) {
  setLightingInteracting(active);
}

export function destroyLightingCanvas() {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
  if (gpu) {
    gpu.destroy();
    gpu = null;
  }
  hideCanvas();
}
