import { normalizeTitleForMatch, extractSeasonNumberFromAnimeTitle } from './common-util.js';
import { httpGet } from './http-util.js';

export function titleKey(value) {
  return normalizeTitleForMatch(String(value || '').normalize('NFKC')).toLowerCase();
}

export function mediaKind(value) {
  const text = String(value || '').toLowerCase();
  if (/电影|電影|剧场版|劇場版|\bmovie\b|\bfilm\b/.test(text)) return 'movie';
  if (/电视剧|電視劇|综艺|綜藝|tvseries|tv series|\btv\b|\bseries\b|动画|動漫|动漫|anime|动画/.test(text)) return 'series';
  return null;
}

function stripCandidateTitle(value) {
  return String(value || '').replace(/(?:\s+|(?<=】))from\s+.*$/i, '').replace(/【[^】]*】/g, '')
    .replace(/[（(](?:别名|別名)[:：][^）)]*[）)]/g, '')
    .replace(/[（(](?:19|20)\d{2}[）)]/g, '')
    .replace(/\s*(?:第\s*[\d一二三四五六七八九十百]+\s*季|\bseason\s*\d+|\bs\d+)\s*$/i, '').trim();
}

export function parseMediaIdentity(fileName, parsed = {}, body = {}) {
  const clean = String(fileName || '').replace(/\.(mkv|mp4|avi|mov|m4v|ts|m2ts|iso)$/i, '');
  const token = clean.match(/(?:^|[ ._\-])S(\d{1,3})[ ._\-]*E(\d{1,4})(?=$|[ ._\-])/i)
    || clean.match(/(?:^|[ ._\-])(\d{1,3})x(\d{1,4})(?=$|[ ._\-])/i)
    || clean.match(/\bSeason\s*(\d{1,3})\s*(?:Episode|Ep)\s*(\d{1,4})\b/i);
  const seasonToken = clean.match(/\bS(?:eason\s*)?(\d{1,3})\b/i);
  const season = token ? Number(token[1]) : (seasonToken ? Number(seasonToken[1]) : parsed.season ?? null);
  const episode = token ? Number(token[2]) : parsed.episode ?? null;
  const yearTokens = [...clean.matchAll(/(?:^|[ ._(（\-])((?:19|20)\d{2})(?=$|[ ._)）\-])/g)];
  const yearToken = yearTokens.at(-1);
  const year = yearToken ? Number(yearToken[1]) : (Number(parsed.year) || null);
  let title = token ? clean.slice(0, token.index).trim() : String(parsed.title || clean);
  if (year) {
    const withoutYear = title.replace(new RegExp('[ ._(（\\-]*' + year + '[)）]?[ ._\\-]*$'), '').trim();
    if (withoutYear) title = withoutYear;
  }
  title = title.replace(/[._]/g, ' ').trim();
  title = title.replace(/\s+(?:2160p|1080p|720p|480p|WEB[- ]?DL|BluRay|HDR|HEVC|x26[45]|H26[45]).*$/i, '').trim();
  const declared = mediaKind(body.mediaType || body.typeDescription || body.type || '');
  const inferred = season !== null || episode !== null ? 'series' : null;
  return { title, aliases: [title], year, season, episode, kind: declared || inferred,
    conflict: Boolean(declared === 'movie' && inferred === 'series'),
    invalidEpisode: episode !== null && (!Number.isInteger(episode) || episode < 1),
  };
}

const FILM_CLASSES = new Set(['Q11424', 'Q1261214', 'Q24869', 'Q202866', 'Q506240']);
const SERIES_CLASSES = new Set(['Q5398426', 'Q15416', 'Q581714', 'Q7724161', 'Q639669']);
const identityCache = new Map();

export function selectWikidataIdentity(entities, identity) {
  const candidates = [];
  for (const entity of Object.values(entities || {})) {
    const english = [entity.labels?.en?.value, ...(entity.aliases?.en || []).map(x => x.value)];
    if (!english.some(x => titleKey(x) === titleKey(identity.title))) continue;
    const classes = (entity.claims?.P31 || []).map(x => x.mainsnak?.datavalue?.value?.id);
    const kind = classes.some(x => FILM_CLASSES.has(x)) ? 'movie' : classes.some(x => SERIES_CLASSES.has(x)) ? 'series' : null;
    if (!kind || (identity.kind && kind !== identity.kind)) continue;
    const dates = [...(entity.claims?.P577 || []), ...(entity.claims?.P580 || [])]
      .map(x => x.mainsnak?.datavalue?.value?.time?.match(/^\+(\d{4})/)?.[1]).filter(Boolean).map(Number);
    if (identity.year && !dates.includes(identity.year)) continue;
    const labels = ['zh-cn', 'zh-hans', 'zh'].map(l => entity.labels?.[l]?.value).filter(x => /[\u3400-\u9fff]/.test(x || ''));
    if (!labels.length) continue;
    candidates.push({ ...identity, kind, searchTitle: labels[0], aliases: [...new Set([...identity.aliases, ...english, ...labels].filter(Boolean))], metadataId: entity.id });
  }
  return candidates.length === 1 ? candidates[0] : identity;
}

export async function resolveEnglishMediaIdentity(identity, get = httpGet) {
  if (!identity.title || !/[a-z]/i.test(identity.title) || /[\u3400-\u9fff]/.test(identity.title)) return identity;
  const key = JSON.stringify([titleKey(identity.title), identity.kind, identity.year]);
  const cached = identityCache.get(key);
  if (cached && Date.now() - cached.time < 86400000) return { ...identity, ...cached.value };
  try {
    const request = async params => {
      const response = await get('https://www.wikidata.org/w/api.php?' + new URLSearchParams({ format: 'json', ...params }), {
        headers: { 'User-Agent': 'SenPlayerDanmu/1.0 (personal media title lookup)' }, timeout: 6000, retries: 0
      });
      return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    };
    const search = await request({ action: 'wbsearchentities', search: identity.title, language: 'en', limit: '8' });
    const ids = (search?.search || []).map(x => x.id).filter(x => /^Q\d+$/.test(x));
    if (!ids.length) return identity;
    const details = await request({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels|aliases|claims', languages: 'en|zh|zh-hans|zh-cn' });
    const resolved = selectWikidataIdentity(details?.entities, identity);
    if (resolved.metadataId) {
      if (identityCache.size >= 200) identityCache.delete(identityCache.keys().next().value);
      // Never cache season/episode from a different request.
      identityCache.set(key, { time: Date.now(), value: { searchTitle: resolved.searchTitle, kind: resolved.kind, aliases: resolved.aliases, metadataId: resolved.metadataId } });
    }
    return resolved;
  } catch { return identity; } // A failed title lookup must never broaden the match.
}

export function filterStrictCandidates(animes, identity) {
  if (identity.conflict || identity.invalidEpisode || !titleKey(identity.title)) return [];
  const keys = new Set([identity.title, identity.searchTitle, ...(identity.aliases || [])].filter(Boolean).map(titleKey));
  let candidates = (animes || []).filter(anime => {
    const names = [anime.animeTitle, ...(anime.aliases || [])].filter(Boolean);
    const inline = String(anime.animeTitle || '').match(/[（(](?:别名|別名)[:：]([^）)]+)[）)]/);
    if (inline) names.push(inline[1]);
    if (!names.some(x => keys.has(titleKey(stripCandidateTitle(x))))) return false;
    const kind = mediaKind(anime.typeDescription) || mediaKind(anime.type) || mediaKind(anime.animeTitle);
    if (!kind || (identity.kind && identity.kind !== kind)) return false;
    const yearMatch = String(anime.startDate || '').match(/^((?:19|20)\d{2})/)
      || String(anime.animeTitle || '').match(/[（(]((?:19|20)\d{2})[）)]/);
    const year = Number(yearMatch?.[1]) || null;
    if (identity.year && year !== Number(identity.year)) return false;
    let season = null;
    for (const name of names) {
      const explicit = extractSeasonNumberFromAnimeTitle(name).season;
      if (explicit !== null && explicit !== undefined) { season = explicit; break; }
    }
    if (kind === 'series' && identity.season !== null && identity.season !== undefined && (season ?? 1) !== Number(identity.season)) return false;
    return true;
  });
  // Cross-source copies of one work are fine. Different years/types/seasons need disambiguation.
  const groups = new Set(candidates.map(a => [mediaKind(a.typeDescription) || mediaKind(a.type) || mediaKind(a.animeTitle),
    (String(a.startDate || '').match(/^\d{4}/) || String(a.animeTitle || '').match(/[（(](\d{4})[）)]/)?.slice(1))?.[0] || 'unknown',
    extractSeasonNumberFromAnimeTitle(a.animeTitle).season ?? 1].join(':')));
  if (groups.size > 1) candidates = [];
  if (!identity.kind && candidates.some(a => mediaKind(a.typeDescription) === 'series') && identity.episode == null) return [];
  return candidates;
}

function episodeNumberFromText(title) {
  const numbered = title.match(/第\s*([0-9零〇一二两三四五六七八九十百]+)\s*[集话話回]/);
  if (numbered) {
    if (/^\d+$/.test(numbered[1])) return Number(numbered[1]);
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let result = 0, digit = 0;
    for (const ch of numbered[1]) {
      if (ch === '十' || ch === '百') { result += (digit || 1) * (ch === '十' ? 10 : 100); digit = 0; }
      else digit = digits[ch];
    }
    return result + digit;
  }
  const episode = title.match(/(?:\bS\d+E|\bEP(?:ISODE)?\s*|\bE\s*)(\d+)\b/i)
    || title.match(/^\s*(?:【[^】]+】\s*)?(\d+)\s*$/);
  return episode ? Number(episode[1]) : null;
}

export function selectStrictEpisode(episodes, identity) {
  if (!Array.isArray(episodes) || !episodes.length) return null;
  const mainEpisodes = episodes.filter(ep => {
    let title = String(ep.episodeTitle || '');
    for (const name of [identity.title, identity.searchTitle, ...(identity.aliases || [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
      title = title.split(name).join('');
    }
    return !/预告|預告|花絮|片花|特辑|特輯|幕后|幕後|专访|專訪|片段|演员工会|颁奖|頒獎|获奖|獲獎|\b(?:trailer|teaser|clip|recap)\b|behind the scenes/i.test(title);
  });
  if (identity.kind === 'movie' || (identity.kind === null && identity.episode == null)) return mainEpisodes.length === 1 ? mainEpisodes[0] : null;
  if (identity.episode == null) return null;
  // 上游 episodeNumber 可能只是数组下标。剧集必须有标题中的明确集号，不能把花絮排位当集号。
  const matches = mainEpisodes.filter(ep => episodeNumberFromText(String(ep.episodeTitle || '')) === Number(identity.episode));
  return matches.length === 1 ? matches[0] : null;
}
