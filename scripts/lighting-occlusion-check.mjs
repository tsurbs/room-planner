/**
 * Regression: furniture/items must not affect lightmap bytes (wall-only LOS).
 */
import { computeLightmap } from '../public/js/lighting-simulator.js';

const walls = [
  { id: 'w-top', x1: 0, y1: 0, x2: 20, y2: 0 },
  { id: 'w-right', x1: 20, y1: 0, x2: 20, y2: 20 },
  { id: 'w-left', x1: 0, y1: 0, x2: 0, y2: 20 },
  { id: 'w-bot', x1: 0, y1: 20, x2: 20, y2: 20 },
  { id: 'w-part', x1: 10, y1: 0, x2: 10, y2: 20 },
];

const items = [
  { id: 'side', type: 'side-table', x: 17, y: 2, w: 2, h: 2 },
  { id: 'sofa', type: 'sofa-3', x: 17, y: 5, w: 3, h: 7 },
  { id: 'arm', type: 'armchair', x: 12, y: 2, w: 3, h: 3 },
  { id: 'coffee', type: 'coffee-table', x: 12, y: 8, w: 2, h: 4 },
];

const lights = [
  {
    id: 'L1',
    type: 'recessed-s',
    x: 18,
    y: 3,
    kelvin: 3000,
    radiusFt: 12,
    intensity: 0.85,
    sizeFt: 0.75,
  },
  {
    id: 'L2',
    type: 'floor-lamp',
    x: 14,
    y: 12,
    kelvin: 2700,
    radiusFt: 7,
    intensity: 0.7,
    sizeFt: 1.5,
  },
];

const region = { x: 0, y: 0, width: 20, height: 20 };
const options = { quality: 'high', seed: 42 };

const withItems = computeLightmap({ walls, items, lights, roomLabels: [] }, region, options);
const withoutItems = computeLightmap({ walls, items: [], lights, roomLabels: [] }, region, options);

if (withItems.data.length !== withoutItems.data.length) {
  console.error('FAIL: lightmap size differs with/without items');
  process.exit(1);
}

let diffs = 0;
for (let i = 0; i < withItems.data.length; i++) {
  if (withItems.data[i] !== withoutItems.data[i]) diffs++;
}

if (diffs > 0) {
  console.error(`FAIL: ${diffs} byte(s) differ — items may be affecting occlusion`);
  process.exit(1);
}

console.log('OK: lightmap identical with and without furniture items');
