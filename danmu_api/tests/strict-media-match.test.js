import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaIdentity, filterStrictCandidates, selectStrictEpisode, selectWikidataIdentity, resolveEnglishMediaIdentity } from '../utils/strict-media-match.js';
import { matchAnime } from '../apis/dandan-api.js';
import { Globals } from '../configs/globals.js';
import TencentSource from '../sources/tencent.js';

const identity = (extra = {}) => ({ title: 'Wednesday', aliases: ['Wednesday', '星期三'], kind: 'series', season: 1, episode: 1, year: null, ...extra });
const anime = (name = '星期三 第一季', year = 2022, type = '电视剧', extra = {}) => ({ animeId: 40277, bangumiId: '40277', animeTitle: `${name}(${year})【${type}】from tencent`, aliases: ['Wednesday Season 1'], typeDescription: type, type, startDate: `${year}-01-01`, source: 'tencent', ...extra });
const entity = (id, kind = 'Q5398426', year = 2022, en = 'Wednesday', zh = '星期三') => ({ id, labels: { en: { value: en }, 'zh-cn': { value: zh } }, claims: { P31: [{ mainsnak: { datavalue: { value: { id: kind } } } }], P577: [{ mainsnak: { datavalue: { value: { time: `+${year}-01-01T00:00:00Z` } } } }] } });

test('解析英文文件名、年份及三类季集格式，保留片名中的数字', () => {
  for (const file of ['Breaking.Bad.2008.S02E03.1080p.mkv', 'Breaking Bad (2008) 2x03.mp4', 'Breaking Bad 2008 Season 2 Episode 3']) {
    const got = parseMediaIdentity(file);
    assert.equal(got.title, 'Breaking Bad'); assert.equal(got.year, 2008);
    assert.equal(got.season, 2); assert.equal(got.episode, 3); assert.equal(got.kind, 'series');
  }
  const got = parseMediaIdentity('Blade.Runner.2049.2017.1080p.mkv', { title: 'Blade Runner 2049 2017', year: 2017 });
  assert.equal(got.title, 'Blade Runner 2049'); assert.equal(got.year, 2017);
  assert.equal(parseMediaIdentity('Blade.Runner.2049.2017.1080p.mkv', { title: 'Blade Runner 2049', year: 2017 }).title, 'Blade Runner 2049');
  assert.equal(parseMediaIdentity('2001.A.Space.Odyssey.1968.mkv', { title: '2001 A Space Odyssey', year: 1968 }).title, '2001 A Space Odyssey');
});

test('剧集不能匹配电影，即使没有任何剧集候选；英文部分相似也不接受', () => {
  assert.deepEqual(filterStrictCandidates([anime('一个星期三的下午', 2008, '电影', { aliases: ['A Wednesday'] })], identity()), []);
  assert.deepEqual(filterStrictCandidates([anime('星期三', 2022, '电影')], identity()), []);
  assert.equal(filterStrictCandidates([anime()], identity()).length, 1);
});

test('类型、年份、季数必须一致；已知年份缺失也拒绝', () => {
  assert.equal(filterStrictCandidates([anime()], identity({ year: 2022 })).length, 1);
  assert.deepEqual(filterStrictCandidates([anime()], identity({ year: 2025 })), []);
  assert.deepEqual(filterStrictCandidates([anime('星期三 第二季', 2025)], identity()), []);
  assert.deepEqual(filterStrictCandidates([anime()], identity({ season: 2 })), []);
  assert.deepEqual(filterStrictCandidates([anime()], identity({ kind: 'movie', season: null, episode: null })), []);
  assert.deepEqual(filterStrictCandidates([anime()], identity({ conflict: true })), []);
  assert.deepEqual(filterStrictCandidates([anime('星期三', 2022, '未知')], identity()), []);
});

test('同名翻拍无年份不自动选择；同一作品跨来源可选择', () => {
  const a = anime('Dune', 1984, '电影', { aliases: [] });
  const b = anime('Dune', 2021, '电影', { aliases: [] });
  const q = identity({ title: 'Dune', aliases: [], kind: 'movie', season: null, episode: null });
  assert.deepEqual(filterStrictCandidates([a, b], q), []);
  assert.deepEqual(filterStrictCandidates([a, b], { ...q, year: 2021 }), [b]);
  assert.equal(filterStrictCandidates([anime(), anime(undefined, undefined, undefined, { source: 'renren' })], identity()).length, 2);
});

test('集数不按数组下标猜测；越界、标题矛盾、多版本不自动取首个', () => {
  const e = { episodeId: 1, episodeNumber: '1', episodeTitle: '【renren】 第01集' };
  assert.equal(selectStrictEpisode([e], identity()), e);
  assert.equal(selectStrictEpisode([e], identity({ episode: 2 })), null);
  assert.equal(selectStrictEpisode([{ ...e, episodeTitle: '第2集' }], identity()), null);
  assert.equal(selectStrictEpisode([e, e], identity()), null);
  assert.equal(selectStrictEpisode([{ ...e, episodeTitle: '第21届美国演员工会奖电视类' }], identity()), null);
  assert.equal(selectStrictEpisode([{ ...e, episodeTitle: '第01集 预告片' }], identity()), null);
  assert.ok(selectStrictEpisode([{ ...e, episodeTitle: '第一集' }], identity()));

  assert.equal(selectStrictEpisode([e, { ...e, episodeNumber: 2 }], identity({ kind: 'movie', season: null, episode: null })), null);
});

test('元数据要求英文标题精确、类型一致且身份唯一；年份可区分翻拍', () => {
  assert.equal(selectWikidataIdentity({ Q1: entity('Q1') }, identity()).searchTitle, '星期三');
  assert.equal(selectWikidataIdentity({ Q1: entity('Q1', 'Q11424') }, identity()).metadataId, undefined);
  assert.equal(selectWikidataIdentity({ Q1: entity('Q1', undefined, undefined, 'A Wednesday') }, identity()).metadataId, undefined);
  const all = { Q1: entity('Q1'), Q2: entity('Q2', undefined, 2025) };
  assert.equal(selectWikidataIdentity(all, identity()).metadataId, undefined);
  assert.equal(selectWikidataIdentity(all, identity({ year: 2025 })).metadataId, 'Q2');
});

test('英文元数据请求有超时，缓存不串季集，失败保留原身份', async () => {
  let calls = 0;
  const get = async (url, options) => {
    assert.equal(options.timeout, 6000); calls++;
    return { data: url.includes('wbsearchentities') ? { search: [{ id: 'Q123' }] } : { entities: { Q123: entity('Q123', undefined, 2008, 'Breaking Bad', '绝命毒师') } } };
  };
  const q = identity({ title: 'Breaking Bad', aliases: ['Breaking Bad'] });
  assert.equal((await resolveEnglishMediaIdentity(q, get)).searchTitle, '绝命毒师');
  const second = await resolveEnglishMediaIdentity({ ...q, season: 2, episode: 5 }, get);
  assert.equal(second.season, 2); assert.equal(second.episode, 5); assert.equal(calls, 2);
  const fail = identity({ title: 'Unresolvable Unique Title' });
  assert.equal(await resolveEnglishMediaIdentity(fail, async () => { throw new Error('timeout'); }), fail);
});

test('严格模式 API：英文映射命中正确电视剧，不回退同名电影、错误年份或跨季', async () => {
  const oldSearch = TencentSource.prototype.search, oldHandle = TencentSource.prototype.handleAnimes;
  let rows = [];
  TencentSource.prototype.search = async () => [];
  TencentSource.prototype.handleAnimes = async (_s, _t, out, details) => {
    for (const a of rows) { out.push(a); details.set(String(a.animeId), a); }
  };
  try {
    const call = async (fileName, list) => {
      Globals.init({ STRICT_AUTO_MATCH: 'true', TITLE_MAPPING_TABLE: 'Wednesday->星期三', AUTO_MATCH_MAPPING_TABLE: 'Wednesday S01E01 -> 星期三(2022)【电视剧】 S01E01 @qq', SOURCE_ORDER: 'tencent', REMEMBER_LAST_SELECT: 'false' });
      assert.equal(Globals.envs.autoMatchMappingTable.length, 1, '测试映射必须真实生效');
      Globals.animes = []; Globals.episodeIds = []; Globals.episodeNum = 10001;
      Globals.searchCache = new Map(); Globals.favoriteCache = new Map();
      rows = list.map(a => ({ ...a, episodeCount: 2, links: [{ id: a.animeId * 10 + 1, title: '【qq】 第01集', url: 'https://v.qq.com/1' }, { id: a.animeId * 10 + 2, title: '【qq】 第02集', url: 'https://v.qq.com/2' }] }));
      const req = new Request('http://localhost/api/v2/match', { method: 'POST', body: JSON.stringify({ fileName }), headers: { 'Content-Type': 'application/json' } });
      return (await matchAnime(new URL(req.url), req, 'test')).json();
    };
    const good = await call('Wednesday S01E01', [anime()]);
    assert.equal(good.isMatched, true); assert.equal(good.matches[0].animeId, 40277);
    for (const [file, list] of [['Wednesday S01E01', [anime('星期三', 2008, '电影')]], ['Wednesday S02E01', [anime()]], ['Wednesday.2025.S01E01', [anime()]], ['Wednesday.2008.S01E01', [anime()]], ['Wednesday S01E99', [anime()]]]) {
      const bad = await call(file, list); assert.equal(bad.isMatched, false, file); assert.deepEqual(bad.matches, []);
    }
  } finally { TencentSource.prototype.search = oldSearch; TencentSource.prototype.handleAnimes = oldHandle; }
});
