import { beforeEach, describe, expect, it, vi } from 'vitest';
import { animeSubjectToItem, buildAnimeRequest, fetchAnimeCatalog, parseAnimeQuery } from './anime-catalog';
import { getCache, setCache } from './fetch-utils';
import { fetchBangumi } from './bangumi-request';
import type { AnimeCatalogQuery } from './anime-catalog-types';

vi.mock('./fetch-utils', () => ({ getCache: vi.fn(), setCache: vi.fn() }));
vi.mock('./bangumi-request', () => ({ fetchBangumi: vi.fn() }));
const query: AnimeCatalogQuery = { category: 'all', sort: 'heat', year: null, keyword: '', page: 1 };
const subject = { id: 12, type: 2, name: 'Original', name_cn: '动画甲', images: { common: 'https://lain.bgm.tv/a.jpg' }, rating: { score: 8.2, rank: 20 }, platform: 'TV', date: '1999-10-01' };
beforeEach(() => vi.clearAllMocks());

describe('动漫目录参数与上游查询', () => {
  it('缺省查询覆盖所有年代，年份、关键词、页码均进入查询', () => {
    expect(parseAnimeQuery(new URLSearchParams())).toEqual(query);
    expect(parseAnimeQuery(new URLSearchParams('category=china&sort=rank&year=1986&keyword=葫芦&page=2')))
      .toEqual({ category: 'china', sort: 'rank', year: 1986, keyword: '葫芦', page: 2 });
  });

  it('拒绝非法/重复筛选，不接受URL或虚假的最新排序，不放宽筛选', () => {
    for (const params of ['category=nope', 'sort=date', 'page=Infinity', 'page=1.5', 'page=-1', 'page=51', 'year=NaN', 'year=1899', 'year=9999', 'url=http://localhost', 'sort=heat&sort=rank', `keyword=${'a'.repeat(81)}`]) {
      expect(() => parseAnimeQuery(new URLSearchParams(params))).toThrow();
    }
    expect(parseAnimeQuery(new URLSearchParams('sort=rank&page=1000')).page).toBe(1000);
  });

  it('地区用公共标签、电影用剧场版标签，始终排除成人条目', () => {
    for (const [category, tag] of [['china', '中国'], ['japan', '日本'], ['western', '欧美'], ['movie', '剧场版']] as const) {
      const request = buildAnimeRequest({ ...query, category });
      expect(request.url).toBe('https://api.bgm.tv/v0/search/subjects?limit=20&offset=0');
      expect(JSON.parse(request.options.body as string).filter).toEqual({ type: [2], nsfw: false, meta_tags: [tag] });
    }
  });

  it('有地区的口碑排序剔除rank=0，年份用完整日期区间，第二页正确偏移', () => {
    const request = buildAnimeRequest({ ...query, category: 'western', sort: 'rank', year: 1999, page: 2, keyword: '辛普森' });
    expect(request.url).toContain('offset=20');
    expect(JSON.parse(request.options.body as string)).toEqual({ keyword: '辛普森', sort: 'rank', filter: { type: [2], nsfw: false, meta_tags: ['欧美'], rank: ['>0'], air_date: ['>=1999-01-01', '<2000-01-01'] } });
  });

  it('历年全部和动画电影口碑榜使用可超1000条的目录，保留缺完整日期老作品', () => {
    const request = buildAnimeRequest({ ...query, category: 'movie', sort: 'rank', year: 1986, page: 50 });
    const url = new URL(request.url);
    expect(url.pathname).toBe('/v0/subjects');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '20', offset: '980', type: '2', sort: 'rank', cat: '3', year: '1986' });
    expect(request.options.body).toBeUndefined();
  });
});

describe('动漫条目与分页', () => {
  it('保留片名、原始评分/排名、年代和电影类型，缺图不丢冷门作品', () => {
    expect(animeSubjectToItem(subject)).toMatchObject({ title: '动画甲', year: 1999, rating: '8.2', rank: 20, isTv: true });
    expect(animeSubjectToItem({ ...subject, platform: '剧场版', images: undefined, date: null })).toMatchObject({ cover: '', isTv: false, url: 'https://bgm.tv/subject/12' });
    expect(animeSubjectToItem({ ...subject, rating: { rank: 0, score: 0 } })).not.toHaveProperty('rank');
  });

  it('跳过成人、非动画、无标题、无效ID，拒绝可执行图片URL', () => {
    expect(animeSubjectToItem({ ...subject, nsfw: true })).toBeUndefined();
    expect(animeSubjectToItem({ ...subject, type: 1 })).toBeUndefined();
    expect(animeSubjectToItem({ ...subject, name: '', name_cn: '' })).toBeUndefined();
    expect(animeSubjectToItem({ ...subject, id: NaN })).toBeUndefined();
    expect(animeSubjectToItem({ ...subject, images: { common: 'javascript:alert(1)' } })?.cover).toBe('');
  });

  it('搜索第50页正好到1000条上限且不再加载', async () => {
    vi.mocked(fetchBangumi).mockResolvedValue(new Response(JSON.stringify({ total: 1000, limit: 20, offset: 980, data: Array.from({ length: 20 }, (_, i) => ({ ...subject, id: i + 1 })) })));
    const result = await fetchAnimeCatalog({ ...query, page: 50 });
    expect(result).toMatchObject({ total: 1000, totalCapped: true, hasMore: false, maxPages: 50 });
    expect(result.items).toHaveLength(20);
  });

  it('口碑目录可以继续到1000条以外，不把全库限制为1000', async () => {
    vi.mocked(fetchBangumi).mockResolvedValue(new Response(JSON.stringify({ total: 9094, limit: 20, offset: 1000, data: Array.from({ length: 20 }, (_, i) => ({ ...subject, id: 1001 + i })) })));
    const result = await fetchAnimeCatalog({ ...query, sort: 'rank', page: 51 });
    expect(result).toMatchObject({ total: 9094, totalCapped: false, hasMore: true, maxPages: 455 });
  });

  it('按上游原始页长度算下一页，脏条目不会提前终止目录', async () => {
    vi.mocked(fetchBangumi).mockResolvedValue(new Response(JSON.stringify({ total: 100, limit: 20, offset: 0, data: [subject, subject, { ...subject, id: 13, nsfw: true }] })));
    const result = await fetchAnimeCatalog(query);
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(setCache).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(query)), result, 1800000);
  });


  it('连续两页分别请求0和20偏移，既不重叠也不漏掉上游第21至24条', async () => {
    vi.mocked(fetchBangumi).mockImplementation(async (url) => {
      const params = new URL(url).searchParams;
      const offset = Number(params.get('offset'));
      expect(params.get('limit')).toBe('20');
      return new Response(JSON.stringify({ total: 1000, limit: 20, offset, data: Array.from({ length: 20 }, (_, index) => ({ ...subject, id: offset + index + 1 })) }));
    });
    const first = await fetchAnimeCatalog(query);
    const second = await fetchAnimeCatalog({ ...query, page: 2 });
    expect(first.items.map((item) => Number(item.id))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(second.items.map((item) => Number(item.id))).toEqual(Array.from({ length: 20 }, (_, i) => i + 21));
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(40);
    expect(fetchBangumi).toHaveBeenCalledTimes(2);
  });

  it('不足20条的真实末页保留全部余项且不再翻页', async () => {
    vi.mocked(fetchBangumi).mockResolvedValue(new Response(JSON.stringify({ total: 33, limit: 20, offset: 20, data: Array.from({ length: 13 }, (_, i) => ({ ...subject, id: i + 21 })) })));
    const result = await fetchAnimeCatalog({ ...query, sort: 'rank', year: 1986, page: 2 });
    expect(result.items).toHaveLength(13);
    expect(result).toMatchObject({ total: 33, totalCapped: false, maxPages: 2, hasMore: false });
  });

  it('缓存键包括所有筛选条件与页码', async () => {
    vi.mocked(getCache).mockReturnValue({ items: [] });
    for (const q of [query, { ...query, page: 2 }, { ...query, category: 'china' as const }, { ...query, year: 1986 }, { ...query, keyword: '龙珠' }, { ...query, sort: 'rank' as const }]) {
      await fetchAnimeCatalog(q);
    }
    expect(new Set(vi.mocked(getCache).mock.calls.map(([key]) => key)).size).toBe(6);
    expect(fetchBangumi).not.toHaveBeenCalled();
  });

  it('上游失败/分页不一致直接报错，不替换成其他分类结果', async () => {
    vi.mocked(getCache).mockReturnValue(undefined);
    vi.mocked(fetchBangumi).mockResolvedValueOnce(new Response('err', { status: 503 }));
    await expect(fetchAnimeCatalog(query)).rejects.toThrow('503');
    vi.mocked(fetchBangumi).mockResolvedValueOnce(new Response(JSON.stringify({ data: [], total: 0, offset: 20, limit: 20 })));
    await expect(fetchAnimeCatalog(query)).rejects.toThrow('分页');
    expect(setCache).not.toHaveBeenCalled();
  });
});
