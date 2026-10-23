'use client';

import { memo, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { ANIME_CATEGORIES, ANIME_SORTS, type AnimeCatalogItem, type AnimeCatalogQuery, type AnimeCategory } from '@/lib/anime-catalog-types';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { Icon } from './icon';

const CATEGORIES: { id: AnimeCategory; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'china', label: '国漫' },
  { id: 'japan', label: '日漫' }, { id: 'western', label: '欧美动画' },
  { id: 'movie', label: '动画电影' },
];
const DEFAULT_QUERY: AnimeCatalogQuery = { category: 'all', sort: 'heat', year: null, keyword: '', page: 1 };
const PREFERENCE_KEY = 'libretv:anime-catalog:v1';

export function AnimeCatalog({ onPick }: { onPick: (title: string) => void }) {
  const [filters, setFilters] = useState<AnimeCatalogQuery>(DEFAULT_QUERY);
  const [keyword, setKeyword] = useState('');
  const [ready, setReady] = useState(false);
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || 'null') as AnimeCatalogQuery | null;
      if (saved && ANIME_CATEGORIES.includes(saved.category) && ANIME_SORTS.includes(saved.sort)
        && (saved.year === null || (Number.isInteger(saved.year) && saved.year >= 1900 && saved.year <= currentYear + 1))
        && typeof saved.keyword === 'string' && saved.keyword.length <= 80 && !/[\u0000-\u001f\u007f]/.test(saved.keyword)
        && Number.isInteger(saved.page) && saved.page >= 1
        && saved.page <= (saved.sort === 'rank' && !saved.keyword.trim() && ['all', 'movie'].includes(saved.category) ? 2000 : 50)) {
        setFilters(saved);
        setKeyword(saved.keyword);
      }
    } catch { /* 偏好不可读时仍可浏览。 */ }
    setReady(true);
  }, [currentYear]);

  const update = (changes: Partial<AnimeCatalogQuery>) => {
    const next = { ...filters, page: 1, ...changes };
    setFilters(next);
    try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(next)); } catch { /* 忽略偏好保存失败。 */ }
  };
  const query = useQuery({
    queryKey: ['anime-catalog', filters],
    queryFn: ({ signal }) => api.animeCatalog(filters, signal),
    enabled: ready,
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const data = query.data;
  const loading = !ready || query.isLoading;
  const reset = () => { setKeyword(''); update(DEFAULT_QUERY); };

  return (
    <div className="pt-4" aria-label="动漫片库">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="动漫地区与类型">
        {CATEGORIES.map((category) => (
          <button type="button" key={category.id} aria-pressed={filters.category === category.id}
            className={cn('chip px-3 py-1.5 text-xs', filters.category === category.id ? 'bg-accent/15 text-accent' : 'bg-chip text-muted hover:bg-hover hover:text-content')}
            onClick={() => update({ category: category.id })}>{category.label}</button>
        ))}
      </div>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-chip p-1" role="group" aria-label="动漫排序">
          {([{ id: 'heat', label: '热门' }, { id: 'rank', label: '口碑' }] as const).map((sort) => (
            <button type="button" key={sort.id} aria-pressed={filters.sort === sort.id}
              className={cn('btn px-3 text-xs', filters.sort === sort.id ? 'bg-accent text-on-accent' : 'text-muted hover:text-content')}
              onClick={() => update({ sort: sort.id })}>{sort.label}</button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          年份
          <select aria-label="动漫年份" value={filters.year ?? 'all'} onChange={(event) => update({ year: event.target.value === 'all' ? null : Number(event.target.value) })}
            className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-content focus:outline-none focus:ring-2 focus:ring-accent/50">
            <option value="all">不限年份</option>
            {Array.from({ length: currentYear - 1898 }, (_, index) => currentYear + 1 - index).map((year) => <option key={year} value={year}>{year} 年</option>)}
          </select>
        </label>
        <form className="flex min-w-0 flex-1 gap-2 sm:min-w-64" onSubmit={(event) => { event.preventDefault(); update({ keyword: keyword.trim() }); }}>
          <input aria-label="动漫片名" placeholder="找热门或历年动漫" maxLength={80} value={keyword} onChange={(event) => setKeyword(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-content placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/50" />
          <button type="submit" className="btn-ghost shrink-0">查找动漫</button>
        </form>
        <button type="button" className="text-xs text-muted hover:text-accent" onClick={reset}>重置筛选</button>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-faint" aria-live="polite">
        Bangumi · 热门与历年作品{data ? ` · ${data.totalCapped ? '前 ' : ''}${data.total.toLocaleString()} 条匹配` : ''} · 点击条目搜索片源
      </p>
      {loading ? (
        <div role="status" aria-label="正在加载动漫" className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => <div key={index} aria-hidden className="h-28 rounded-xl border border-line bg-card" />)}
        </div>
      ) : query.isError && !data ? (
        <div role="status" className="rounded-xl border border-line bg-card p-8 text-center">
          <p className="text-sm text-muted">动漫目录暂时加载失败，请稍后重试。</p>
          <button type="button" className="btn-ghost mt-4" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? '重试中…' : '重新加载动漫'}</button>
        </div>
      ) : data?.items.length ? (
        <ul aria-label="动漫作品" className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((item) => <AnimeEntry key={item.id} item={item} onPick={onPick} />)}
        </ul>
      ) : (
        <div role="status" className="rounded-xl border border-line bg-card p-8 text-center">
          <p className="text-sm text-muted">没有找到匹配作品，试试其他片名或放宽地区、年份。</p>
          <button type="button" className="btn-ghost mt-4" onClick={reset}>查看全部动漫</button>
        </div>
      )}
      <nav aria-label="动漫分页" className="mt-4 flex flex-wrap items-center justify-center gap-4">
        <button type="button" className="btn-ghost" disabled={loading || filters.page <= 1} onClick={() => update({ page: filters.page - 1 })}>上一页</button>
        <span className="text-xs tabular-nums text-muted" aria-live="polite">第 {filters.page} 页{data && data.maxPages > 0 ? ` / ${data.maxPages} 页` : ''}</span>
        <button type="button" className="btn-ghost" disabled={loading || !data?.hasMore} onClick={() => update({ page: filters.page + 1 })}>下一页</button>
      </nav>
      <p className="mt-4 text-xs leading-relaxed text-faint">
        覆盖国漫、日漫、欧美动画与动画电影。评分和口碑名次来自 Bangumi，地区依社区标签，可能漏收或漏标；目录收录不代表片源可播放。
        {data?.totalCapped && ` 当前条件最多展示 ${data.total.toLocaleString()} 条，可按年份或片名缩小范围。`}
        {filters.year !== null && ' 找不到老作品时，可选“全部＋口碑”或不限年份搜索片名。'}
      </p>
    </div>
  );
}

const AnimeEntry = memo(function AnimeEntry({ item, onPick }: { item: AnimeCatalogItem; onPick: (title: string) => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.cover, imageProxyMode, customImageProxy]);
  return (
    <li>
      <button type="button" onClick={() => onPick(item.title)} aria-label={`${item.title}，搜索片源`}
        className="group flex h-full w-full items-center gap-3 rounded-xl border border-line bg-card p-3 text-left transition-colors hover:border-accent/50 hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        <div className="h-[84px] w-14 shrink-0 overflow-hidden rounded-md bg-chip">
          {item.cover && !failed ? <SmartImage url={item.cover} mode={imageProxyMode} customProxy={customImageProxy} alt="" className="h-full w-full object-cover" onExhausted={() => setFailed(true)} />
            : <div className="flex h-full items-center justify-center text-[10px] text-faint">暂无海报</div>}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-semibold leading-relaxed text-content">{item.title}</h3>
          <p className="mt-1 text-xs text-faint">{[item.year, item.platform].filter(Boolean).join(' · ') || '动画作品'}</p>
          <p className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs">
            <span className={item.rating ? 'font-semibold tabular-nums text-rating' : 'text-faint'}>{item.rating ? `★ ${item.rating}` : '暂无评分'}</span>
            <span className="text-faint">{item.rank ? `Bangumi 口碑 #${item.rank}` : 'Bangumi'}</span>
          </p>
        </div>
        <Icon name="search" className="h-4 w-4 shrink-0 text-faint group-hover:text-accent" />
      </button>
    </li>
  );
});
