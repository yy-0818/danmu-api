import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from '../configs/globals.js';
import { addEpisode, findUrlById, findTitleById, getEpisodeIdFloor } from '../utils/cache-util.js';

test('人人视频 ID 在实例缓存丢失后仍能还原，并与普通自增 ID 隔离', () => {
  Globals.init({});
  Globals.animes = []; Globals.searchCache = new Map(); Globals.favoriteCache = new Map();
  Globals.episodeIds = []; Globals.episodeNum = 10001;
  const first = addEpisode('40277-287463', '【renren】 第01集');
  const second = addEpisode('53203-400001', '【renren】 第01集');
  assert.ok(Number.isSafeInteger(first.id));
  assert.notEqual(first.id, second.id);
  assert.equal(getEpisodeIdFloor(), 10001);
  assert.equal(addEpisode('https://v.qq.com/a', '【qq】 第01集').id, 10002);
  Globals.animes = []; Globals.episodeIds = []; Globals.searchCache = new Map();
  assert.equal(findUrlById(first.id), '40277-287463');
  assert.equal(findUrlById(second.id), '53203-400001');
  assert.match(findTitleById(first.id), /renren/);
  assert.equal(findUrlById(10053), null);
  assert.equal(addEpisode('40277-287463', '【renren】 第01集').id, first.id);
});
