import type { DoubanItem } from './types';

/** 评分字符串 → 数值；缺失或非法评分记为 -Infinity，统一排到末尾。 */
export function ratingScore(rating?: string): number {
  if (!rating) return Number.NEGATIVE_INFINITY;
  const value = Number.parseFloat(rating);
  return Number.isFinite(value) && value > 0 ? value : Number.NEGATIVE_INFINITY;
}

/**
 * 按评分从高到低排列。
 * 同分（或都没有评分，如百度热播剧榜）时保持上游原有次序——用下标做次级比较，
 * 不依赖 Array.prototype.sort 的稳定性。
 */
export function sortByRatingDesc(items: DoubanItem[]): DoubanItem[] {
  return items
    .map((item, index) => ({ item, index, score: ratingScore(item.rating) }))
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .map((entry) => entry.item);
}
