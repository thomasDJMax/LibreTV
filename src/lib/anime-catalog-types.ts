import type { DoubanItem } from './types';

export const ANIME_CATEGORIES = ['all', 'china', 'japan', 'western', 'movie'] as const;
export const ANIME_SORTS = ['heat', 'rank'] as const;
export type AnimeCategory = (typeof ANIME_CATEGORIES)[number];
export type AnimeSort = (typeof ANIME_SORTS)[number];

export interface AnimeCatalogQuery {
  category: AnimeCategory;
  sort: AnimeSort;
  year: number | null;
  keyword: string;
  page: number;
}

export interface AnimeCatalogItem extends DoubanItem {
  year?: number;
  platform?: string;
  /** Bangumi 全站口碑排名，不是当前列表的序号。 */
  rank?: number;
  url: string;
}

export interface AnimeCatalogResponse {
  items: AnimeCatalogItem[];
  query: AnimeCatalogQuery;
  page: number;
  pageSize: number;
  total: number;
  /** 搜索接口最多返回 1000 个匹配项，这不是动画数据库总量。 */
  totalCapped: boolean;
  hasMore: boolean;
  maxPages: number;
  source: 'Bangumi';
}
