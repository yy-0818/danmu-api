import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from '../../configs/globals.js';
import { getSharedCommentCache, setSharedCommentCache, sharedCommentKey } from '../../utils/shared-comment-cache.js';

const comments = [{ p: '1,1,16777215,0', m: 'shared comment' }];
function reset(extra = {}) {
  Globals.init({ UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test', COMMENT_CACHE_MINUTES: '60', COMMENT_CACHE_MIN_COUNT: '1', LOG_LEVEL: 'error', ...extra });
  Globals.commentCache = new Map();
  Globals.redisValid = true;
}
function mockRedis(t) {
  const store = new Map(); const commands = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const parts = JSON.parse(options.body); commands.push(parts);
    if (parts[0] === 'SET') store.set(parts[1], parts[2]);
    return Response.json({ result: parts[0] === 'SET' ? 'OK' : store.get(parts[1]) ?? null });
  });
  return { store, commands };
}

test('shared comments survive a cold memory cache and retain original TTL', async t => {
  reset(); const { commands } = mockRedis(t);
  await setSharedCommentCache('renren:40277-287463', comments);
  assert.equal(commands[0][0], 'SET'); assert.equal(commands[0][3], 'EX'); assert.equal(commands[0][4], 3600);
  const timestamp = Globals.commentCache.get('renren:40277-287463').timestamp;
  Globals.commentCache.clear();
  assert.deepEqual(await getSharedCommentCache('renren:40277-287463'), comments);
  assert.equal(Globals.commentCache.get('renren:40277-287463').timestamp, timestamp);
  const n = commands.length;
  await getSharedCommentCache('renren:40277-287463');
  assert.equal(commands.length, n, 'warm reads do not use Redis commands');
});

test('shared cache distinguishes episodes and output configuration', async () => {
  reset(); const first = await sharedCommentKey('renren:1-1');
  assert.notEqual(first, await sharedCommentKey('renren:1-2'));
  reset({ DANMU_OFFSET: '10' });
  assert.notEqual(first, await sharedCommentKey('renren:1-1'));
  assert.match(first, /^danmu:comments:v1:[a-f0-9]{64}$/);
});

test('shared cache rejects expired, malformed and undersized entries', async t => {
  reset(); const { store } = mockRedis(t); const key = await sharedCommentKey('x');
  for (const raw of ['invalid json', JSON.stringify({ comments, timestamp: Date.now() - 3600001 }), JSON.stringify({ comments: [], timestamp: Date.now() }), JSON.stringify({ comments, timestamp: Date.now() + 3600000 })]) {
    store.set(key, raw); assert.equal(await getSharedCommentCache('x'), null);
  }
  reset({ COMMENT_CACHE_MIN_COUNT: '2' });
  await setSharedCommentCache('x', comments);
  assert.equal(store.size, 1, 'undersized write is memory only');
});

test('Redis failures preserve memory playback and become cache misses', async t => {
  reset(); t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await setSharedCommentCache('x', comments);
  assert.deepEqual(await getSharedCommentCache('x'), comments);
  Globals.commentCache.clear(); assert.equal(await getSharedCommentCache('x'), null);
});

test('unconfigured Redis and oversized data never issue writes', async t => {
  reset(); const { commands } = mockRedis(t);
  await setSharedCommentCache('large', [{ m: 'x'.repeat(2 * 1024 * 1024), p: '0' }]);
  assert.equal(commands.length, 0);
  Globals.redisValid = false;
  assert.equal(await getSharedCommentCache('missing'), null);
  await setSharedCommentCache('small', comments);
  assert.equal(commands.length, 0);
});
