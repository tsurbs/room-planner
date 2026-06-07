/**
 * Grid occlusion for lightmap line-of-sight.
 * Only walls participate in LOS; furniture/items are intentionally excluded.
 */

const EPS = 1e-9;
const WALL_THICK_CELLS = 1;

/** Stratified disk sample points around light center (area light). */
export function diskSamplePoints(cx, cy, radius, count, seed = 0) {
  /** @type {{ x: number, y: number }[]} */
  const pts = [];
  if (count <= 1 || radius < EPS) {
    pts.push({ x: cx, y: cy });
    return pts;
  }
  for (let i = 0; i < count; i++) {
    const angle = ((i + 0.5) / count) * Math.PI * 2 + seed * 0.17;
    const r = radius * Math.sqrt((i + 0.5) / count);
    pts.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }
  return pts;
}

function worldToGrid(wx, wy, region, cellsPerFt) {
  return {
    gx: Math.floor((wx - region.x) * cellsPerFt),
    gy: Math.floor((wy - region.y) * cellsPerFt),
  };
}

function markCell(grid, gridW, gridH, gx, gy, value = 1) {
  if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) return;
  grid[gy * gridW + gx] = value;
}

/** Bresenham line on grid; all cells including endpoints block light. */
function rasterizeLine(grid, gridW, gridH, gx0, gy0, gx1, gy1) {
  let x0 = gx0;
  let y0 = gy0;
  const x1 = gx1;
  const y1 = gy1;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  /** @type {{ gx: number, gy: number }[]} */
  const cells = [];
  for (;;) {
    cells.push({ gx: x0, gy: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }

  for (let i = 0; i < cells.length; i++) {
    const { gx, gy } = cells[i];
    markCell(grid, gridW, gridH, gx, gy, 1);
    for (let t = 1; t <= WALL_THICK_CELLS; t++) {
      markCell(grid, gridW, gridH, gx + t, gy, 1);
      markCell(grid, gridW, gridH, gx - t, gy, 1);
      markCell(grid, gridW, gridH, gx, gy + t, 1);
      markCell(grid, gridW, gridH, gx, gy - t, 1);
    }
  }
}

/**
 * Occupancy grid for occlusion (1 = blocked). Only walls block light.
 * @param {number} gridW
 * @param {number} gridH
 * @param {{ x: number, y: number, width: number, height: number }} region
 * @param {number} cellsPerFt
 * @param {object[]} walls
 */
export function buildWallOcclusionGrid(gridW, gridH, region, cellsPerFt, walls) {
  const grid = new Uint8Array(gridW * gridH);
  for (const w of walls || []) {
    const a = worldToGrid(w.x1, w.y1, region, cellsPerFt);
    const b = worldToGrid(w.x2, w.y2, region, cellsPerFt);
    rasterizeLine(grid, gridW, gridH, a.gx, a.gy, b.gx, b.gy);
  }
  return grid;
}

/** @deprecated Use buildWallOcclusionGrid */
export const buildOcclusionGrid = buildWallOcclusionGrid;

/** Bresenham LOS on occlusion grid (excludes start; allows arrival at target). */
export function gridLineOfSight(grid, gridW, gridH, gx0, gy0, gx1, gy1) {
  let x0 = gx0;
  let y0 = gy0;
  const x1 = gx1;
  const y1 = gy1;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let first = true;

  for (;;) {
    if (!first) {
      if (x0 === x1 && y0 === y1) return true;
      if (x0 < 0 || y0 < 0 || x0 >= gridW || y0 >= gridH) return false;
      if (grid[y0 * gridW + x0]) return false;
    }
    first = false;
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
  return true;
}

export function worldLineOfSight(grid, gridW, gridH, region, cellsPerFt, ox, oy, tx, ty) {
  const a = worldToGrid(ox, oy, region, cellsPerFt);
  const b = worldToGrid(tx, ty, region, cellsPerFt);
  if (a.gx === b.gx && a.gy === b.gy) return true;
  return gridLineOfSight(grid, gridW, gridH, a.gx, a.gy, b.gx, b.gy);
}

/** Pick a world point inside the floor plan (not on a wall cell). */
export function findInteriorSeed(layout, region, cellsPerFt) {
  const walls = layout.walls || [];
  const gridW = Math.max(1, Math.ceil(region.width * cellsPerFt));
  const gridH = Math.max(1, Math.ceil(region.height * cellsPerFt));
  const occ = buildWallOcclusionGrid(gridW, gridH, region, cellsPerFt, walls);

  /** @type {{ x: number, y: number }[]} */
  const candidates = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const w of walls) {
    minX = Math.min(minX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2);
    maxX = Math.max(maxX, w.x1, w.x2);
    maxY = Math.max(maxY, w.y1, w.y2);
  }
  if (Number.isFinite(minX)) {
    candidates.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  }
  for (const l of layout.lights || []) candidates.push({ x: l.x, y: l.y });
  for (const r of layout.roomLabels || []) {
    candidates.push({ x: r.x + (r.w || 2) / 2, y: r.y + (r.h || 2) / 2 });
  }
  const b = layout.bounds;
  if (b) candidates.push({ x: b.width / 2, y: b.height / 2 });

  for (const c of candidates) {
    const gx = Math.floor((c.x - region.x) * cellsPerFt);
    const gy = Math.floor((c.y - region.y) * cellsPerFt);
    if (gx >= 0 && gy >= 0 && gx < gridW && gy < gridH && !occ[gy * gridW + gx]) return c;
  }

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (!occ[gy * gridW + gx]) {
        return {
          x: region.x + (gx + 0.5) / cellsPerFt,
          y: region.y + (gy + 0.5) / cellsPerFt,
        };
      }
    }
  }

  return { x: region.x + region.width / 2, y: region.y + region.height / 2 };
}

/** Flood-fill reachable open cells from an interior seed (1 = inside floor plan). */
export function buildInteriorMask(gridW, gridH, region, cellsPerFt, walls, seedWx, seedWy) {
  const occ = buildWallOcclusionGrid(gridW, gridH, region, cellsPerFt, walls);
  const mask = new Uint8Array(gridW * gridH);
  const sgx = Math.floor((seedWx - region.x) * cellsPerFt);
  const sgy = Math.floor((seedWy - region.y) * cellsPerFt);
  if (sgx < 0 || sgy < 0 || sgx >= gridW || sgy >= gridH || occ[sgy * gridW + sgx]) return mask;

  const stack = [sgx, sgy];
  mask[sgy * gridW + sgx] = 1;
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    visit(x - 1, y);
    visit(x + 1, y);
    visit(x, y - 1);
    visit(x, y + 1);
  }

  function visit(x, y) {
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return;
    const i = y * gridW + x;
    if (mask[i] || occ[i]) return;
    mask[i] = 1;
    stack.push(x, y);
  }

  return mask;
}

function applyInteriorMask(data, mask, gridW, gridH) {
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (mask[gy * gridW + gx]) continue;
      const idx = (gy * gridW + gx) * 4;
      data[idx] = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
      data[idx + 3] = 0;
    }
  }
}

/** Clear pixels on/near wall cells so blur cannot bleed light through walls. */
function applyWallExclusion(data, occGrid, gridW, gridH, dilate = 2) {
  const blocked = new Uint8Array(gridW * gridH);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (!occGrid[gy * gridW + gx]) continue;
      for (let dy = -dilate; dy <= dilate; dy++) {
        for (let dx = -dilate; dx <= dilate; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
          blocked[ny * gridW + nx] = 1;
        }
      }
    }
  }
  for (let i = 0; i < gridW * gridH; i++) {
    if (!blocked[i]) continue;
    const idx = i * 4;
    data[idx] = 0;
    data[idx + 1] = 0;
    data[idx + 2] = 0;
    data[idx + 3] = 0;
  }
}

/**
 * Grow a binary mask outward by `radius` cells (Chebyshev/square).
 * Used so the lit area extends across wall cells right up to the walls,
 * instead of leaving a dark moat where occluded cells were masked out.
 * @returns {Uint8Array} a new dilated mask
 */
function dilateMask(mask, gridW, gridH, radius = 2) {
  if (radius <= 0) return mask;
  const out = new Uint8Array(mask.length);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (!mask[gy * gridW + gx]) continue;
      const y0 = Math.max(0, gy - radius);
      const y1 = Math.min(gridH - 1, gy + radius);
      const x0 = Math.max(0, gx - radius);
      const x1 = Math.min(gridW - 1, gx + radius);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          out[ny * gridW + nx] = 1;
        }
      }
    }
  }
  return out;
}

export { applyInteriorMask, applyWallExclusion, dilateMask };
