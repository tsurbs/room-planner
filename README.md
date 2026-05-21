# Room Planner

A minimalist floor-plan editor for furnishing and editing walls. Built with **HTMX** (UI fragments only — no extra server routes for templates), vanilla JS, **localStorage** for saves, and optional **multiplayer**: **PartyKit** for realtime plus **Vercel KV** (Upstash-compatible REST) for plan snapshots.

The default layout matches the bundled 2-bedroom apartment floorplan (walls, room labels, doors/windows, and pre-placed furniture).

## Run locally

Static files only — any static server works:

```bash
cd room_planner
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080). **That port serves only static files** (HTML/CSS/JS from `public/`). There is **no** `/api/plans`, PartyKit relay, or Vercel serverless runtime on `:8080` unless you **also** run `vercel dev` (different port by default unless configured) — see multiplayer dev below.

### Troubleshooting Share

- **Share always fails after `python3 -m http.server 8080`:** Expected. **`POST /api/plans`** is implemented by **`vercel dev` / deployed Vercel**, not Python’s server. Either run **`vercel dev`** and open its URL, deploy and use production, or — for debugging only — set in `public/index.html` the optional meta **`room-planner-api-base`** (see commented example) to your deployed origin so Share hits that API from localhost.
- **Share fails on Vercel (`503`, “Storage unavailable”)** or vague **500**: Link **Vercel KV** (or Upstash) and set **`KV_REST_API_URL`** and **`KV_REST_API_TOKEN`** on the project (**`.env.local`** locally, Project Settings → Environment Variables in production).
- **`FUNCTION_INVOCATION_FAILED` on `POST /api/plans` (or other `/api/plans/*`):** In the Vercel dashboard → your deployment → **Functions** / **Logs**, open the failing request. Most often the runtime is missing **KV REST env**: add **`KV_REST_API_URL`** and **`KV_REST_API_TOKEN`** for Production (and redeploy), or confirm the **Vercel KV** integration is linked to the project. Without them, older code paths could crash instead of returning JSON; the API now responds with **`503`** and a **`hint`** when KV is not configured. Persistent invocation failures after setting env usually mean a bad token/URL or a runtime error — check function logs for the stack trace.
- **`file:` URL:** ES modules generally require **http/https** — open the site over HTTP as above.

> ES modules require HTTP; opening `index.html` directly from disk may block imports.

### Multiplayer dev (PartyKit + API)

1. **Vercel KV / Upstash** — Create a KV (or Redis) store and copy `KV_REST_API_URL` and `KV_REST_API_TOKEN` into `.env.local` (see `.env.example`). Run **`vercel dev`** from this directory so `/api/plans` is available (the static `python3 -m http.server` shell does **not** serve `/api`).
2. **PartyKit** — In another terminal: `npm run party:dev`. The CLI prints **`Ready on http://127.0.0.1:<port>`** (port may differ from 1999).
3. **index.html** — Set the PartyKit WebSocket **base URL** (scheme + host + port, no path) on the meta tag:

   ```html
   <meta name="room-planner-partykit" content="ws://127.0.0.1:<PORT>">
   ```

4. Reload the app. Use **Share** to create a plan id, or open `?plan=<uuid>`. The client connects to:

   `ws://<host>:<port>/parties/plan/<planId>`

   (Party name is **`plan`**; `main` is only the default PartyKit entry and is not used for this app’s URL.)

Production: set the same meta tag to your deployed PartyKit host, e.g. `wss://your-party.<project>.partykit.dev`.

## How to edit labels

1. Press **V** or click **Furnish** so you are in furnish mode (labels are only editable here).
2. **Click** a room label on the canvas (for example `BEDROOM 2`). It highlights and the **Properties** panel on the right shows **Text**, **X/Y (ft)**, and **Font size**.
3. Change the **Text** field and press Enter or click away to apply. Use arrow keys to nudge position, or drag the label on the canvas.
4. **Double-click** a label to jump straight to the text field.
5. Press **⌫** to delete the selected label.
6. To add a label: click **+ Label** in the toolbar, then **click** where it should go on the floor plan.

## Features

- **Furnish mode** — Drag catalog items onto the canvas; move, resize, rotate; edit dimensions in the properties panel.
- **Room labels** — Click a label (e.g. `BEDROOM 2`) to select it; edit text, position (ft), and font size in the Properties panel. Double-click a label to jump to the text field. Drag to reposition. **+ Label** in the toolbar, then click the canvas to add one. Delete with ⌫ when selected.
- **Edit floorplan mode** — Move walls and endpoints; Shift+drag to draw new segments; mark exterior walls; add room labels with **+ Label**.
- **Room labels** — Click to select, drag to move, double-click or use the properties panel to edit text; set position and font size; Delete to remove.
- **Save / load** — Named slots in `localStorage` plus autosave. With `?plan=` active, autosave to the default slot is skipped to avoid fighting cloud state; named saves still work.
- **Share link** — **Share** calls `POST /api/plans` (KV) and copies a `?plan=` URL. With PartyKit configured (see meta tag below), layout changes debounce to the room (~400ms after edits); cursor presence is overlayed on the SVG canvas.
- **Export / import** — JSON layout file you can copy, email, or version-control.

### Multiplayer (quick reference)

| Piece | Role |
|--------|------|
| **Vercel** | Static app + `/api/plans` (cold snapshot, share creation). Needs `KV_REST_API_*` or Vercel KV binding. |
| **PartyKit** | WebSocket rooms at `/parties/plan/:planId` — in-memory layout + revision; live cursors; debounced `PUT` to Vercel with Bearer secret. |

**Concurrency:** PartyKit **increments `revision` on every valid `layout` message** (processing order = LWW). Clients apply `{ type: 'state' }` only while **`state.drag == null`** and **`remote.revision > syncedRevision`**.

**Large trace images:** Sync omits `backgroundImage` when `src` length exceeds **500,000** (toast shown).

## Layout JSON schema (v1)

Transferable, self-contained representation:

```json
{
  "version": 1,
  "unit": "ft",
  "name": "2BR apartment (default)",
  "bounds": { "width": 40, "height": 36 },
  "walls": [{ "id": "...", "x1": 0, "y1": 0, "x2": 12, "y2": 0, "exterior": true }],
  "openings": [{ "id": "...", "wallId": "...", "t": 0.5, "width": 3, "kind": "door" }],
  "roomLabels": [{ "id": "...", "name": "Living", "x": 13, "y": 4, "w": 10, "h": 5 }],
  "items": [{ "id": "...", "type": "sofa-3", "x": 14, "y": 7, "w": 7, "h": 3, "rotation": 0 }],
  "meta": { "created": "...", "source": "..." }
}
```

- Coordinates are in **feet**, origin **top-left**.
- `walls` are line segments; `openings` are positioned along a wall (`t` = 0–1).
- `items.type` keys match `js/catalog.js`.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| V | Furnish mode |
| E | Edit floorplan |
| Click label | Select; edit in Properties panel |
| Double-click label | Focus label text field |
| + Label (toolbar) | Place new label on canvas |
| ⌘S | Save |
| ⌘Z / ⌘⇧Z | Undo / redo |
| ⌘⇧N | Clear floorplan (blank canvas; clears autosave) |
| Reset (toolbar) | Restore default 2BR apartment reference layout |
| ⌘D | Duplicate selection |
| R | Rotate 90° (drag handle for free angle) |
| ⌫ | Delete |
| Click / double-click label | Select / edit room label text |
| Drag label | Reposition label |
| + Label (toolbar) | Add label in edit mode |
| Shift+click | Multi-select |
| Alt+drag item | Duplicate and move |
| Shift+resize | Lock aspect ratio |
| [ / ] | Send backward / bring forward |
| Arrows | Nudge selection (¼ ft) |
| Scroll | Zoom at cursor |
| Space / middle-drag / Alt+drag | Pan canvas |

## Stack

- HTMX 2 — swaps help/save hints from inline templates
- SVG canvas — walls, openings, furniture
- **Vercel serverless** — `@vercel/kv` / Upstash-compatible REST env for plan blobs (`api/plans/*`). These routes are compiled as **Node.js** functions (`@vercel/node`), not Edge — required for `@vercel/kv`.
- **PartyKit** — `party/plan-room.ts`, configured in `partykit.json` (`parties.plan`); deploy with `npm run party:deploy`
- Vanilla JS modules — `js/sync.js` coordinates PartyKit + API when `?plan=` is present

### Environment variables

| Variable | Where | Purpose |
|----------|--------|---------|
| `KV_REST_API_URL` | Vercel / local `.env` | Upstash-compatible REST URL |
| `KV_REST_API_TOKEN` | Vercel / local `.env` | KV token |
| `PARTYKIT_SERVERS_SECRET` | **Vercel** (API) + **PartyKit** | Same secret; `PUT /api/plans/[id]` requires `Authorization: Bearer …` |
| `PLANDS_API_ORIGIN` | **PartyKit only** | Your Vercel site origin (no trailing slash), e.g. `https://roomplanner.example.com` — used for `GET/PUT /api/plans/:id` from the room |

Optional: `ROOM_SECRET` is accepted by the Party server as an alias for the Bearer token value in code paths that read `PARTYKIT_SERVERS_SECRET || ROOM_SECRET` (prefer **`PARTYKIT_SERVERS_SECRET`** for one name everywhere).

### Deploy PartyKit

```bash
npm run party:deploy
```

The PartyKit **HTTPS root** (`https://…partykit.dev/`) is not the editor. It now returns a small **“host is running”** page; **WebSockets** use `wss://<host>/parties/plan/<planId>`. If you still see a generic “Not found” from PartyKit’s edge, **redeploy** after pulling the latest `party/plan-room.ts` (static `onFetch` for `GET /`).

Link the project once (`npx partykit login`). After deploy, set **`PLANDS_API_ORIGIN`** and **`PARTYKIT_SERVERS_SECRET`** in the PartyKit dashboard to match Vercel. Copy the **PartyKit WebSocket host** (see deploy output), map a DNS CNAME if you use a custom subdomain, then set `index.html`:

```html
<meta name="room-planner-partykit" content="wss://<your-party-host>">
```

Rebuild/redeploy the static site when you change the meta tag (or inject it in CI).

## Deploy (Vercel)

Production: [https://roomplanner-rose.vercel.app](https://roomplanner-rose.vercel.app)

Vercel project: **room_planner** (`theo-urbans-projects/room_planner`). `vercel.json` sets `Content-Type` for `/js/*` ES modules. API routes live in `api/plans/`; add **KV** (or Upstash Redis) integration and env vars from `.env.example`.

Prerequisites: [Vercel CLI](https://vercel.com/docs/cli) and `vercel login` (or `npx vercel@latest login`).

From the project directory:

```bash
cd room_planner
vercel link --yes    # once, if not already linked
vercel deploy --yes  # preview deployment
vercel --prod        # production (alias updates)
```

Non-interactive production deploy in one step:

```bash
vercel deploy --prod --yes
```

`.vercel/` is created by `vercel link` and is gitignored by default; do not commit tokens or env secrets.

## Custom domains

**Status:** **roomplanner.theourban.com** is attached to **room_planner** (alias on latest production). DNS is not verified yet—add the record below at **Cloudflare** (theourban.com uses Cloudflare nameservers, not Vercel DNS).

| Target | URL |
|--------|-----|
| Production (Vercel default) | [https://roomplanner-rose.vercel.app](https://roomplanner-rose.vercel.app) |
| Custom (after DNS propagates) | [https://roomplanner.theourban.com](https://roomplanner.theourban.com) |

**DNS at registrar / Cloudflare** (from `vercel domains add roomplanner.theourban.com`):

| Host / name | Type | Value |
|-------------|------|--------|
| `roomplanner` | **A** | `76.76.21.21` |

Optional: `npx vercel@latest domains inspect roomplanner.theourban.com` to re-check verification.

You must **own** the domain and add DNS records at your registrar (or DNS host). Vercel cannot purchase domains or change your registrar for you.

### See domains on your team

```bash
cd room_planner
npx vercel@latest domains ls
npx vercel@latest domains inspect <your-domain>
npx vercel@latest project inspect room_planner
```

On team **theo-urbans-projects**, **theourban.com** is already used by other projects (`theourban-com`, `chef-recipe-app`, etc.). Prefer a **dedicated subdomain** for Room Planner (for example `roomplanner.theourban.com`) rather than moving apex/`www` unless you intend to reassign them.

### Attach a domain to this project

Replace `example.com` with your hostname(s). Run from this directory (after `vercel link`):

```bash
npx vercel@latest domains add roomplanner.theourban.com   # when cwd is linked to room_planner
# npx vercel@latest domains add www.example.com room_planner
```

The CLI prints the **exact** DNS records for your domain—use those values at your registrar (they override any generic table below).

Typical records ([Vercel custom domains](https://vercel.com/docs/projects/domains/add-a-domain)):

| Host | Type | Value (verify in CLI) |
|------|------|------------------------|
| `@` (apex) | A | `76.76.21.21` |
| `www` | CNAME | `cname.vercel-dns.com` |

For a **subdomain** only (e.g. `app.example.com`), you usually add a **CNAME** to `cname.vercel-dns.com` unless the CLI shows something else.

After DNS propagates, the domain serves the project’s **production** deployment. Redeploy with:

```bash
npx vercel@latest deploy --prod --yes
```

`vercel alias` is only needed in edge cases (for example pointing a domain at a specific deployment URL); attaching the domain to the project is the normal path.

### Room Planner hostname

Configured: **roomplanner.theourban.com** on project **room_planner** (team **theo-urbans-projects**). Re-run `vercel domains add roomplanner.theourban.com` from this directory if the link breaks; use `vercel alias ls` to confirm the alias.

