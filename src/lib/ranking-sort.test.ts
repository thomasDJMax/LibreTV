import { describe, expect, it } from 'vitest';
import { ratingScore, sortByRatingDesc } from './ranking-sort';
import type { DoubanItem } from './types';

const item = (id: string, rating?: string): DoubanItem => ({
  id,
  title: `影片${id}`,
  cover: '',
  ...(rating === undefined ? {} : { rating }),
});

describe('ratingScore', () => {
  it('解析评分字符串，缺失/非法/0 分统一为 -Infinity', () => {
    expect(ratingScore('8.6')).toBe(8.6);
    expect(ratingScore('9')).toBe(9);
    expect(ratingScore(undefined)).toBe(Number.NEGATIVE_INFINITY);
    expect(ratingScore('')).toBe(Number.NEGATIVE_INFINITY);
    expect(ratingScore('0')).toBe(Number.NEGATIVE_INFINITY);
    expect(ratingScore('abc')).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('sortByRatingDesc', () => {
  it('按评分从高到低排列', () => {
    const items = [item('a', '7.1'), item('b', '9.3'), item('c', '8.6')];
    expect(sortByRatingDesc(items).map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
  });

  it('同分保持上游原有次序', () => {
    const items = [item('a', '8.0'), item('b', '8.0'), item('c', '8.0')];
    expect(sortByRatingDesc(items).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('无评分条目（如百度热播剧榜）排在末尾并保持原顺序', () => {
    const items = [item('a'), item('b', '9.1'), item('c'), item('d', '7.5')];
    expect(sortByRatingDesc(items).map((entry) => entry.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('不修改入参数组', () => {
    const items = [item('a', '7.1'), item('b', '9.3')];
    const copy = [...items];
    sortByRatingDesc(items);
    expect(items).toEqual(copy);
  });
});
