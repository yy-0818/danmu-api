import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from '../configs/globals.js';
import { pingRedis, getRedisKey, setRedisKey, setRedisKeyWithExpiry, runPipeline } from '../utils/redis-util.js';
import { listLocalDanmu, getLocalDanmu, findLocalDanmu, saveLocalDanmu, removeLocalDanmu } from '../utils/local-danmu-store.js';

test('Redis 未配置、不完整或 REST URL 无效时不发送网络请求', async () => {
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected request'); };
  try {
    for (const env of [{}, { UPSTASH_REDIS_REST_URL: 'https://redis.example.test' }, { UPSTASH_REDIS_REST_TOKEN: 'test' },
      { UPSTASH_REDIS_REST_URL: '/redis', UPSTASH_REDIS_REST_TOKEN: 'test' },
      { UPSTASH_REDIS_REST_URL: 'redis://localhost:6379', UPSTASH_REDIS_REST_TOKEN: 'test' }]) {
      Globals.init({ ...env, LOG_LEVEL: 'error' }); Globals.deployPlatform = 'vercel';
      assert.equal(await pingRedis(), undefined);
      assert.equal(await getRedisKey('localDanmu:index'), undefined);
      assert.deepEqual(await setRedisKey('localDanmu:index', []), { result: 'ERROR' });
      assert.deepEqual(await setRedisKeyWithExpiry('localDanmu:index', [], 60), { result: 'ERROR' });
      assert.equal(await runPipeline([['GET', 'localDanmu:index']]), undefined);
      assert.deepEqual(await listLocalDanmu(), []);
      assert.equal(await getLocalDanmu('missing'), null);
      assert.equal(await findLocalDanmu({ title: '星期三', season: 1, episode: 1 }), null);
      assert.equal(Globals.logBuffer.some(entry => String(entry.message).includes('ERR_INVALID_URL')), false);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('云端 Redis 未连接时读操作跳过，写入和删除明确失败', async () => {
  Globals.init({ UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test', LOG_LEVEL: 'error' });
  Globals.deployPlatform = 'vercel'; Globals.redisValid = false;
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected request'); };
  try {
    assert.deepEqual(await listLocalDanmu(), []);
    assert.equal(await getLocalDanmu('missing'), null);
    await assert.rejects(() => saveLocalDanmu({ resourceKey: 'test' }), /Redis 未连接/);
    await assert.rejects(() => removeLocalDanmu('test'), /Redis 未连接/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('有效 Redis 配置和连接仍正常读取本地弹幕索引', async () => {
  Globals.init({ UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test', LOG_LEVEL: 'error' });
  Globals.deployPlatform = 'vercel'; Globals.redisValid = true;
  const originalFetch = globalThis.fetch; const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url)); assert.equal(options.headers.Authorization, 'Bearer test');
    return new Response(JSON.stringify({ result: JSON.stringify([{ resourceKey: 'one', title: 'test', updatedAt: '2026-11-15' }]) }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    assert.equal((await listLocalDanmu())[0].resourceKey, 'one');
    assert.deepEqual(requests, ['https://redis.example.test/get/localDanmu:index']);
  } finally { globalThis.fetch = originalFetch; }
});
