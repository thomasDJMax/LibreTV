import { getCache, setCache } from './fetch-utils';
import { fetchBangumi } from './bangumi-request';
import {
  ANIME_CATEGORIES,
  ANIME_SORTS,
  type AnimeCatalogItem,
  type AnimeCatalogQuery,
  type AnimeCatalogResponse,
  type AnimeCategory,
  type AnimeSort,
} from './anime-catalog-types';

const API = 'https://api.bgm.tv';
const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';
const CACHE_TTL = 30 * 60 * 1000;
export const ANIME_PAGE_SIZE = 20;
// Bangumi 搜索接口实际最多每页 20 条；目录和搜索统一页长，避免夹断后漏项。
const SEARCH_LIMIT = 1000;
const MAX_CATALOG_PAGES = 2000;
const PARAMS = new Set(['category', 'sort', 'year', 'keyword', 'page']);
const CATEGORY_TAGS: Partial<Record<AnimeCategory, string>> = {
  china: '中国', japan: '日本', western: '欧美', movie: '剧场版',
};

export class AnimeQueryError extends Error {}

/** 只有全部/电影的无关键词口碑榜能使用不限 1000 条的目录接口。 */
export function usesAnimeBrowse(query: AnimeCatalogQuery): boolean {
  return query.sort === 'rank' && !query.keyword && (query.category === 'all' || query.category === 'movie');
}

export function parseAnimeQuery(params: URLSearchParams, currentYear = new Date().getFullYear()): AnimeCatalogQuery {
  for (const key of params.keys()) {
    if (!PARAMS.has(key) || params.getAll(key).length !== 1) throw new AnimeQueryError('动漫筛选参数无效');
  }
  const category = params.get('category') || 'all';
  const sort = params.get('sort') || 'heat';
  if (!ANIME_CATEGORIES.includes(category as AnimeCategory)) throw new AnimeQueryError('不支持的动漫分类');
  if (!ANIME_SORTS.includes(sort as AnimeSort)) throw new AnimeQueryError('不支持的动漫排序');
  const rawYear = params.get('year') || 'all';
  const year = rawYear === 'all' ? null : /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > currentYear + 1)) {
    throw new AnimeQueryError('年份超出可用范围');
  }
  const keyword = (params.get('keyword') || '').trim();
  if (keyword.length > 80 || /[\u0000-\u001f\u007f]/.test(keyword)) throw new AnimeQueryError('关键词过长或包含无效字符');
  const rawPage = params.get('page') || '1';
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
  const query = { category: category as AnimeCategory, sort: sort as AnimeSort, year, keyword, page };
  const maxPages = usesAnimeBrowse(query) ? MAX_CATALOG_PAGES : Math.ceil(SEARCH_LIMIT / ANIME_PAGE_SIZE);
  if (!Number.isSafeInteger(page) || page < 1 || page > maxPages) throw new AnimeQueryError('页码超出可用范围');
  return query;
}

export function buildAnimeRequest(query: AnimeCatalogQuery): { url: string; options: RequestInit } {
  const offset = (query.page - 1) * ANIME_PAGE_SIZE;
  const params = new URLSearchParams({ limit: String(ANIME_PAGE_SIZE), offset: String(offset) });
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (usesAnimeBrowse(query)) {
    params.set('type', '2');
    params.set('sort', 'rank');
    if (query.category === 'movie') params.set('cat', '3');
    if (query.year !== null) params.set('year', String(query.year));
    return { url: `${API}/v0/subjects?${params}`, options: { headers } };
  }
  const filter: Record<string, unknown> = { type: [2], nsfw: false };
  const tag = CATEGORY_TAGS[query.category];
  if (tag) filter.meta_tags = [tag];
  if (query.sort === 'rank') filter.rank = ['>0']; // 上游会把未上榜的 rank=0 排在正排名之前。
  if (query.year !== null) filter.air_date = [`>=${query.year}-01-01`, `<${query.year + 1}-01-01`];
  return {
    url: `${API}/v0/search/subjects?${params}`,
    options: {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: query.keyword, sort: query.sort, filter }),
    },
  };
}

type Subject = {
  id?: number;
  type?: number;
  name?: string;
  name_cn?: string;
  nsfw?: boolean;
  date?: string | null;
  platform?: string;
  images?: { common?: string; medium?: string; large?: string };
  rating?: { score?: number; rank?: number };
};

export function animeSubjectToItem(subject: Subject): AnimeCatalogItem | undefined {
  if (!subject || typeof subject !== 'object') return undefined;
  const title = (typeof subject.name_cn === 'string' && subject.name_cn.trim()) || (typeof subject.name === 'string' && subject.name.trim());
  if (!Number.isSafeInteger(subject.id) || (subject.id ?? 0) <= 0 || !title || subject.nsfw === true || subject.type !== 2) return undefined;
  const image = subject.images?.common || subject.images?.medium || subject.images?.large || '';
  // 封面缺失不丢掉冷门/早期作品；前端显示占位图。
  const cover = typeof image === 'string' && /^https?:\/\//i.test(image) ? image : '';
  const score = subject.rating?.score;
  const rank = subject.rating?.rank;
  const year = typeof subject.date === 'string' && /^\d{4}-/.test(subject.date) ? Number(subject.date.slice(0, 4)) : undefined;
  return {
    id: String(subject.id), title, cover,
    ...(typeof score === 'number' && Number.isFinite(score) && score > 0 && score <= 10 ? { rating: score.toFixed(1) } : {}),
    ...(typeof rank === 'number' && Number.isSafeInteger(rank) && rank > 0 ? { rank } : {}),
    ...(year ? { year } : {}),
    ...(typeof subject.platform === 'string' ? { platform: subject.platform } : {}),
    isTv: subject.platform !== '剧场版',
    url: `https://bgm.tv/subject/${subject.id}`,
  };
}

export async function fetchAnimeCatalog(query: AnimeCatalogQuery): Promise<AnimeCatalogResponse> {
  const key = `anime:v2:${JSON.stringify(query)}`;
  const cached = getCache<AnimeCatalogResponse>(key);
  if (cached) return cached;
  const { url, options } = buildAnimeRequest(query);
  const response = await fetchBangumi(url, { ...options, timeoutMs: 10000 });
  if (!response.ok) throw new Error(`动漫目录暂时不可用 (${response.status})`);
  const raw = await response.json() as { data?: Subject[]; total?: number; offset?: number; limit?: number };
  if (!raw || !Array.isArray(raw.data) || !Number.isSafeInteger(raw.total) || (raw.total ?? -1) < 0) {
    throw new Error('动漫目录返回的数据无效');
  }
  const offset = (query.page - 1) * ANIME_PAGE_SIZE;
  if (raw.offset !== offset || raw.limit !== ANIME_PAGE_SIZE) throw new Error('动漫目录分页数据不匹配');
  const browse = usesAnimeBrowse(query);
  const upperLimit = browse ? MAX_CATALOG_PAGES * ANIME_PAGE_SIZE : SEARCH_LIMIT;
  const total = Math.min(raw.total!, upperLimit);
  const seen = new Set<string>();
  const items = raw.data.slice(0, ANIME_PAGE_SIZE).map(animeSubjectToItem).filter((item): item is AnimeCatalogItem => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const result: AnimeCatalogResponse = {
    items, query, page: query.page, pageSize: ANIME_PAGE_SIZE, total,
    totalCapped: raw.total! >= upperLimit,
    maxPages: Math.ceil(total / ANIME_PAGE_SIZE),
    hasMore: raw.data.length > 0 && offset + raw.data.length < total,
    source: 'Bangumi',
  };
  setCache(key, result, CACHE_TTL);
  return result;
}
