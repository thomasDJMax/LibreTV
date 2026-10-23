import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDoubanRecommend, fetchKoreanDramaRanking } from './douban';
import { fetchHotList } from './douban-weekly';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

vi.mock('./fetch-utils', () => ({
  fetchUpstream: vi.fn(),
  getCache: vi.fn(),
  setCache: vi.fn(),
}));

const fetchMock = vi.mocked(fetchUpstream);
const subject = (id: string, title: string, rate = '9.2') => ({ id, title, rate, cover: '' });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('FALLBACK_CORS_PROXY', '');
});

function mockCatalogs(korean: unknown[], dramas: unknown[]) {
  fetchMock.mockImplementation(async (target) => {
    const url = new URL(target);
    return Response.json(url.pathname.endsWith('/new_search_subjects')
      ? { data: dramas }
      : { subjects: korean });
  });
}

describe('fetchDoubanRecommend', () => {
  it('旧调用默认 recommend，显式口碑排序使用独立缓存键', async () => {
    mockCatalogs([subject('1', '请回答1988')], []);
    await fetchDoubanRecommend('tv', '韩剧', 0, 20);
    await fetchDoubanRecommend('tv', '韩剧', 0, 20, 'rank');
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get('sort')))
      .toEqual(['recommend', 'rank']);
    expect(vi.mocked(getCache).mock.calls.map(([key]) => key)).toEqual([
      'douban:tv:韩剧:0:20:recommend',
      'douban:tv:韩剧:0:20:rank',
    ]);
  });
});

describe('fetchKoreanDramaRanking', () => {
  it('交叉确认国别与剧集分类，去掉韩综、动画及错误地区条目并保留韩剧口碑次序', async () => {
    mockCatalogs([
      subject('4', '机智医生生活', '9.5'),
      subject('1', '请回答1988', '9.7'),
      subject('2', 'Running Man', '9.6'),
      subject('3', '奥林匹斯星传', '9.5'),
      subject('4', '重复条目'),
    ], [
      subject('1', '请回答1988', '9.7'),
      subject('5', '假面骑士电王'),
      subject('4', '机智医生生活', '9.5'),
      { id: '6', title: '' },
    ]);
    expect(await fetchKoreanDramaRanking()).toEqual([
      { id: '4', title: '机智医生生活', cover: '', rating: '9.5', isTv: true, rank: 1 },
      { id: '1', title: '请回答1988', cover: '', rating: '9.7', isTv: true, rank: 2 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].searchParams.get('page_limit')).toBe('100');
    expect(urls[1].searchParams.get('tags')).toBe('电视剧');
    expect(urls[1].searchParams.get('countries')).toBe('韩国');
    expect(urls[1].searchParams.get('limit')).toBe('40');
    for (const [, options] of fetchMock.mock.calls) expect(options?.timeoutMs).toBe(8000);
  });

  it('最多展示 20 条，并给交集作品分配连续序号', async () => {
    const entries = Array.from({ length: 40 }, (_, index) => subject(String(index + 1), `韩剧${index + 1}`));
    mockCatalogs(entries, entries);
    const items = await fetchKoreanDramaRanking();
    expect(items).toHaveLength(20);
    expect(items.at(-1)).toMatchObject({ id: '20', rank: 20 });
  });

  it('韩剧榜使用专用目录，并通过既有榜单缓存保存结果', async () => {
    mockCatalogs([subject('1', '请回答1988')], [subject('1', '请回答1988')]);
    const result = await fetchHotList('douban_tv_korean');
    expect(result[0]?.title).toBe('请回答1988');
    expect(setCache).toHaveBeenCalledWith('hot-list:douban_tv_korean', result, 3600000);
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).hostname === 'movie.douban.com')).toBe(true);
  });

  it('目录交集为空时明确报错，不回退成海外或综艺榜', async () => {
    mockCatalogs([subject('1', 'Running Man')], [subject('2', '假面骑士电王')]);
    await expect(fetchHotList('douban_tv_korean')).rejects.toThrow('韩剧口碑榜暂时无法获取');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setCache).mock.calls.some(([key]) => key === 'hot-list:douban_tv_korean')).toBe(false);
  });

  it('任一路上游失败时明确报错', async () => {
    fetchMock.mockImplementation(async (target) => new URL(target).pathname.endsWith('/new_search_subjects')
      ? new Response('unavailable', { status: 503 })
      : Response.json({ subjects: [subject('1', '请回答1988')] }));
    await expect(fetchKoreanDramaRanking()).rejects.toThrow('豆瓣推荐获取失败');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('上游结构错误时明确报错', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: {} }));
    await expect(fetchKoreanDramaRanking()).rejects.toThrow('豆瓣推荐获取失败');
  });
});
