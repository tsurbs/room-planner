import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';

export const config = {
  maxDuration: 30,
};

type PlanRecord = {
  layout: unknown;
  revision: number;
  updatedAt: string;
};

function planKey(id: string) {
  return `plan:${id}`;
}

function assertPartyAuth(req: VercelRequest): boolean {
  const want = process.env.PARTYKIT_SERVERS_SECRET;
  if (!want) return false;
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return false;
  const token = h.slice(7);
  return token === want;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = req.query.id;
  if (!id || typeof id !== 'string') {
    res.status(400).json({ error: 'Missing plan id' });
    return;
  }

  const key = planKey(id);

  if (req.method === 'GET') {
    const raw = await kv.get<string>(key);
    if (!raw) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    try {
      const rec = JSON.parse(raw) as PlanRecord;
      res.status(200).json({
        layout: rec.layout,
        revision: rec.revision,
        updatedAt: rec.updatedAt,
      });
    } catch {
      res.status(500).json({ error: 'Corrupt plan data' });
    }
    return;
  }

  if (req.method === 'PUT') {
    if (!assertPartyAuth(req)) {
      res.status(401).json({ error: 'Unauthorized', hint: 'Set PARTYKIT_SERVERS_SECRET on Vercel and PartyKit' });
      return;
    }
    let body: PlanRecord;
    try {
      if (typeof req.body === 'string') body = JSON.parse(req.body) as PlanRecord;
      else body = req.body as PlanRecord;
    } catch {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid body' });
      return;
    }
    const incomingRev = typeof body.revision === 'number' ? body.revision : 0;
    const incomingAt = typeof body.updatedAt === 'string' ? body.updatedAt : '';
    const existingRaw = await kv.get<string>(key);
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw) as PlanRecord;
        const exRev = typeof existing.revision === 'number' ? existing.revision : 0;
        const exAt = existing.updatedAt || '';
        /** LWW: skip if strictly older than stored snapshot. */
        if (incomingRev < exRev && incomingAt < exAt) {
          res.status(200).json({ ok: true, skipped: true, revision: exRev, updatedAt: exAt });
          return;
        }
      } catch {
        // overwrite corrupt
      }
    }
    const revision = incomingRev >= 1 ? incomingRev : 1;
    const updatedAt = incomingAt || new Date().toISOString();
    await kv.set(
      key,
      JSON.stringify({
        layout: body.layout,
        revision,
        updatedAt,
      })
    );
    res.status(200).json({ ok: true, revision, updatedAt });
    return;
  }

  res.setHeader('Allow', 'GET, PUT');
  res.status(405).json({ error: 'Method not allowed' });
}
