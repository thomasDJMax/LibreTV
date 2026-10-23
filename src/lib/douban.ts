import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

/**
 * 豆瓣推荐数据获取（服务端直连，带内存缓存与降级链）。
 * 旧版在浏览器里经公共 CORS 代理请求豆瓣（隐私差且不稳定），
 * 重构后由服务端直连，仅在直连被拒时降级到公共代理。
 */

const DOUBAN_API = 'https://movie.douban.com/j/search_subjects';
const DOUBAN_FILTER_API = 'https://movie.douban.com/j/new_search_subjects';
const CACHE_TTL = 10 * 60 * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface DoubanRawSubject {
  id: string;
  title: string;
  cover: string;
  rate: string;
  url?: string;
}

function fallbackProxies(): string[] {
  const proxies: string[] = [];
  if (process.env.FALLBACK_CORS_PROXY) proxies.push(process.env.FALLBACK_CORS_PROXY);
  return proxies;
}

export async function fetchDoubanRecommend(
  type: 'movie' | 'tv',
  tag: string,
  pageStart: number,
  pageSize: number,
  sort: 'recommend' | 'rank' | 'time' = 'recommend'
): Promise<DoubanItem[]> {
  const cacheKey = `douban:${type}:${tag}:${pageStart}:${pageSize}:${sort}`;
  const cached = getCache<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  const target = `${DOUBAN_API}?type=${type}&tag=${encodeURIComponent(tag)}&sort=${sort}&page_limit=${pageSize}&page_start=${pageStart}`;
  const raw = await fetchDoubanSubjects(target, 'subjects');
  const items = raw.map((s) => subjectToItem(s, type === 'tv'));
  setCache(cacheKey, items, CACHE_TTL);
  return items;
}

async function fetchDoubanSubjects(target: string, field: 'subjects' | 'data'): Promise<DoubanRawSubject[]> {
  let raw: DoubanRawSubject[] | undefined;

  // 1) 服务端直连
  try {
    const res = await fetchUpstream(target, {
      timeoutMs: 8000,
      headers: { 'User-Agent': UA, Referer: 'https://movie.douban.com/', Accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as Partial<Record<typeof field, DoubanRawSubject[]>>;
      if (Array.isArray(data[field])) raw = data[field];
    }
  } catch {
    // 忽略，走降级
  }

  // 2) 降级：经 FALLBACK_CORS_PROXY
  if (!raw) {
    for (const proxy of fallbackProxies()) {
      try {
        const res = await fetchUpstream(proxy + encodeURIComponent(target), {
          timeoutMs: 8000,
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const data = (await res.json()) as Partial<Record<typeof field, DoubanRawSubject[]>>;
          if (Array.isArray(data[field])) raw = data[field];
          if (raw) break;
        }
      } catch {
        // 继续尝试下一个
      }
    }
  }

  if (!raw) throw new Error('豆瓣推荐获取失败');

  return raw.filter((s) => s && s.id && typeof s.title === 'string' && s.title.trim());
}

function subjectToItem(s: DoubanRawSubject, isTv: boolean): DoubanItem {
  return {
    id: String(s.id),
    title: s.title,
    cover: typeof s.cover === 'string' ? s.cover : '',
    rating: s.rate && s.rate !== '0' ? s.rate : undefined,
    isTv,
  };
}

/**
 * 旧「韩剧」标签包含韩综；新版地区标签偶有错误。两份目录按条目 ID 交叉确认，
 * 只保留同时属于「韩剧」和「韩国电视剧」的作品，沿用上游口碑次序。
 * 两个有界请求并行，不逐条抓详情，也不把失败降级成其他地区榜单。
 */
export async function fetchKoreanDramaRanking(): Promise<DoubanItem[]> {
  const query = new URLSearchParams({
    sort: 'S', range: '0,10', tags: '电视剧', countries: '韩国', start: '0', limit: '40',
  });
  const [korean, dramas] = await Promise.all([
    fetchDoubanRecommend('tv', '韩剧', 0, 100, 'rank'),
    fetchDoubanSubjects(`${DOUBAN_FILTER_API}?${query}`, 'data'),
  ]);
  const dramaIds = new Set(dramas.map((item) => String(item.id)));
  const seen = new Set<string>();
  const items = korean
    .filter((item) => {
      const id = item.id;
      if (!dramaIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, 20)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  if (items.length === 0) throw new Error('韩剧口碑榜暂时无法获取');
  return items;
}
