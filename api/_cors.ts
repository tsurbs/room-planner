import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Enables browser-origin clients (e.g. localhost dev) when using
 * `<meta name="room-planner-api-base" content="https://your-deployment/">`.
 */
export function writeCors(req: VercelRequest, res: VercelResponse, allowedMethods: string) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', allowedMethods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/** Returns true if response was finalized (caller should return). */
export function handlePreflight(req: VercelRequest, res: VercelResponse, allowedMethods: string): boolean {
  writeCors(req, res, allowedMethods);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
