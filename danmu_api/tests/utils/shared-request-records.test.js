import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from '../../configs/globals.js';
import { appendSharedRequestRecord, readSharedRequestRecords, clearSharedRequestRecords, requestDayKey } from '../../utils/shared-request-records.js';
function reset() {
  Globals.init({ UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test', LOG_LEVEL: 'error' });
  Globals.redisValid = true; Globals.reqRecords = []; Globals.todayReqNum = 0;
}
test('request records use atomic append, survive empty instance memory, and clear together', async t => {
  reset(); let records = [], count = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const commands = JSON.parse(options.body);
    return Response.json(commands.map(c => {
      if (c[0] === 'EVAL') { assert.match(c[1], /LPUSH/); assert.match(c[1], /INCR/); records.unshift(c[5]); records = records.slice(0, c[6]); return { result: ++count }; }
      if (c[0] === 'LRANGE') return { result: records };
      if (c[0] === 'GET') return { result: String(count) };
      if (c[0] === 'DEL') { records = []; count = 0; return { result: 2 }; }
      throw Error('unexpected command');
    }));
  });
  const r = { interface: '/api/v2/comment/123', timestamp: new Date().toISOString(), method: 'GET' };
  const writes = await Promise.all(Array.from({ length: 105 }, () => appendSharedRequestRecord(r)));
  assert.ok(writes.every(Boolean));
  const result = await readSharedRequestRecords();
  assert.equal(result.records.length, 100); assert.equal(result.todayReqNum, 105);
  assert.deepEqual(result.records[0], r);
  assert.equal(await clearSharedRequestRecords(), true);
  assert.deepEqual(await readSharedRequestRecords(), { records: [], todayReqNum: 0 });
});
test('request records handle unavailable Redis without breaking playback', async t => {
  reset(); t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); });
  assert.equal(await appendSharedRequestRecord({}), false);
  assert.equal(await readSharedRequestRecords(), null);
  assert.equal(await clearSharedRequestRecords(), false);
  Globals.redisValid = false;
  assert.equal(await readSharedRequestRecords(), null);
  assert.equal(await clearSharedRequestRecords(), true);
});
test('request daily counter uses UTC+8 consistently across regions', () => {
  assert.equal(requestDayKey(Date.parse('2026-11-15T15:59:59Z')), 'danmu:requests:v1:day:2026-11-15');
  assert.equal(requestDayKey(Date.parse('2026-11-15T16:00:00Z')), 'danmu:requests:v1:day:2026-11-16');
});
