import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';
import { randomUUID } from 'crypto';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const id = randomUUID();
  const updatedAt = new Date().toISOString();
  const layout = emptyLayout(updatedAt);
  const revision = 1;

  await kv.set(planKey(id), JSON.stringify({ layout, revision, updatedAt }));

  res.status(200).json({ id });
}
