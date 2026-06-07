/**
 * WebGL2 floor-lightmap renderer.
 *
 * Produces the same per-cell soft-shadow lightmap as `lighting-simulator.js`,
 * but evaluates every cell in parallel on the GPU and keeps the result in a
 * texture so pan/zoom only re-draws a quad (no per-frame CPU upload).
 *
 * The CPU occlusion grid + interior flood-fill are reused verbatim so the GPU
 * and CPU paths stay visually consistent; only the expensive per-cell light /
 * soft-sample / line-of-sight loops move to the fragment shader.
 *
 * createLightingGpu(canvas) -> {
 *   isReady(): boolean,
 *   compute(layout, region, options): boolean,  // false => caller falls back to CPU
 *   draw(pan, zoom, pxPerFt): void,
 *   meta: object | null,
 *   destroy(): void,
 * }
 */

import {
  buildWallOcclusionGrid,
  buildInteriorMask,
  dilateMask,
  findInteriorSeed,
} from './lighting-geometry.js';
import {
  kelvinToLinearRgb,
  LIGHT_QUALITY,
  DEFAULT_LIGHT_QUALITY,
  wallsInLightingRegion,
  maxLightRadiusFt,
} from './lighting.js';

/** @typedef {{ width:number, height:number, cellsPerFt:number, regionX:number, regionY:number }} GpuLightmapMeta */

const MAX_GRID_DIM = 2048; // guard against pathological region sizes

const VERT_SRC = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // Fullscreen triangle; vUv spans 0..1 across the target.
  vec2 p = vec2((gl_VertexID == 2) ? 3.0 : -1.0, (gl_VertexID == 1) ? 3.0 : -1.0);
  vUv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

function lightingFragSrc(maxLights) {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uOcc;    // R8: 1 = wall (blocks light)
uniform sampler2D uMask;   // R8: 1 = interior floor cell
uniform ivec2 uGrid;       // grid width, height (cells)
uniform vec2 uRegionOrigin;// region.x, region.y (ft)
uniform float uCellSize;   // ft per cell (1 / cellsPerFt)
uniform float uCellsPerFt;
uniform float uAmbient;
uniform int uSampleCount;
uniform float uSeed;
uniform int uLightCount;

// xy = position (ft), z = intensity, w = radius (ft)
uniform vec4 uLightPos[${maxLights}];
// rgb = linear color, w = disk radius (ft) for soft area sampling
uniform vec4 uLightCol[${maxLights}];

const float PI2 = 6.28318530718;
const int MAX_RAY_STEPS = 4096;
// Occ/mask textures are R8 storing 0 or 1, so a "set" texel reads as 1/255.
const float SET = 0.5 / 255.0;

bool occAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= uGrid.x || c.y >= uGrid.y) return false;
  return texelFetch(uOcc, c, 0).r > SET;
}

// Bresenham line-of-sight on the occlusion grid.
// Mirrors gridLineOfSight(): start cell excluded, target occlusion ignored,
// any intermediate wall cell blocks. Returns true if the sample is visible.
bool visible(ivec2 p0, ivec2 p1) {
  int dx = int(abs(float(p1.x - p0.x)));
  int dy = int(abs(float(p1.y - p0.y)));
  int sx = p0.x < p1.x ? 1 : -1;
  int sy = p0.y < p1.y ? 1 : -1;
  int err = dx - dy;
  int x = p0.x;
  int y = p0.y;
  bool first = true;
  for (int i = 0; i < MAX_RAY_STEPS; i++) {
    if (!first) {
      if (x == p1.x && y == p1.y) return true;
      if (x < 0 || y < 0 || x >= uGrid.x || y >= uGrid.y) return false;
      if (texelFetch(uOcc, ivec2(x, y), 0).r > SET) return false;
    }
    first = false;
    if (x == p1.x && y == p1.y) return true;
    int e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return true;
}

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  vec3 s = mix(hi, lo, step(c, vec3(0.0031308)));
  return clamp(s, 0.0, 1.0);
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  if (cell.x >= uGrid.x || cell.y >= uGrid.y) { outColor = vec4(0.0); return; }

  // Cells outside the dilated interior (true exterior) are fully transparent.
  // The mask is grown across wall cells on the CPU so light reaches the walls.
  if (texelFetch(uMask, cell, 0).r < SET) { outColor = vec4(0.0); return; }

  vec2 worldP = uRegionOrigin + (vec2(cell) + 0.5) * uCellSize;

  // Ambient base (matches CPU tint).
  vec3 accum = vec3(uAmbient * 0.04, uAmbient * 0.05, uAmbient * 0.07);

  for (int li = 0; li < ${maxLights}; li++) {
    if (li >= uLightCount) break;
    vec4 lp = uLightPos[li];
    vec4 lc = uLightCol[li];
    float intensity = lp.z;
    float radiusFt = lp.w;
    float diskR = lc.w;

    float sumAtt = 0.0;
    int visCount = 0;

    for (int si = 0; si < 64; si++) {
      if (si >= uSampleCount) break;

      // Stratified disk sample — identical formula to diskSamplePoints().
      vec2 samplePos;
      if (uSampleCount <= 1 || diskR < 1e-6) {
        samplePos = lp.xy;
      } else {
        float fi = (float(si) + 0.5) / float(uSampleCount);
        float angle = fi * PI2 + uSeed * 0.17;
        float r = diskR * sqrt(fi);
        samplePos = lp.xy + vec2(cos(angle), sin(angle)) * r;
      }

      float dist = distance(worldP, samplePos);
      if (dist >= radiusFt) continue;
      float t = 1.0 - dist / radiusFt;
      float att = intensity * t * t;
      if (att <= 0.0) continue;

      ivec2 sCell = ivec2(floor((samplePos - uRegionOrigin) * uCellsPerFt));
      if (cell == sCell || visible(cell, sCell)) {
        sumAtt += att;
        visCount++;
      }
    }

    if (visCount > 0) {
      float w = float(visCount) / float(uSampleCount);
      accum += lc.rgb * sumAtt * w;
    }
  }

  outColor = vec4(linearToSrgb(accum), 1.0);
}`;
}

const BLUR_FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSrc;
uniform sampler2D uOcc;
uniform sampler2D uMask;
uniform ivec2 uGrid;
uniform ivec2 uDir;      // (1,0) horizontal or (0,1) vertical
uniform int uFinalize;   // 1 on last pass: re-apply exterior mask

const float SET = 0.5 / 255.0;

bool occAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= uGrid.x || c.y >= uGrid.y) return false;
  return texelFetch(uOcc, c, 0).r > SET;
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  if (cell.x >= uGrid.x || cell.y >= uGrid.y) { outColor = vec4(0.0); return; }

  // 3-tap box blur with edge clamp (matches CPU separable blur).
  vec3 sum = vec3(0.0);
  float n = 0.0;
  for (int k = -1; k <= 1; k++) {
    ivec2 c = cell + uDir * k;
    if (c.x < 0 || c.y < 0 || c.x >= uGrid.x || c.y >= uGrid.y) continue;
    sum += texelFetch(uSrc, c, 0).rgb;
    n += 1.0;
  }
  vec3 blurred = n > 0.0 ? sum / n : vec3(0.0);

  if (uFinalize == 1 && texelFetch(uMask, cell, 0).r < SET) {
    outColor = vec4(0.0);
    return;
  }
  outColor = vec4(blurred, 1.0);
}`;

const DISPLAY_VERT_SRC = `#version 300 es
precision highp float;
in vec2 aClip;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aClip, 0.0, 1.0);
}`;

const DISPLAY_FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() {
  outColor = texture(uTex, vUv);
}`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader compile failed: ' + log);
  }
  return sh;
}

function linkProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('program link failed: ' + log);
  }
  return prog;
}

function makeGridTexture(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createLightingGpu(canvas) {
  let ready = false;
  /** @type {WebGL2RenderingContext | null} */
  let gl = null;
  /** @type {GpuLightmapMeta | null} */
  let meta = null;

  let lightProg = null;
  let blurProg = null;
  let displayProg = null;
  let vao = null;
  let displayVao = null;
  let quadBuf = null;

  // Grid-sized resources (recreated when the grid changes size).
  let occTex = null;
  let maskTex = null;
  let texA = null;
  let texB = null;
  let fbo = null;
  let gridW = 0;
  let gridH = 0;
  /** Texture holding the final lightmap to display. */
  let resultTex = null;

  let MAX_LIGHTS = 32;
  let lightPosBuf = new Float32Array(0);
  let lightColBuf = new Float32Array(0);

  // Cached uniform locations.
  let lu = null;
  let bu = null;
  let du = null;

  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');

    const maxVecs = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) || 224;
    // 2 vec4 per light; leave headroom for the other scalar/ivec uniforms.
    MAX_LIGHTS = Math.max(8, Math.min(64, Math.floor((maxVecs - 24) / 2)));
    lightPosBuf = new Float32Array(MAX_LIGHTS * 4);
    lightColBuf = new Float32Array(MAX_LIGHTS * 4);

    lightProg = linkProgram(gl, VERT_SRC, lightingFragSrc(MAX_LIGHTS));
    blurProg = linkProgram(gl, VERT_SRC, BLUR_FRAG_SRC);
    displayProg = linkProgram(gl, DISPLAY_VERT_SRC, DISPLAY_FRAG_SRC);

    vao = gl.createVertexArray(); // attribute-less fullscreen triangle
    fbo = gl.createFramebuffer();

    // Display quad: clip xy + uv, updated per draw.
    displayVao = gl.createVertexArray();
    quadBuf = gl.createBuffer();
    gl.bindVertexArray(displayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 16 * 4, gl.DYNAMIC_DRAW);
    const aClip = gl.getAttribLocation(displayProg, 'aClip');
    const aUv = gl.getAttribLocation(displayProg, 'aUv');
    gl.enableVertexAttribArray(aClip);
    gl.vertexAttribPointer(aClip, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    lu = {
      occ: gl.getUniformLocation(lightProg, 'uOcc'),
      mask: gl.getUniformLocation(lightProg, 'uMask'),
      grid: gl.getUniformLocation(lightProg, 'uGrid'),
      origin: gl.getUniformLocation(lightProg, 'uRegionOrigin'),
      cellSize: gl.getUniformLocation(lightProg, 'uCellSize'),
      cellsPerFt: gl.getUniformLocation(lightProg, 'uCellsPerFt'),
      ambient: gl.getUniformLocation(lightProg, 'uAmbient'),
      sampleCount: gl.getUniformLocation(lightProg, 'uSampleCount'),
      seed: gl.getUniformLocation(lightProg, 'uSeed'),
      lightCount: gl.getUniformLocation(lightProg, 'uLightCount'),
      lightPos: gl.getUniformLocation(lightProg, 'uLightPos'),
      lightCol: gl.getUniformLocation(lightProg, 'uLightCol'),
    };
    bu = {
      src: gl.getUniformLocation(blurProg, 'uSrc'),
      occ: gl.getUniformLocation(blurProg, 'uOcc'),
      mask: gl.getUniformLocation(blurProg, 'uMask'),
      grid: gl.getUniformLocation(blurProg, 'uGrid'),
      dir: gl.getUniformLocation(blurProg, 'uDir'),
      finalize: gl.getUniformLocation(blurProg, 'uFinalize'),
    };
    du = { tex: gl.getUniformLocation(displayProg, 'uTex') };

    ready = true;
  } catch (err) {
    console.warn('Lighting GPU init failed:', err?.message || err);
    ready = false;
  }

  function ensureGridResources(w, h) {
    if (w === gridW && h === gridH && occTex && maskTex && texA && texB) return;
    // Tear down old grid textures.
    for (const t of [occTex, maskTex, texA, texB]) if (t) gl.deleteTexture(t);
    gridW = w;
    gridH = h;
    occTex = gl.createTexture();
    maskTex = gl.createTexture();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const t of [occTex, maskTex]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    texA = makeGridTexture(gl, w, h);
    texB = makeGridTexture(gl, w, h);
  }

  function uploadGridTexture(tex, data, w, h) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  function renderToTex(tex) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, gridW, gridH);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * @param {object} layout
   * @param {{x:number,y:number,width:number,height:number}} region
   * @param {{quality?:string, seed?:number}} options
   * @returns {boolean}
   */
  function compute(layout, region, options = {}) {
    if (!ready || !gl) return false;

    const qualityKey = options.quality || DEFAULT_LIGHT_QUALITY;
    const q = LIGHT_QUALITY[qualityKey] || LIGHT_QUALITY.normal;
    const cellsPerFt = q.cellsPerFt;
    const softSamples = q.softSamples;
    const ambient = q.ambient;
    const seed = options.seed ?? 0;

    const w = Math.max(1, Math.ceil(region.width * cellsPerFt));
    const h = Math.max(1, Math.ceil(region.height * cellsPerFt));
    if (w > MAX_GRID_DIM || h > MAX_GRID_DIM) return false;

    const lights = layout.lights || [];
    if (!lights.length) return false;
    if (lights.length > MAX_LIGHTS) return false; // too many for uniform path → CPU

    const margin = maxLightRadiusFt(layout);
    const walls = wallsInLightingRegion(layout.walls || [], region, margin);
    const occGrid = buildWallOcclusionGrid(w, h, region, cellsPerFt, walls);
    const seedPt = findInteriorSeed(layout, region, cellsPerFt);
    const mask = buildInteriorMask(w, h, region, cellsPerFt, walls, seedPt.x, seedPt.y);
    // Grow the kept area across wall cells so the lightmap reaches the walls
    // (no dark moat). Walls still occlude via LOS + their grid thickness.
    const wallSpan = Math.max(2, Math.round(cellsPerFt * 0.6));
    const keepMask = dilateMask(mask, w, h, wallSpan);

    ensureGridResources(w, h);
    uploadGridTexture(occTex, occGrid, w, h);
    uploadGridTexture(maskTex, keepMask, w, h);

    // Pack light uniforms.
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      const rgb = kelvinToLinearRgb(l.kelvin);
      const base = i * 4;
      lightPosBuf[base] = l.x;
      lightPosBuf[base + 1] = l.y;
      lightPosBuf[base + 2] = l.intensity ?? 0.75;
      lightPosBuf[base + 3] = l.radiusFt ?? 8;
      lightColBuf[base] = rgb[0];
      lightColBuf[base + 1] = rgb[1];
      lightColBuf[base + 2] = rgb[2];
      lightColBuf[base + 3] = (l.sizeFt || 0.75) / 2;
    }

    // --- Pass 1: per-cell lighting + wall exclusion + interior mask → texA ---
    gl.useProgram(lightProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, occTex);
    gl.uniform1i(lu.occ, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform1i(lu.mask, 1);
    gl.uniform2i(lu.grid, w, h);
    gl.uniform2f(lu.origin, region.x, region.y);
    gl.uniform1f(lu.cellSize, 1 / cellsPerFt);
    gl.uniform1f(lu.cellsPerFt, cellsPerFt);
    gl.uniform1f(lu.ambient, ambient);
    gl.uniform1i(lu.sampleCount, softSamples);
    gl.uniform1f(lu.seed, seed);
    gl.uniform1i(lu.lightCount, lights.length);
    gl.uniform4fv(lu.lightPos, lightPosBuf);
    gl.uniform4fv(lu.lightCol, lightColBuf);
    renderToTex(texA);

    resultTex = texA;

    // --- Passes 2 & 3: separable blur (skipped in draft), with final cleanup ---
    if (qualityKey !== 'draft') {
      gl.useProgram(blurProg);
      gl.uniform2i(bu.grid, w, h);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, occTex);
      gl.uniform1i(bu.occ, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      gl.uniform1i(bu.mask, 2);

      // Horizontal A -> B (intermediate, no finalize)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(bu.src, 0);
      gl.uniform2i(bu.dir, 1, 0);
      gl.uniform1i(bu.finalize, 0);
      renderToTex(texB);

      // Vertical B -> A (finalize: re-clear walls + exterior)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.uniform1i(bu.src, 0);
      gl.uniform2i(bu.dir, 0, 1);
      gl.uniform1i(bu.finalize, 1);
      renderToTex(texA);
      resultTex = texA;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    meta = {
      width: w,
      height: h,
      cellsPerFt,
      regionX: region.x,
      regionY: region.y,
    };
    return true;
  }

  /**
   * Draw the cached lightmap into the canvas, positioned to match the SVG view.
   * @param {{x:number,y:number}} pan
   * @param {number} zoom
   * @param {number} pxPerFt
   */
  function draw(pan, zoom, pxPerFt) {
    if (!ready || !gl || !meta || !resultTex) return;
    const wrap = canvas.parentElement;
    const cw = wrap ? wrap.clientWidth : canvas.clientWidth;
    const ch = wrap ? wrap.clientHeight : canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const cellPx = (1 / meta.cellsPerFt) * pxPerFt * zoom;
    const destX = pan.x + meta.regionX * pxPerFt * zoom;
    const destY = pan.y + meta.regionY * pxPerFt * zoom;
    const destW = meta.width * cellPx;
    const destH = meta.height * cellPx;

    // Pixel rect -> clip space (origin top-left, y down).
    const x0 = (destX / cw) * 2 - 1;
    const x1 = ((destX + destW) / cw) * 2 - 1;
    const y0 = 1 - (destY / ch) * 2;
    const y1 = 1 - ((destY + destH) / ch) * 2;

    // Texture row 0 corresponds to world region.y (the top edge), so the top of
    // the quad samples v = 0.
    const verts = new Float32Array([
      x0, y0, 0, 0,
      x1, y0, 1, 0,
      x0, y1, 0, 1,
      x1, y1, 1, 1,
    ]);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(displayProg);
    gl.bindVertexArray(displayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resultTex);
    gl.uniform1i(du.tex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  function destroy() {
    if (!gl) return;
    for (const t of [occTex, maskTex, texA, texB]) if (t) gl.deleteTexture(t);
    if (fbo) gl.deleteFramebuffer(fbo);
    if (quadBuf) gl.deleteBuffer(quadBuf);
    if (vao) gl.deleteVertexArray(vao);
    if (displayVao) gl.deleteVertexArray(displayVao);
    if (lightProg) gl.deleteProgram(lightProg);
    if (blurProg) gl.deleteProgram(blurProg);
    if (displayProg) gl.deleteProgram(displayProg);
    occTex = maskTex = texA = texB = resultTex = null;
    fbo = quadBuf = vao = displayVao = null;
    lightProg = blurProg = displayProg = null;
    meta = null;
    ready = false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    gl = null;
  }

  return {
    isReady() {
      return ready;
    },
    compute,
    draw,
    get meta() {
      return meta;
    },
    destroy,
  };
}
