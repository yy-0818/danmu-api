import { globals } from '../configs/globals.js';
import { getCommentCache, setCommentCache } from './cache-util.js';
import { log } from './log-util.js';

const MAX_BYTES = 2 * 1024 * 1024;
const encode = value => new TextEncoder().encode(value);

function connection() {
  if (!globals.redisValid || !(globals.commentCacheMinutes > 0)) return null;
  try {
    const url = new URL(globals.redisUrl);
    if (!['https:', 'http:'].includes(url.protocol) || !globals.redisToken) return null;
    return { url: url.href.replace(/\/$/, ''), token: globals.redisToken };
  } catch { return null; }
}

export async function sharedCommentKey(videoUrl) {
  // Output settings (including offsets/filters) must not share incompatible results.
  const input = JSON.stringify([videoUrl, globals.envs]);
  const digest = await crypto.subtle.digest('SHA-256', encode(input));
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return `danmu:comments:v1:${hash}`;
}

async function command(conn, parts) {
  const response = await fetch(conn.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(parts), signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('Redis HTTP error');
  const data = await response.json();
  if (data.error) throw new Error('Redis command error');
  return data.result;
}

export async function getSharedCommentCache(videoUrl) {
  const local = getCommentCache(videoUrl);
  if (local !== null) return local;
  const conn = connection();
  if (!conn) return null;
  try {
    const raw = await command(conn, ['GET', await sharedCommentKey(videoUrl)]);
    if (typeof raw !== 'string' || encode(raw).length > MAX_BYTES) return null;
    const entry = JSON.parse(raw);
    const ttl = globals.commentCacheMinutes * 60000;
    if (!Array.isArray(entry.comments) || !entry.comments.length ||
        !Number.isFinite(entry.timestamp) || entry.timestamp > Date.now() ||
        Date.now() - entry.timestamp >= ttl ||
        entry.comments.length < Math.max(0, globals.commentCacheMinCount || 0)) return null;
    if (globals.redisUrl.replace(/\/$/, '') !== conn.url || globals.redisToken !== conn.token) return null;
    setCommentCache(videoUrl, entry.comments);
    // Preserve original age rather than extending the shared entry's lifetime.
    globals.commentCache.get(videoUrl).timestamp = entry.timestamp;
    log('info', `[cache] Redis comment cache hit (${entry.comments.length} comments)`);
    return entry.comments;
  } catch {
    log('warn', '[cache] Shared comment cache unavailable; fetching source');
    return null;
  }
}

export async function setSharedCommentCache(videoUrl, comments) {
  setCommentCache(videoUrl, comments);
  const conn = connection();
  if (!conn || !Array.isArray(comments) || !comments.length ||
      comments.length < Math.max(0, globals.commentCacheMinCount || 0)) return;
  try {
    const raw = JSON.stringify(globals.commentCache.get(videoUrl));
    if (encode(raw).length > MAX_BYTES) return;
    const ttl = Math.max(1, Math.ceil(globals.commentCacheMinutes * 60));
    await command(conn, ['SET', await sharedCommentKey(videoUrl), raw, 'EX', ttl]);
  } catch {
    log('warn', '[cache] Shared comment cache write failed; memory cache retained');
  }
}
