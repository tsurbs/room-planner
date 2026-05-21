import { createClient, type VercelKV } from '@vercel/kv';

let cached: VercelKV | null = null;

/**
 * Upstash REST credentials. @vercel/kv's `kv` export throws on first use if these
 * are missing — we resolve lazily and return null so routes can 503 instead of crashing.
 */
export function kvRestEnv(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL?.trim();
  const token = process.env.KV_REST_API_TOKEN?.trim();
  if (url && token) return { url, token };
  return null;
}

/** Singleton client; null when KV REST env is not configured. */
export function getKv(): VercelKV | null {
  const env = kvRestEnv();
  if (!env) return null;
  if (!cached) {
    cached = createClient(env);
  }
  return cached;
}
