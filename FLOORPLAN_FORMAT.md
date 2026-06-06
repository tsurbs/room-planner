# Room Planner — Floorplan JSON Format (v1)

**Purpose:** Machine-readable floor plan for [Room Planner](https://github.com/). Use this document as a **self-contained prompt** when asking another AI (or a human) to generate layout JSON for import via **Export / Import** in the app.

**Schema version:** `1` (constant `LAYOUT_VERSION` in `js/default-layout.js`)

**Reference implementation:** `js/default-layout.js`, `js/catalog.js`, `js/app.js`

---

## Coordinate system

| Rule | Value |
|------|--------|
| Unit | **Feet** (`"unit": "ft"`) — only unit supported in v1 |
| Origin | **Top-left** of the drawable area `(0, 0)` |
| X axis | Increases **to the right** |
| Y axis | Increases **downward** (screen coordinates, not CAD “Y up”) |
| Precision | Use decimals freely; the editor snaps to **0.25 ft** when placing/editing interactively |
| Angles | **Degrees**, clockwise, for item `rotation` (0 = axis-aligned, top edge horizontal) |

**`bounds`** sets the **grid canvas** size (1 ft grid lines). Walls and labels may extend outside bounds but the visible grid is `0 … bounds.width` × `0 … bounds.height`.

---

## Root object schema

```json
{
  "version": 1,
  "unit": "ft",
  "name": "string",
  "bounds": { "width": number, "height": number },
  "walls": [ Wall, ... ],
  "openings": [ Opening, ... ],
  "roomLabels": [ RoomLabel, ... ],
  "items": [ Item, ... ],
  "lights": [ Light, ... ],
  "backgroundImage": BackgroundImage,
  "meta": { "created": "ISO-8601 string", "source": "string", ... }
}
```

### Field reference

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | `number` | **yes** | Must be exactly `1` |
| `unit` | `string` | recommended | Use `"ft"` |
| `name` | `string` | recommended | Display name / save slot label |
| `bounds` | object | recommended | `{ width, height }` in feet; default bundle uses `42×42` |
| `walls` | `Wall[]` | **yes** | May be `[]` for blank plan |
| `openings` | `Opening[]` | no | Omit or `[]`; app treats missing as `[]` |
| `roomLabels` | `RoomLabel[]` | no | Omit or `[]`; app treats missing as `[]` |
| `items` | `Item[]` | **yes** | May be `[]`; array must exist for import |
| `lights` | `Light[]` | no | Omit or `[]`; simulated lighting for plan-view preview |
| `lightingRegion` | object | no | `{ x, y, width, height }` in feet; bounds for the computed floor lightmap (auto-created if omitted) |
| `backgroundImage` | `BackgroundImage` | no | Optional trace/reference image behind the grid |
| `meta` | object | no | Free-form metadata; not validated |

---

## Wall

A wall is one **straight segment** (not a polyline). Rooms are implied by a **closed network** of segments sharing endpoints.

```json
{
  "id": "unique-string",
  "x1": 0, "y1": 0,
  "x2": 12, "y2": 0,
  "exterior": true
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | **yes** | Unique among all walls; referenced by `openings[].wallId` |
| `x1`, `y1` | `number` | **yes** | Start point (feet) |
| `x2`, `y2` | `number` | **yes** | End point (feet) |
| `exterior` | `boolean` | no | `true` = outer envelope (thicker stroke). Default `false` / omitted = interior |

### Wall segment rules

1. **Straight lines only** — diagonal segments are allowed (`x1≠x2` and `y1≠y2`).
2. **Connected corners** — Adjacent walls should meet at **exactly the same coordinates** (shared endpoints). Example: north wall ends at `(12,0)` and east partition starts at `(12,0)`.
3. **Exterior flag** — Mark the **building outline** with `"exterior": true`. Interior partitions omit the flag or set `false`.
4. **Unique IDs** — Every wall `id` must be unique; stable IDs help openings stay attached after edits.
5. **Zero-length walls** — Avoid `x1===x2 && y1===y2` (degenerate; openings divide by zero length).
6. **Naming** — Use descriptive kebab-case ids (`bed2-s`, `ext-n-liv`) as in the default layout.

**Wall length** (for openings): `length = hypot(x2-x1, y2-y1)` feet.

---

## Opening

Doors and windows sit **on** a wall, centered at parametric position `t`.

```json
{
  "id": "o-bed2",
  "wallId": "bed2-s",
  "t": 0.55,
  "width": 2.5,
  "kind": "door"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | **yes** | Unique among openings |
| `wallId` | `string` | **yes** | Must match an existing `walls[].id` |
| `t` | `number` | **yes** | Position along wall, **0 = start (x1,y1)**, **1 = end (x2,y2)** |
| `width` | `number` | **yes** | Opening width in **feet** (along the wall) |
| `kind` | `string` | **yes** | One of: `"door"`, `"window"`, `"sliding"` |

### Opening placement math

The renderer centers the opening on `t` and spans:

- `half = width / 2 / wallLength`
- Visible segment from `max(0, t - half)` to `min(1, t + half)` along the wall

Choose `t` so the opening fits on the wall (typically `half < t < 1 - half`). Typical widths from the default plan: interior doors **2–2.5 ft**, entry **3 ft**, sliding **6 ft**, windows **3.5 ft**.

If `wallId` is missing (wall deleted), the opening is skipped silently.

---

## RoomLabel

Text labels for room names (rendered in **Furnish** / edit modes).

```json
{
  "id": "lbl-liv",
  "name": "LIVING  13'×11'",
  "x": 13.5,
  "y": 3.5,
  "fontSize": 11
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | **yes** | Unique among labels |
| `name` | `string` | **yes** | Display text (often includes dimensions) |
| `x`, `y` | `number` | **yes** | **Top-left** anchor of text baseline area (feet) |
| `fontSize` | `number` | no | Pixel font size in SVG; default **11** |

**Legacy note:** The bundled default layout still includes `w` and `h` on some labels; the current app **ignores** them and uses `fontSize` instead. Prefer `fontSize` for new JSON.

---

## Item (furniture / fixtures)

Placed catalog objects. Top-left position, size in feet, optional rotation.

```json
{
  "id": "item-1",
  "type": "sofa-3",
  "x": 14,
  "y": 7,
  "w": 7,
  "h": 3,
  "rotation": 0
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | **yes** | Unique among items |
| `type` | `string` | **yes** | Catalog key (see below) |
| `x`, `y` | `number` | **yes** | Top-left corner (feet) |
| `w`, `h` | `number` | **yes** | Width and depth (feet); usually match catalog defaults |
| `rotation` | `number` | no | Degrees clockwise; default `0` |

Unknown `type` values still render as a rectangle with the type string as label; known types use catalog styling (`round`, `fixture`, `opacity`).

### Catalog `type` keys (`js/catalog.js`)

| Category | `type` keys |
|----------|-------------|
| **bedroom** | `bed-queen`, `bed-king`, `nightstand`, `dresser` |
| **living** | `sofa-3`, `armchair`, `coffee-table`, `side-table`, `tv-stand` |
| **dining** | `dining-table`, `dining-chair` |
| **kitchen** | `fridge`, `stove`, `sink-double`, `dishwasher`, `counter` |
| **bath** | `toilet`, `tub`, `tub-oval`, `shower`, `vanity` |
| **utility** | `washer`, `dryer` |
| **outdoor** | `round-table`, `patio-chair` |
| **office** | `desk`, `bookshelf` |
| **decor** | `rug`, `plant` |

---

## Light (simulated lighting)

Point lights for plan-view illumination preview. Position is the **center** of the fixture in feet.

```json
{
  "id": "light-1",
  "type": "recessed-s",
  "x": 12,
  "y": 8,
  "sizeFt": 0.75,
  "radiusFt": 6,
  "kelvin": 3000,
  "intensity": 0.75
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | **yes** | Unique among lights |
| `type` | `string` | **yes** | Preset key (see `js/lighting.js`) |
| `x`, `y` | `number` | **yes** | Center position (feet) |
| `sizeFt` | `number` | no | Visible fixture diameter (feet); defaults from preset |
| `radiusFt` | `number` | no | Light spill radius on the floor (feet) |
| `kelvin` | `number` | no | Color temperature 2000–6500 K; defaults from preset |
| `intensity` | `number` | no | Brightness 0.1–1; default `0.75` |

### Light `type` presets (`js/lighting.js`)

| type | Label | sizeFt | radiusFt | default K |
|------|-------|--------|----------|-----------|
| `recessed-s` | Recessed (small) | 0.75 | 6 | 3000 |
| `recessed-l` | Recessed (large) | 1.25 | 9 | 3500 |
| `pendant` | Pendant | 1.5 | 8 | 3000 |
| `chandelier` | Chandelier | 2.5 | 14 | 2700 |
| `floor-lamp` | Floor lamp | 1.5 | 7 | 2700 |
| `track` | Track spot | 0.6 | 5 | 4000 |

### Lighting region

Optional rectangle (feet) defining where the app computes the **floor lightmap**. Each grid cell inside the region gets RGB from additive kelvin-tinted light with line-of-sight occlusion through **walls only** — furniture never blocks light rays in the simulation. In lighting preview, the lightmap is drawn under semi-transparent furniture so floor glow shows through item footprints. Quality (Draft / Normal / High) controls grid density and soft-shadow samples in the Properties panel when the region is selected. If omitted, the app computes a default from walls, lights, and grid bounds with padding.

```json
{
  "x": -6,
  "y": -6,
  "width": 54,
  "height": 54
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `x`, `y` | `number` | **yes** | Top-left corner (feet) |
| `width`, `height` | `number` | **yes** | Size in feet; minimum 4 when edited in the UI |

### Default catalog dimensions (feet)

| type | w × h |
|------|-------|
| bed-queen | 5 × 6.5 |
| bed-king | 6 × 7 |
| nightstand | 2 × 2 |
| dresser | 5 × 2 |
| sofa-3 | 7 × 3 |
| armchair | 3 × 3 |
| coffee-table | 4 × 2 |
| side-table | 2 × 2 |
| tv-stand | 6 × 1.5 |
| dining-table | 5 × 3 |
| dining-chair | 1.5 × 1.5 |
| desk | 4 × 2 |
| bookshelf | 3 × 1 |
| round-table | 2.5 × 2.5 |
| patio-chair | 2 × 2 |
| fridge | 3 × 3 |
| stove | 2.5 × 2.5 |
| sink-double | 3 × 2 |
| dishwasher | 2 × 2 |
| counter | 4 × 2 |
| washer | 2.5 × 2.5 |
| dryer | 2.5 × 2.5 |
| toilet | 2 × 2.5 |
| tub | 5 × 2.5 |
| tub-oval | 5 × 3 |
| shower | 3 × 3 |
| vanity | 4 × 2 |
| rug | 6 × 4 |
| plant | 1.5 × 1.5 |

---

## BackgroundImage (trace image)

Optional reference image rendered **behind** the grid, walls, labels, and furniture. Used to trace a scanned floorplan or photo over the drawing.

```json
{
  "src": "data:image/png;base64,...",
  "x": 0,
  "y": 0,
  "width": 40,
  "height": 30,
  "opacity": 0.5,
  "locked": false
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `src` | `string` | **yes** | Image URL or `data:` URI (PNG/JPG); persisted in export/import and local saves |
| `x`, `y` | `number` | **yes** | Top-left position in **feet** (same coordinate system as items) |
| `width`, `height` | `number` | **yes** | Display size in **feet** (scale the image to match your plan) |
| `opacity` | `number` | no | `0`–`1`; default **0.5** for tracing |
| `locked` | `boolean` | no | When `true`, image cannot be dragged or resized in the UI |

Omit `backgroundImage` entirely when no trace image is used. Large `data:` URLs are acceptable for local use but make JSON exports heavy.

---

## Meta

Optional provenance bag. Not validated on import.

```json
"meta": {
  "created": "2026-05-21T12:00:00.000Z",
  "source": "ai-generated",
  "notes": "3BR ranch — draft"
}
```

---

## Examples

### Minimal blank layout (valid import)

```json
{
  "version": 1,
  "unit": "ft",
  "name": "Blank floorplan",
  "bounds": { "width": 42, "height": 42 },
  "walls": [],
  "openings": [],
  "roomLabels": [],
  "items": [],
  "meta": {
    "created": "2026-05-21T12:00:00.000Z",
    "source": "blank"
  }
}
```

### Small rectangular room (walls + door + label)

```json
{
  "version": 1,
  "unit": "ft",
  "name": "Sample room",
  "bounds": { "width": 20, "height": 16 },
  "walls": [
    { "id": "ext-n", "x1": 0, "y1": 0, "x2": 14, "y2": 0, "exterior": true },
    { "id": "ext-e", "x1": 14, "y1": 0, "x2": 14, "y2": 10, "exterior": true },
    { "id": "ext-s", "x1": 0, "y1": 10, "x2": 14, "y2": 10, "exterior": true },
    { "id": "ext-w", "x1": 0, "y1": 0, "x2": 0, "y2": 10, "exterior": true }
  ],
  "openings": [
    { "id": "o-entry", "wallId": "ext-s", "t": 0.5, "width": 3, "kind": "door" }
  ],
  "roomLabels": [
    { "id": "lbl-main", "name": "LIVING  14'×10'", "x": 2, "y": 3, "fontSize": 11 }
  ],
  "items": [],
  "meta": { "created": "2026-05-21T12:00:00.000Z", "source": "example" }
}
```

### Snippet from default layout (exterior envelope only)

Clockwise exterior shell from `createDefaultLayout()` — interior partitions omitted:

```json
"walls": [
  { "id": "ext-n-bed2", "x1": 0, "y1": 0, "x2": 12, "y2": 0, "exterior": true },
  { "id": "ext-n-liv", "x1": 12, "y1": 0, "x2": 25, "y2": 0, "exterior": true },
  { "id": "ext-deck-n", "x1": 25, "y1": 0, "x2": 32, "y2": 0, "exterior": true },
  { "id": "ext-deck-e", "x1": 32, "y1": 0, "x2": 32, "y2": 8, "exterior": true },
  { "id": "ext-deck-s", "x1": 25, "y1": 8, "x2": 32, "y2": 8, "exterior": true },
  { "id": "ext-e-upper", "x1": 25, "y1": 8, "x2": 25, "y2": 11, "exterior": true },
  { "id": "ext-bed1-diag-a", "x1": 25, "y1": 11, "x2": 33, "y2": 18, "exterior": true },
  { "id": "ext-bed1-diag-b", "x1": 33, "y1": 18, "x2": 39, "y2": 26, "exterior": true },
  { "id": "ext-bed1-e", "x1": 39, "y1": 26, "x2": 39, "y2": 40, "exterior": true },
  { "id": "ext-s", "x1": 5, "y1": 40, "x2": 39, "y2": 40, "exterior": true },
  { "id": "ext-entry-diag", "x1": 0, "y1": 35, "x2": 5, "y2": 40, "exterior": true },
  { "id": "ext-w", "x1": 0, "y1": 0, "x2": 0, "y2": 35, "exterior": true }
]
```

---

## Validation (`validateLayout`)

The app runs this check on **import** and **load from save** (`js/default-layout.js`):

```js
export function validateLayout(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.version !== 1) return false;
  if (!Array.isArray(data.walls) || !Array.isArray(data.items)) return false;
  return true;
}
```

**Passes when:**

- Root is a plain object
- `version === 1`
- `walls` is an array (can be empty)
- `items` is an array (can be empty)

**Does not check (but you should):**

- Unique ids, valid `wallId` references, `t` in [0,1], numeric coordinates
- `openings` / `roomLabels` presence (missing arrays are OK at runtime; import still succeeds)
- Catalog `type` existence
- Walls forming closed rooms

---

## Common mistakes to avoid

| Mistake | Fix |
|---------|-----|
| `version: "1"` (string) | Use number `1` |
| Missing `items` array | Always include `"items": []` |
| Y axis flipped (CAD style) | Y increases **down**; flip your coordinates |
| Gaps at corners | Snap shared endpoints to identical `(x,y)` |
| `wallId` typo | Opening won't render; id must match a wall |
| `t` at 0 or 1 with wide door | Center opening: ensure `t ± width/(2·length)` stays in [0,1] |
| Openings on zero-length walls | Give the wall real length |
| Duplicate wall/item ids | Use unique strings (`bed2-s`, `o-bed2`, `lbl-bed2`) |
| Invalid `kind` | Only `door`, `window`, `sliding` |
| Room label `w`/`h` only | Use `fontSize` (and `x`,`y`) for labels |
| Furniture `type` invented | Use catalog keys or accept generic rendering |
| Huge coordinates without `bounds` | Set `bounds` to cover your drawing (e.g. 50×40) |

---

## Prompt template (copy-paste for another AI)

```
You are generating a Room Planner floorplan JSON file (schema version 1).

RULES:
- Output ONLY valid JSON (no markdown fences, no commentary).
- Coordinates in FEET; origin top-left; Y increases DOWNWARD.
- version must be number 1; unit "ft"; include walls array and items array (items may be []).
- Walls: straight segments { id, x1, y1, x2, y2, exterior? }. Share exact endpoints at corners. Mark building outline with "exterior": true.
- Openings: { id, wallId, t (0-1 along wall from start to end), width in feet, kind: "door"|"window"|"sliding" }.
- roomLabels: { id, name, x, y, fontSize? } — text anchor top-left.
- items (optional furniture): { id, type, x, y, w, h, rotation? } where type is a catalog key (bed-queen, sofa-3, toilet, etc.).
- bounds: { width, height } grid size in feet, large enough to fit the plan.

REQUEST:
Generate JSON for: [DESCRIBE YOUR HOME HERE — e.g. "single-story 3BR/2BA ranch, 28×52 ft exterior, open kitchen-living, 2-car garage on the left, master suite rear right"].

Include: exterior walls, interior partitions, doors between rooms, windows on exterior walls, roomLabels with room names and approximate dimensions. Leave items [] unless I ask for furniture placement.

Use unique kebab-case ids. Typical interior door width 2.5 ft, entry 3 ft, window 3.5 ft.
```

Replace the `[DESCRIBE YOUR HOME HERE …]` line with your requirements, then paste the model’s JSON into Room Planner → **Import**.

---

## Import workflow

1. Run Room Planner locally (`python3 -m http.server 8080`).
2. Open the app → **Import** (or paste JSON in the import modal).
3. On success you’ll see the plan; on failure the toast shows `Invalid schema` (failed `validateLayout`) or JSON parse error.
4. Refine in **Edit floorplan** mode; add furniture in **Furnish** mode.

---

## Versioning

Only **v1** exists today. Future versions would bump `version` and require app updates. Do not change `version` for the same schema shape.
