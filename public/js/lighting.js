/** Light fixture presets and color-temperature helpers for the 2D floor-plan view. */

/** @typedef {{ label: string, sizeFt: number, radiusFt: number, kelvin: number }} LightPreset */

/** @type {Record<string, LightPreset>} */
export const LIGHT_TYPES = {
  'recessed-s': {
    label: 'Recessed (small)',
    sizeFt: 0.75,
    radiusFt: 6,
    kelvin: 3000,
  },
  'recessed-l': {
    label: 'Recessed (large)',
    sizeFt: 1.25,
    radiusFt: 9,
    kelvin: 3500,
  },
  pendant: {
    label: 'Pendant',
    sizeFt: 1.5,
    radiusFt: 8,
    kelvin: 3000,
  },
  chandelier: {
    label: 'Chandelier',
    sizeFt: 2.5,
    radiusFt: 14,
    kelvin: 2700,
  },
  'floor-lamp': {
    label: 'Floor lamp',
    sizeFt: 1.5,
    radiusFt: 7,
    kelvin: 2700,
  },
  track: {
    label: 'Track spot',
    sizeFt: 0.6,
    radiusFt: 5,
    kelvin: 4000,
  },
};

export const KELVIN_MIN = 2000;
export const KELVIN_MAX = 6500;

const KELVIN_PRESETS = [
  { value: 2200, label: 'Candle' },
  { value: 2700, label: 'Warm white' },
  { value: 3000, label: 'Soft white' },
  { value: 3500, label: 'Neutral warm' },
  { value: 4000, label: 'Cool white' },
  { value: 5000, label: 'Daylight' },
  { value: 6500, label: 'Overcast' },
];

/** Approximate black-body RGB for plan-view glow (Tanner Helland). */
export function kelvinToRgb(kelvin) {
  const k = Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, kelvin));
  const temp = k / 100;
  let r;
  let g;
  let b;

  if (temp <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
  }

  if (temp >= 66) {
    b = 255;
  } else if (temp <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  }

  return [
    Math.round(Math.max(0, Math.min(255, r))),
    Math.round(Math.max(0, Math.min(255, g))),
    Math.round(Math.max(0, Math.min(255, b))),
  ];
}

export function kelvinToCss(kelvin) {
  const [r, g, b] = kelvinToRgb(kelvin);
  return `rgb(${r}, ${g}, ${b})`;
}

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  const x = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}

/** Kelvin → linear RGB in 0–1 for additive light accumulation. */
export function kelvinToLinearRgb(kelvin) {
  const [r, g, b] = kelvinToRgb(kelvin);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

export function linearRgbToSrgb(r, g, b) {
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

export const LIGHT_QUALITY = {
  draft: { cellsPerFt: 2, softSamples: 3, ambient: 0.03 },
  normal: { cellsPerFt: 4, softSamples: 8, ambient: 0.035 },
  high: { cellsPerFt: 6, softSamples: 12, ambient: 0.04 },
};

export const DEFAULT_LIGHT_QUALITY = 'normal';

export function kelvinLabel(kelvin) {
  let best = KELVIN_PRESETS[0];
  let bestDist = Math.abs(kelvin - best.value);
  for (const preset of KELVIN_PRESETS) {
    const dist = Math.abs(kelvin - preset.value);
    if (dist < bestDist) {
      best = preset;
      bestDist = dist;
    }
  }
  return best.label;
}

export function getLightPreset(type) {
  return LIGHT_TYPES[type] || LIGHT_TYPES['recessed-s'];
}

/** @param {object} light */
export function normalizeLight(light) {
  const preset = getLightPreset(light.type);
  if (typeof light.sizeFt !== 'number') light.sizeFt = preset.sizeFt;
  if (typeof light.radiusFt !== 'number') light.radiusFt = preset.radiusFt;
  if (typeof light.kelvin !== 'number') light.kelvin = preset.kelvin;
  if (typeof light.intensity !== 'number') light.intensity = 0.75;
  light.kelvin = Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, light.kelvin));
  light.intensity = Math.max(0.1, Math.min(1, light.intensity));
  light.sizeFt = Math.max(0.4, light.sizeFt);
  light.radiusFt = Math.max(2, light.radiusFt);
  if (typeof light.z !== 'number' || !Number.isFinite(light.z)) light.z = 1000;
  return light;
}

export function createLight(type, x, y, id) {
  const preset = getLightPreset(type);
  return normalizeLight({
    id,
    type,
    x,
    y,
    sizeFt: preset.sizeFt,
    radiusFt: preset.radiusFt,
    kelvin: preset.kelvin,
    intensity: 0.75,
  });
}

export function lightMatchesQuery(type, preset, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    type.toLowerCase().includes(q) ||
    preset.label.toLowerCase().includes(q) ||
    q.includes('light') ||
    q.includes('lamp') ||
    q.includes('kelvin')
  );
}

export const LIGHTING_REGION_PADDING_FT = 6;
export const LIGHTING_REGION_MIN_FT = 12;

/** @typedef {{ x: number, y: number, width: number, height: number }} LightingRegion */

/** @param {object} layout @returns {LightingRegion} */
export function computeDefaultLightingRegion(layout) {
  const pad = LIGHTING_REGION_PADDING_FT;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const w of layout.walls || []) {
    minX = Math.min(minX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2);
    maxX = Math.max(maxX, w.x1, w.x2);
    maxY = Math.max(maxY, w.y1, w.y2);
  }
  for (const l of layout.lights || []) {
    const r = l.radiusFt ?? 8;
    minX = Math.min(minX, l.x - r);
    minY = Math.min(minY, l.y - r);
    maxX = Math.max(maxX, l.x + r);
    maxY = Math.max(maxY, l.y + r);
  }

  const b = layout.bounds;
  if (b) {
    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = b.width;
      maxY = b.height;
    } else {
      minX = Math.min(minX, 0);
      minY = Math.min(minY, 0);
      maxX = Math.max(maxX, b.width);
      maxY = Math.max(maxY, b.height);
    }
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 42;
    maxY = 42;
  }

  return {
    x: minX - pad,
    y: minY - pad,
    width: Math.max(LIGHTING_REGION_MIN_FT, maxX - minX + pad * 2),
    height: Math.max(LIGHTING_REGION_MIN_FT, maxY - minY + pad * 2),
  };
}

/** @param {object} layout @returns {LightingRegion} */
export function ensureLightingRegion(layout) {
  const r = layout.lightingRegion;
  if (r && typeof r.width === 'number' && typeof r.height === 'number') return r;
  layout.lightingRegion = computeDefaultLightingRegion(layout);
  return layout.lightingRegion;
}

/** Grow the stored region so every light (plus radius) stays inside the compute area. */
export function expandLightingRegionForLights(layout) {
  const r = ensureLightingRegion(layout);
  const pad = LIGHTING_REGION_PADDING_FT;
  let minX = r.x;
  let minY = r.y;
  let maxX = r.x + r.width;
  let maxY = r.y + r.height;
  let changed = false;

  for (const l of layout.lights || []) {
    const rad = l.radiusFt ?? 8;
    const lx0 = l.x - rad - pad;
    const ly0 = l.y - rad - pad;
    const lx1 = l.x + rad + pad;
    const ly1 = l.y + rad + pad;
    if (lx0 < minX) {
      minX = lx0;
      changed = true;
    }
    if (ly0 < minY) {
      minY = ly0;
      changed = true;
    }
    if (lx1 > maxX) {
      maxX = lx1;
      changed = true;
    }
    if (ly1 > maxY) {
      maxY = ly1;
      changed = true;
    }
  }

  if (!changed) return false;

  layout.lightingRegion = {
    x: minX,
    y: minY,
    width: Math.max(LIGHTING_REGION_MIN_FT, maxX - minX),
    height: Math.max(LIGHTING_REGION_MIN_FT, maxY - minY),
  };
  return true;
}

export function maxLightRadiusFt(layout) {
  const lights = layout.lights || [];
  if (!lights.length) return 14;
  return Math.max(...lights.map((l) => l.radiusFt ?? 8));
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSeg(ax, ay, bx, by, cx, cy) {
  return (
    Math.min(ax, bx) - 1e-9 <= cx &&
    cx <= Math.max(ax, bx) + 1e-9 &&
    Math.min(ay, by) - 1e-9 <= cy &&
    cy <= Math.max(ay, by) + 1e-9
  );
}

function segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const o1 = orient(x1, y1, x2, y2, x3, y3);
  const o2 = orient(x1, y1, x2, y2, x4, y4);
  const o3 = orient(x3, y3, x4, y4, x1, y1);
  const o4 = orient(x3, y3, x4, y4, x2, y2);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (Math.abs(o1) < 1e-9 && onSeg(x1, y1, x2, y2, x3, y3)) return true;
  if (Math.abs(o2) < 1e-9 && onSeg(x1, y1, x2, y2, x4, y4)) return true;
  if (Math.abs(o3) < 1e-9 && onSeg(x3, y3, x4, y4, x1, y1)) return true;
  if (Math.abs(o4) < 1e-9 && onSeg(x3, y3, x4, y4, x2, y2)) return true;
  return false;
}

function wallIntersectsRect(wall, rx, ry, rw, rh) {
  if (
    (wall.x1 >= rx && wall.x1 <= rx + rw && wall.y1 >= ry && wall.y1 <= ry + rh) ||
    (wall.x2 >= rx && wall.x2 <= rx + rw && wall.y2 >= ry && wall.y2 <= ry + rh)
  ) {
    return true;
  }
  const x2 = rx + rw;
  const y2 = ry + rh;
  const edges = [
    [rx, ry, x2, ry],
    [x2, ry, x2, y2],
    [x2, y2, rx, y2],
    [rx, y2, rx, ry],
  ];
  for (const [ax, ay, bx, by] of edges) {
    if (segmentsIntersect(wall.x1, wall.y1, wall.x2, wall.y2, ax, ay, bx, by)) return true;
  }
  return false;
}

/** Walls that can cast shadows inside the lighting region. */
export function wallsInLightingRegion(walls, region, marginFt = 0) {
  const rx = region.x - marginFt;
  const ry = region.y - marginFt;
  const rw = region.width + marginFt * 2;
  const rh = region.height + marginFt * 2;
  return (walls || []).filter((w) => wallIntersectsRect(w, rx, ry, rw, rh));
}
