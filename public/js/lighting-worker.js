/**
 * Web Worker entry for off-main-thread lightmap computation.
 */
import { computeLightmap } from './lighting-simulator.js';

self.onmessage = (evt) => {
  const { id, layout, region, options } = evt.data;
  try {
    const result = computeLightmap(layout, region, options);
    self.postMessage(
      {
        id,
        ok: true,
        width: result.width,
        height: result.height,
        cellsPerFt: result.cellsPerFt,
        regionX: result.regionX,
        regionY: result.regionY,
        data: result.data.buffer,
      },
      [result.data.buffer]
    );
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err?.message || String(err),
    });
  }
};
