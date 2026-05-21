/**
 * Transferable layout schema (version 1).
 * Coordinates in feet; origin top-left; y increases downward.
 * Export/import as JSON — no server required.
 * Full AI-friendly spec: FLOORPLAN_FORMAT.md (project root).
 */
export const LAYOUT_VERSION = 1;

/** @typedef {{ id: string, x1: number, y1: number, x2: number, y2: number, exterior?: boolean }} Wall */
/** @typedef {{ id: string, type: string, x: number, y: number, w: number, h: number, rotation?: number }} Item */
/** @typedef {{ src: string, x: number, y: number, width: number, height: number, opacity?: number, locked?: boolean }} BackgroundImage */
/** @typedef {{ id: string, name: string, x: number, y: number, w: number, h: number }} RoomLabel */
/** @typedef {{ id: string, wallId: string, t: number, width: number, kind: 'door'|'window'|'sliding' }} Opening */

export function createEmptyLayout() {
  return {
    version: LAYOUT_VERSION,
    unit: 'ft',
    name: 'Blank floorplan',
    bounds: { width: 42, height: 42 },
    walls: [],
    openings: [],
    roomLabels: [],
    items: [],
    meta: {
      created: new Date().toISOString(),
      source: 'blank',
    },
  };
}

export function createDefaultLayout() {
  const walls = [
    // —— Exterior envelope (clockwise from top-left) ——
    { id: 'ext-n-bed2', x1: 0, y1: 0, x2: 12, y2: 0, exterior: true },
    { id: 'ext-n-liv', x1: 12, y1: 0, x2: 25, y2: 0, exterior: true },
    { id: 'ext-deck-n', x1: 25, y1: 0, x2: 32, y2: 0, exterior: true },
    { id: 'ext-deck-e', x1: 32, y1: 0, x2: 32, y2: 8, exterior: true },
    { id: 'ext-deck-s', x1: 25, y1: 8, x2: 32, y2: 8, exterior: true },
    { id: 'ext-e-upper', x1: 25, y1: 8, x2: 25, y2: 11, exterior: true },
    { id: 'ext-bed1-diag-a', x1: 25, y1: 11, x2: 33, y2: 18, exterior: true },
    { id: 'ext-bed1-diag-b', x1: 33, y1: 18, x2: 39, y2: 26, exterior: true },
    { id: 'ext-bed1-e', x1: 39, y1: 26, x2: 39, y2: 40, exterior: true },
    { id: 'ext-s', x1: 5, y1: 40, x2: 39, y2: 40, exterior: true },
    { id: 'ext-entry-diag', x1: 0, y1: 35, x2: 5, y2: 40, exterior: true },
    { id: 'ext-w', x1: 0, y1: 0, x2: 0, y2: 35, exterior: true },

    // —— Bedroom 2 (12×11) ——
    { id: 'bed2-e', x1: 12, y1: 0, x2: 12, y2: 11 },
    { id: 'bed2-s', x1: 0, y1: 11, x2: 9, y2: 11 },

    // —— Walk-in closet (bed 2) ——
    { id: 'wic2-n', x1: 9, y1: 11, x2: 12, y2: 11 },
    { id: 'wic2-s', x1: 9, y1: 16, x2: 12, y2: 16 },
    { id: 'wic2-w', x1: 9, y1: 11, x2: 9, y2: 16 },

    // —— Bath 2 ——
    { id: 'bath2-n', x1: 0, y1: 16, x2: 9, y2: 16 },
    { id: 'bath2-e', x1: 6, y1: 16, x2: 6, y2: 22 },
    { id: 'bath2-s', x1: 0, y1: 22, x2: 6, y2: 22 },

    // —— Left hall / laundry / coats / linen ——
    { id: 'hall-l1', x1: 6, y1: 22, x2: 12, y2: 22 },
    { id: 'hall-e', x1: 12, y1: 11, x2: 12, y2: 35 },
    { id: 'laundry-n', x1: 6, y1: 22, x2: 9, y2: 22 },
    { id: 'laundry-e', x1: 9, y1: 22, x2: 9, y2: 25 },
    { id: 'coats-n', x1: 9, y1: 25, x2: 12, y2: 25 },
    { id: 'linen-w', x1: 6, y1: 25, x2: 6, y2: 35 },
    { id: 'linen-n', x1: 6, y1: 25, x2: 9, y2: 25 },

    // —— Living (13×11) & deck access ——
    { id: 'liv-s', x1: 12, y1: 11, x2: 25, y2: 11 },
    { id: 'liv-deck', x1: 25, y1: 8, x2: 25, y2: 11 },

    // —— AC / WH closets (east of living) ——
    { id: 'closet-col', x1: 25, y1: 0, x2: 25, y2: 8 },
    { id: 'ac-wh-split', x1: 25, y1: 4, x2: 28, y2: 4 },
    { id: 'closet-e', x1: 28, y1: 0, x2: 28, y2: 8 },

    // —— Dining (12×11) ——
    { id: 'din-e', x1: 24, y1: 11, x2: 24, y2: 22 },
    { id: 'din-s', x1: 12, y1: 22, x2: 24, y2: 22 },

    // —— Kitchen (L-shape) & pantry ——
    { id: 'kit-n', x1: 12, y1: 22, x2: 22, y2: 22 },
    { id: 'kit-e', x1: 22, y1: 22, x2: 22, y2: 34 },
    { id: 'kit-s', x1: 12, y1: 34, x2: 22, y2: 34 },
    { id: 'kit-se-diag', x1: 22, y1: 34, x2: 26, y2: 38 },
    { id: 'pantry-n', x1: 6, y1: 34, x2: 12, y2: 34 },
    { id: 'pantry-e', x1: 12, y1: 34, x2: 12, y2: 37 },
    { id: 'entry-inner', x1: 6, y1: 34, x2: 6, y2: 37 },

    // —— Bedroom 1 hall & suite (14×17) ——
    { id: 'bed1-hall-n', x1: 25, y1: 22, x2: 32, y2: 22 },
    { id: 'bed1-hall-div', x1: 32, y1: 16, x2: 32, y2: 34 },
    { id: 'bed1-n', x1: 25, y1: 11, x2: 32, y2: 11 },
    { id: 'bed1-w', x1: 25, y1: 11, x2: 25, y2: 22 },
    { id: 'bed1-s', x1: 25, y1: 28, x2: 32, y2: 28 },
    { id: 'fau-n', x1: 25, y1: 22, x2: 28, y2: 22 },
    { id: 'lin-fau', x1: 28, y1: 22, x2: 32, y2: 22 },

    // —— Bath 1 (ensuite) ——
    { id: 'bath1-n', x1: 32, y1: 16, x2: 39, y2: 16 },
    { id: 'bath1-e', x1: 39, y1: 16, x2: 39, y2: 22 },
    { id: 'bath1-s', x1: 32, y1: 22, x2: 39, y2: 22 },
    { id: 'bath1-w', x1: 32, y1: 16, x2: 32, y2: 22 },

    // —— Walk-in closet (bed 1) ——
    { id: 'wic1-n', x1: 32, y1: 11, x2: 39, y2: 11 },
    { id: 'wic1-w', x1: 32, y1: 11, x2: 32, y2: 16 },
    { id: 'wic1-s', x1: 32, y1: 16, x2: 39, y2: 16 },
  ];

  const openings = [
    // Exterior
    { id: 'o-entry', wallId: 'ext-entry-diag', t: 0.45, width: 3, kind: 'door' },
    { id: 'w-bed2-a', wallId: 'ext-n-bed2', t: 0.3, width: 3.5, kind: 'window' },
    { id: 'w-bed2-b', wallId: 'ext-n-bed2', t: 0.7, width: 3.5, kind: 'window' },
    { id: 'w-bed1-a', wallId: 'ext-bed1-diag-a', t: 0.55, width: 3.5, kind: 'window' },
    { id: 'w-bed1-b', wallId: 'ext-bed1-diag-b', t: 0.35, width: 3.5, kind: 'window' },
    { id: 'w-bed1-c', wallId: 'ext-bed1-diag-b', t: 0.72, width: 3.5, kind: 'window' },

    // Living / deck
    { id: 'o-liv-deck', wallId: 'liv-deck', t: 0.5, width: 6, kind: 'sliding' },

    // Bedrooms & baths
    { id: 'o-bed2', wallId: 'bed2-s', t: 0.55, width: 2.5, kind: 'door' },
    { id: 'o-wic2', wallId: 'wic2-n', t: 0.5, width: 2, kind: 'door' },
    { id: 'o-bath2', wallId: 'bath2-s', t: 0.75, width: 2.5, kind: 'door' },
    { id: 'o-bed1', wallId: 'bed1-hall-n', t: 0.45, width: 2.5, kind: 'door' },
    { id: 'o-bath1', wallId: 'bath1-s', t: 0.35, width: 2.5, kind: 'door' },
    { id: 'o-wic1', wallId: 'wic1-w', t: 0.55, width: 2, kind: 'door' },

    // Dining / kitchen / pantry
    { id: 'o-din-hall', wallId: 'din-s', t: 0.12, width: 3, kind: 'door' },
    { id: 'o-kit-din', wallId: 'kit-n', t: 0.35, width: 4, kind: 'door' },
    { id: 'o-pantry', wallId: 'pantry-n', t: 0.5, width: 2, kind: 'door' },

    // Closets & utility
    { id: 'o-ac', wallId: 'closet-col', t: 0.25, width: 2, kind: 'door' },
    { id: 'o-wh', wallId: 'closet-col', t: 0.75, width: 2, kind: 'door' },
    { id: 'o-coats', wallId: 'coats-n', t: 0.5, width: 2, kind: 'door' },
    { id: 'o-laundry', wallId: 'laundry-e', t: 0.5, width: 2, kind: 'door' },
    { id: 'o-linen', wallId: 'linen-n', t: 0.5, width: 2, kind: 'door' },
    { id: 'o-fau', wallId: 'fau-n', t: 0.5, width: 2, kind: 'door' },
    { id: 'o-lin-bed1', wallId: 'lin-fau', t: 0.5, width: 2, kind: 'door' },
  ];

  const roomLabels = [
    { id: 'lbl-bed2', name: "BEDROOM 2  12'×11'", x: 1.5, y: 3.5, w: 9, h: 5 },
    { id: 'lbl-liv', name: "LIVING  13'×11'", x: 13.5, y: 3.5, w: 10, h: 5 },
    { id: 'lbl-deck', name: 'DECK', x: 26, y: 2.5, w: 4, h: 3 },
    { id: 'lbl-din', name: "DINING  12'×11'", x: 13.5, y: 13.5, w: 9, h: 5 },
    { id: 'lbl-kit', name: 'KITCHEN', x: 13.5, y: 25, w: 7, h: 4 },
    { id: 'lbl-bed1', name: "BEDROOM 1  14'×17'", x: 27, y: 24, w: 10, h: 6 },
    { id: 'lbl-bath1', name: 'BATH 1', x: 34, y: 17.5, w: 5, h: 3 },
    { id: 'lbl-bath2', name: 'BATH 2', x: 0.8, y: 17.5, w: 5, h: 3 },
    { id: 'lbl-entry', name: 'ENTRY', x: 1.2, y: 35.5, w: 4, h: 2.5 },
    { id: 'lbl-pantry', name: 'Pantry', x: 7.2, y: 34.5, w: 4, h: 2 },
    { id: 'lbl-wic2', name: 'Walk-in Closet', x: 9.2, y: 12.5, w: 2.5, h: 3 },
    { id: 'lbl-wic1', name: 'Walk-in Closet', x: 33.2, y: 12.5, w: 5, h: 3 },
    { id: 'lbl-ac', name: 'AC', x: 25.4, y: 1.2, w: 2.5, h: 2 },
    { id: 'lbl-wh', name: 'WH', x: 25.4, y: 5, w: 2.5, h: 2 },
    { id: 'lbl-coats', name: 'Coats', x: 9.3, y: 25.8, w: 2.5, h: 2 },
    { id: 'lbl-laundry', name: 'W/D', x: 6.3, y: 22.8, w: 2.5, h: 3 },
    { id: 'lbl-linen', name: 'Linen', x: 6.5, y: 26, w: 2.5, h: 2 },
    { id: 'lbl-fau', name: 'FAU', x: 25.3, y: 22.6, w: 2.5, h: 2 },
    { id: 'lbl-lin', name: 'Lin.', x: 28.5, y: 22.6, w: 2.5, h: 2 },
  ];

  const items = [];

  return {
    version: LAYOUT_VERSION,
    unit: 'ft',
    name: '2BR apartment (default)',
    bounds: { width: 42, height: 42 },
    walls,
    openings,
    roomLabels,
    items,
    meta: {
      created: new Date().toISOString(),
      source: 'default-floorplan',
    },
  };
}

export function validateLayout(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.version !== LAYOUT_VERSION) return false;
  if (!Array.isArray(data.walls) || !Array.isArray(data.items)) return false;
  return true;
}

export function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout));
}
