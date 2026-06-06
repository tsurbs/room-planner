/**
 * 2D floor lightmap: per-cell additive lighting with grid LOS occlusion and soft area lights.
 */

import {
  applyInteriorMask,
  applyWallExclusion,
  buildInteriorMask,
  buildWallOcclusionGrid,
  diskSamplePoints,
  findInteriorSeed,
  worldLineOfSight,
} from './lighting-geometry.js';
import {
  kelvinToLinearRgb,
  linearRgbToSrgb,
  LIGHT_QUALITY,
  DEFAULT_LIGHT_QUALITY,
  wallsInLightingRegion,
  maxLightRadiusFt,
} from './lighting.js';

/** @typedef {{ width: number, height: number, cellsPerFt: number, regionX: number, regionY: number, data: Uint8ClampedArray }} LightmapResult */

function lightFalloff(distanceFt, radiusFt, intensity) {
  if (distanceFt >= radiusFt) return 0;
  const t = 1 - distanceFt / radiusFt;
  return intensity * t * t;
}

/** Box blur RGBA (separable 3-tap, two passes). */
function blurLightmap(data, width, height) {
  const tmp = new Uint8ClampedArray(data.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let n = 0;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            sum += data[(y * width + nx) * 4 + c];
            n++;
          }
          tmp[(y * width + x) * 4 + c] = Math.round(sum / n);
        }
        tmp[(y * width + x) * 4 + 3] = 255;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            sum += tmp[(ny * width + x) * 4 + c];
            n++;
          }
          data[(y * width + x) * 4 + c] = Math.round(sum / n);
        }
        data[(y * width + x) * 4 + 3] = 255;
      }
    }
  }
}

/**
 * @param {object} layout
 * @param {{ x: number, y: number, width: number, height: number }} region
 * @param {{ quality?: keyof typeof LIGHT_QUALITY, seed?: number }} options
 * @returns {LightmapResult}
 */
export function computeLightmap(layout, region, options = {}) {
  const qualityKey = options.quality || DEFAULT_LIGHT_QUALITY;
  const q = LIGHT_QUALITY[qualityKey] || LIGHT_QUALITY.normal;
  const cellsPerFt = q.cellsPerFt;
  const softSamples = q.softSamples;
  const ambient = q.ambient;
  const sampleSeed = options.seed ?? 0;

  const gridW = Math.max(1, Math.ceil(region.width * cellsPerFt));
  const gridH = Math.max(1, Math.ceil(region.height * cellsPerFt));
  const cellSize = 1 / cellsPerFt;

  const margin = maxLightRadiusFt(layout);
  const walls = wallsInLightingRegion(layout.walls || [], region, margin);

  const occGrid = buildWallOcclusionGrid(gridW, gridH, region, cellsPerFt, walls);
  const interiorSeed = findInteriorSeed(layout, region, cellsPerFt);
  const interiorMask = buildInteriorMask(
    gridW,
    gridH,
    region,
    cellsPerFt,
    walls,
    interiorSeed.x,
    interiorSeed.y
  );
  const lights = layout.lights || [];

  const lightData = lights.map((light, li) => ({
    samples: diskSamplePoints(light.x, light.y, (light.sizeFt || 0.75) / 2, softSamples, sampleSeed + li * 0.31),
    rgb: kelvinToLinearRgb(light.kelvin),
    intensity: light.intensity ?? 0.75,
    radiusFt: light.radiusFt ?? 8,
  }));

  const data = new Uint8ClampedArray(gridW * gridH * 4);

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const px = region.x + (gx + 0.5) * cellSize;
      const py = region.y + (gy + 0.5) * cellSize;

      let lr = ambient * 0.04;
      let lg = ambient * 0.05;
      let lb = ambient * 0.07;

      const cellIdx = gy * gridW + gx;
      if (!interiorMask[cellIdx]) {
        const idx = cellIdx * 4;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 0;
        continue;
      }

      for (const ld of lightData) {
        let visSum = 0;
        let contribR = 0;
        let contribG = 0;
        let contribB = 0;

        for (const sample of ld.samples) {
          const dist = Math.hypot(px - sample.x, py - sample.y);
          const att = lightFalloff(dist, ld.radiusFt, ld.intensity);
          if (att <= 0) continue;

          if (
            worldLineOfSight(occGrid, gridW, gridH, region, cellsPerFt, px, py, sample.x, sample.y)
          ) {
            visSum += 1;
            contribR += ld.rgb[0] * att;
            contribG += ld.rgb[1] * att;
            contribB += ld.rgb[2] * att;
          }
        }

        if (visSum > 0 && ld.samples.length) {
          const w = visSum / ld.samples.length;
          lr += contribR * w;
          lg += contribG * w;
          lb += contribB * w;
        }
      }

      const idx = (gy * gridW + gx) * 4;
      const [sr, sg, sb] = linearRgbToSrgb(lr, lg, lb);
      data[idx] = sr;
      data[idx + 1] = sg;
      data[idx + 2] = sb;
      data[idx + 3] = 255;
    }
  }

  applyWallExclusion(data, occGrid, gridW, gridH, 2);
  if (qualityKey !== 'draft') {
    blurLightmap(data, gridW, gridH);
  }
  applyWallExclusion(data, occGrid, gridW, gridH, 2);
  applyInteriorMask(data, interiorMask, gridW, gridH);

  return {
    width: gridW,
    height: gridH,
    cellsPerFt,
    regionX: region.x,
    regionY: region.y,
    data,
  };
}
