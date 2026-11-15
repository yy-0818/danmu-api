import { globals } from '../configs/globals.js';
import { runPipeline } from './redis-util.js';

const LIST = 'danmu:requests:v1:recent';
export function requestDayKey(now = Date.now()) {
  // The UI serves Chinese users; use a stable UTC+8 day across all regions.
  return 'danmu:requests:v1:day:' + new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}
const APPEND = `redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
redis.call('EXPIRE', KEYS[1], 604800)
local count = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 172800)
return count`;

export async function appendSharedRequestRecord(record) {
  if (!globals.redisValid) return false;
  // A client-supplied request body must not inflate shared log storage.
  let raw = JSON.stringify(record);
  if (raw.length > 16000) raw = JSON.stringify({ ...record, params: { note: '请求体过大，未记录正文' } });
  const results = await runPipeline([['EVAL', APPEND, 2, LIST, requestDayKey(), raw, globals.MAX_RECORDS]], { timeoutMs: 3000 });
  return Number.isFinite(results?.[0]?.result) && !results[0].error;
}

export async function readSharedRequestRecords() {
  if (!globals.redisValid) return null;
  const results = await runPipeline([['LRANGE', LIST, 0, globals.MAX_RECORDS - 1], ['GET', requestDayKey()]], { timeoutMs: 3000 });
  if (!Array.isArray(results?.[0]?.result) || results.some(item => item.error)) return null;
  const records = results[0].result.flatMap(raw => {
    try { const item = JSON.parse(raw); return item && typeof item.interface === 'string' && typeof item.timestamp === 'string' ? [item] : []; }
    catch { return []; }
  });
  return { records, todayReqNum: Number(results[1]?.result) || 0 };
}

export async function clearSharedRequestRecords() {
  if (!globals.redisValid) return true;
  const results = await runPipeline([['DEL', LIST, requestDayKey()]], { timeoutMs: 3000 });
  return Number.isFinite(results?.[0]?.result) && !results[0].error;
}
