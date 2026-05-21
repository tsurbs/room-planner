import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'crypto';
import { getKv } from '../_kv';
import { handlePreflight } from '../_cors';

export const config = {
  maxDuration: 30,
};

const LAYOUT_VERSION = 1;

function emptyLayout(createdIso: string) {
  return {
    version: LAYOUT_VERSION,
    unit: 'ft',
    name: 'Blank floorplan',
    bounds: { width: 42, height: 42 },
    walls: [],
    openings: [],
    roomLabels: [],
    items: [],
    meta: { created: createdIso, source: 'blank' },
  };
}

function planKey(id: string) {
  return `plan:${id}`;
}

const KV_HINT =
  'Configure KV_REST_API_URL and KV_REST_API_TOKEN (Vercel KV / Upstash) on this project.';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (handlePreflight(req, res, 'POST, OPTIONS')) return;

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const kv = getKv();
    if (!kv) {
      res.status(503).json({
        error: 'Storage unavailable',
        hint: KV_HINT,
      });
      return;
    }

    const id = randomUUID();
    const updatedAt = new Date().toISOString();
    const layout = emptyLayout(updatedAt);
    const revision = 1;

    try {
      await kv.set(planKey(id), JSON.stringify({ layout, revision, updatedAt }));
    } catch (err) {
      console.error('[api/plans POST] KV set failed:', err);
      res.status(503).json({
        error: 'Storage unavailable',
        hint: KV_HINT,
      });
      return;
    }

    res.status(200).json({ id });
  } catch (err) {
    console.error('[api/plans POST] Unhandled error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
