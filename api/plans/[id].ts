import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getKv } from '../_kv';
import { handlePreflight } from '../_cors';

export const config = {
  maxDuration: 30,
};

type PlanRecord = {
  layout: unknown;
  revision: number;
  updatedAt: string;
};

const KV_HINT = 'Configure KV_REST_API_URL and KV_REST_API_TOKEN on this deployment.';

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
  try {
    if (handlePreflight(req, res, 'GET, PUT, OPTIONS')) return;

    const id = req.query.id;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Missing plan id' });
      return;
    }

    const key = planKey(id);

    const kv = getKv();
    if (!kv) {
      res.status(503).json({
        error: 'Storage unavailable',
        hint: KV_HINT,
      });
      return;
    }

    if (req.method === 'GET') {
      let raw;
      try {
        raw = await kv.get<string>(key);
      } catch (err) {
        console.error('[api/plans/:id GET] KV get failed:', err);
        res.status(503).json({
          error: 'Storage unavailable',
          hint: KV_HINT,
        });
        return;
      }
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
        res.status(401).json({
          error: 'Unauthorized',
          hint: 'Set PARTYKIT_SERVERS_SECRET on Vercel and PartyKit',
        });
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
      let existingRaw;
      try {
        existingRaw = await kv.get<string>(key);
      } catch (err) {
        console.error('[api/plans/:id PUT] KV get failed:', err);
        res.status(503).json({
          error: 'Storage unavailable',
          hint: KV_HINT,
        });
        return;
      }
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
      try {
        await kv.set(
          key,
          JSON.stringify({
            layout: body.layout,
            revision,
            updatedAt,
          })
        );
      } catch (err) {
        console.error('[api/plans/:id PUT] KV set failed:', err);
        res.status(503).json({
          error: 'Storage unavailable',
          hint: KV_HINT,
        });
        return;
      }
      res.status(200).json({ ok: true, revision, updatedAt });
      return;
    }

    res.setHeader('Allow', 'GET, PUT, OPTIONS');
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/plans/:id] Unhandled error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
