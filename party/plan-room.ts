/**
 * PartyKit room per plan id (`/parties/plan/:planId`).
 *
 * Concurrency: **server-wins LWW with monotonic revision**. Each accepted `layout`
 * message increments `revision` regardless of client-sent `revision` (last processed
 * message wins; broadcast order defines precedence). `updatedAt` is set when the
 * server applies a layout commit.
 */
import type * as Party from 'partykit/server';

const LAYOUT_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 2000;
const PERSIST_INTERVAL_MS = 30000;
const BG_SYNC_MAX_CHARS = 500_000;

function emptyLayout(nowIso: string) {
  return {
    version: LAYOUT_VERSION,
    unit: 'ft',
    name: 'Blank floorplan',
    bounds: { width: 42, height: 42 },
    walls: [] as unknown[],
    openings: [] as unknown[],
    roomLabels: [] as unknown[],
    items: [] as unknown[],
    meta: { created: nowIso, source: 'blank' },
  };
}

function validateLayout(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  if (o.version !== LAYOUT_VERSION) return false;
  if (!Array.isArray(o.walls) || !Array.isArray(o.items)) return false;
  return true;
}

function stripHeavyBackground(layout: Record<string, unknown>) {
  const bg = layout.backgroundImage as { src?: string } | undefined;
  if (bg?.src && typeof bg.src === 'string' && bg.src.length > BG_SYNC_MAX_CHARS) {
    const next = { ...layout };
    delete next.backgroundImage;
    return next;
  }
  return layout;
}

type ServerState = {
  layout: Record<string, unknown>;
  revision: number;
  updatedAt: string;
};

export default class PlanRoom implements Party.Server {
  private s: ServerState;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(readonly room: Party.Room) {
    const t0 = new Date(0).toISOString();
    this.s = {
      layout: emptyLayout(t0) as unknown as Record<string, unknown>,
      revision: 0,
      updatedAt: t0,
    };
  }

  async onStart() {
    this.loadPromise = this.hydrateFromApi();
    await this.loadPromise;
    this.tick = setInterval(() => this.flushPersist('interval'), PERSIST_INTERVAL_MS);
  }

  private plansOrigin(): string {
    const o =
      this.room.env.PLANDS_API_ORIGIN ||
      this.room.env.VITE_PLANS_API_ORIGIN ||
      this.room.env.NEXT_PUBLIC_PLANS_API_ORIGIN ||
      '';
    return typeof o === 'string' ? o.replace(/\/$/, '') : '';
  }

  private authHeader(): Record<string, string> {
    const secret =
      this.room.env.PARTYKIT_SERVERS_SECRET || this.room.env.ROOM_SECRET || '';
    if (!secret) return {};
    return { Authorization: `Bearer ${secret}` };
  }

  private async hydrateFromApi(): Promise<void> {
    const origin = this.plansOrigin();
    if (!origin) {
      const now = new Date().toISOString();
      this.s.layout = emptyLayout(now) as unknown as Record<string, unknown>;
      this.s.revision = 1;
      this.s.updatedAt = now;
      return;
    }
    try {
      const res = await fetch(`${origin}/api/plans/${encodeURIComponent(this.room.id)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`GET ${res.status}`);
      }
      const data = (await res.json()) as {
        layout?: Record<string, unknown>;
        revision?: number;
        updatedAt?: string;
      };
      if (data.layout && validateLayout(data.layout)) {
        this.s.layout = stripHeavyBackground(data.layout);
        this.s.revision = typeof data.revision === 'number' && data.revision >= 1 ? data.revision : 1;
        this.s.updatedAt = data.updatedAt || new Date().toISOString();
        return;
      }
    } catch (e) {
      console.warn('[plan-room] hydrate failed', e);
    }
    const now = new Date().toISOString();
    this.s.layout = emptyLayout(now) as unknown as Record<string, unknown>;
    this.s.revision = 1;
    this.s.updatedAt = now;
  }

  private async ensureLoaded() {
    if (this.loadPromise) await this.loadPromise;
  }

  async onConnect(conn: Party.Connection) {
    await this.ensureLoaded();
    conn.send(
      JSON.stringify({
        type: 'state',
        layout: this.s.layout,
        revision: this.s.revision,
        updatedAt: this.s.updatedAt,
      })
    );
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    await this.ensureLoaded();
    if (typeof message !== 'string') return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }
    const t = parsed.type;
    if (t === 'presence') {
      const out = {
        ...parsed,
        peerId:
          (typeof parsed.peerId === 'string' && parsed.peerId) ||
          `conn-${sender.id}`,
      };
      this.room.broadcast(JSON.stringify(out), [sender.id]);
      return;
    }
    if (t === 'layout') {
      const layout = parsed.layout;
      if (!validateLayout(layout)) return;
      const nextLayout = stripHeavyBackground(layout as Record<string, unknown>);
      const now = new Date().toISOString();
      this.s.revision += 1;
      this.s.layout = nextLayout;
      this.s.updatedAt = now;
      const payload = JSON.stringify({
        type: 'state',
        layout: this.s.layout,
        revision: this.s.revision,
        updatedAt: this.s.updatedAt,
      });
      this.room.broadcast(payload);
      this.schedulePersist();
      return;
    }
  }

  async onClose() {
    await this.ensureLoaded();
    if ([...this.room.getConnections()].length === 0) {
      setTimeout(() => {
        if ([...this.room.getConnections()].length === 0) {
          void this.flushPersist('last-left');
        }
      }, PERSIST_DEBOUNCE_MS);
    }
  }

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.flushPersist('debounced'), PERSIST_DEBOUNCE_MS);
  }

  private async flushPersist(reason: string) {
    const origin = this.plansOrigin();
    if (!origin) {
      console.warn('[plan-room] skip persist: PLANDS_API_ORIGIN unset', reason);
      return;
    }
    const secret =
      this.room.env.PARTYKIT_SERVERS_SECRET || this.room.env.ROOM_SECRET || '';
    if (!secret) {
      console.warn('[plan-room] skip persist: PARTYKIT_SERVERS_SECRET / ROOM_SECRET unset', reason);
      return;
    }
    try {
      const body = JSON.stringify({
        layout: this.s.layout,
        revision: this.s.revision,
        updatedAt: this.s.updatedAt,
      });
      const res = await fetch(`${origin}/api/plans/${encodeURIComponent(this.room.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.authHeader() },
        body,
      });
      if (!res.ok) {
        console.warn('[plan-room] persist failed', reason, res.status);
      }
    } catch (e) {
      console.warn('[plan-room] persist error', reason, e);
    }
  }
}
