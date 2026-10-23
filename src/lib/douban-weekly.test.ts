import { describe, expect, it } from 'vitest';
import { baiduTeleplayToItem, doubanWeeklyToItem, isHotListId } from './douban-weekly';

describe('isHotListId', () => {
  it('白名单校验', () => {
    expect(isHotListId('douban_movie_weekly')).toBe(true);
    expect(isHotListId('douban_tv_korean')).toBe(true);
    expect(isHotListId('baidu_teleplay')).toBe(true);
    expect(isHotListId('maoyan')).toBe(false);
    expect(isHotListId('')).toBe(false);
  });
});

describe('doubanWeeklyToItem', () => {
  it('评分、封面（原生地址优先）、isTv 正确映射', () => {
    const item = doubanWeeklyToItem(
      {
        id: 36808876,
        rank: 3,
        title: '奥德赛',
        rating: 8.6,
        cover_proxy: 'https://doubanio.viki.moe/view/photo/p1.jpg',
        cover: 'https://img9.doubanio.com/view/photo/p1.jpg',
      },
      false
    );
    // 原生 doubanio 地址命中图片代理白名单并带 Referer 伪装，优先于 cover_proxy 镜像
    expect(item).toEqual({
      id: '36808876',
      title: '奥德赛',
      cover: 'https://img9.doubanio.com/view/photo/p1.jpg',
      rank: 3,
      rating: '8.6',
      isTv: false,
    });
  });

  it('原生 cover 缺失时回退 cover_proxy，0 分不输出 rating', () => {
    const item = doubanWeeklyToItem(
      { id: 2, title: 'y', cover_proxy: 'https://doubanio.viki.moe/view/photo/p2.jpg' },
      true
    );
    expect(item).toMatchObject({ cover: 'https://doubanio.viki.moe/view/photo/p2.jpg', isTv: true });
    const zero = doubanWeeklyToItem({ id: 1, title: 'x', cover: 'c', rating: 0 }, true);
    expect(zero).toMatchObject({ cover: 'c', isTv: true });
    expect(zero?.rating).toBeUndefined();
  });

  it('缺 id 或标题的脏数据丢弃，但无封面条目保留', () => {
    expect(doubanWeeklyToItem({ title: 'x', cover: 'c' }, false)).toBeUndefined();
    expect(doubanWeeklyToItem({ id: 1, cover: 'c' }, false)).toBeUndefined();
    expect(doubanWeeklyToItem({ id: 1, title: '  ' }, false)).toBeUndefined();
    expect(doubanWeeklyToItem({ id: 1, title: 'x', rank: 5 }, false))
      .toMatchObject({ title: 'x', cover: '', rank: 5 });
  });

  it('过滤无效条目后仍保留原榜单次序和名次空缺，不按评分重排', () => {
    const raw = [
      { id: 1, rating: 9.7 },
      { id: 2, title: '第二名', rating: 7.1 },
      { id: 3, title: '第五名', rank: 5, rating: 9.3 },
    ];
    const items = raw.map((entry, i) => doubanWeeklyToItem(entry, false, i)).filter(Boolean);
    expect(items.map((item) => [item?.title, item?.rank])).toEqual([
      ['第二名', 2],
      ['第五名', 5],
    ]);
  });

  it('无效名次回退到原数组位置', () => {
    for (const rank of [0, -1, 1.5, NaN, Infinity]) {
      expect(doubanWeeklyToItem({ id: 1, title: 'x', rank }, false, 4)?.rank).toBe(5);
    }
  });
});

describe('baiduTeleplayToItem', () => {
  it('用序号生成 id，不输出 rating', () => {
    expect(baiduTeleplayToItem({ title: '某剧', cover: 'https://img.example/1.jpg' }, 3)).toEqual({
      id: 'baidu_3',
      title: '某剧',
      cover: 'https://img.example/1.jpg',
      rank: 4,
      isTv: true,
    });
  });

  it('无海报条目保留上游名次，缺标题才丢弃', () => {
    expect(baiduTeleplayToItem({ title: '某剧', cover: null, rank: 7 }, 3))
      .toMatchObject({ title: '某剧', cover: '', rank: 7 });
    expect(baiduTeleplayToItem({ cover: 'c' }, 0)).toBeUndefined();
    expect(baiduTeleplayToItem({ title: ' ', cover: 'c' }, 0)).toBeUndefined();
  });

  it('无效上游名次回退原位置', () => {
    expect(baiduTeleplayToItem({ title: '某剧', rank: -1 }, 4)?.rank).toBe(5);
  });
});
