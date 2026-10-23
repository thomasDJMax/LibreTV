'use client';

import { memo, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import type { DoubanItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { AnimeCatalog } from './anime-catalog';

type Category = 'tv' | 'movie' | 'show' | 'anime';
const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'tv', label: '电视剧' },
  { id: 'movie', label: '电影' },
  { id: 'show', label: '综艺' },
  { id: 'anime', label: '动漫' },
];
const BOARDS = [
  { id: 'douban_tv_chinese', category: 'tv', label: '国产剧', title: '国产剧周榜', source: '豆瓣' },
  { id: 'douban_tv_global', category: 'tv', label: '海外剧', title: '海外剧周榜', source: '豆瓣' },
  { id: 'douban_tv_korean', category: 'tv', label: '韩剧', title: '韩剧口碑榜', source: '豆瓣' },
  { id: 'baidu_teleplay', category: 'tv', label: '热播剧', title: '热播剧榜', source: '百度' },
  { id: 'douban_movie_weekly', category: 'movie', label: '口碑周榜', title: '电影口碑周榜', source: '豆瓣' },
  { id: 'douban_show_chinese', category: 'show', label: '国内综艺', title: '国内综艺周榜', source: '豆瓣' },
  { id: 'douban_show_global', category: 'show', label: '海外综艺', title: '海外综艺周榜', source: '豆瓣' },
  { id: 'anime', category: 'anime', label: '动漫片库', title: '动漫片库', source: 'Bangumi' },
] as const;
type BoardId = (typeof BOARDS)[number]['id'];
const PREFERENCE_KEY = 'libretv:ranking-board:v1';

/** 保留上游榜内名次；评分只作参考，不重新排序。 */
export function RankingSection({ onPick }: { onPick: (title: string) => void }) {
  const [listId, setListId] = useState<BoardId>('douban_tv_chinese');
  const [ready, setReady] = useState(false);
  const board = BOARDS.find((entry) => entry.id === listId)!;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(PREFERENCE_KEY);
      const matched = BOARDS.find((entry) => entry.id === saved);
      if (matched) setListId(matched.id);
    } catch { /* 本地偏好不可用时仍可浏览榜单。 */ }
    setReady(true);
  }, []);

  const selectBoard = (id: BoardId) => {
    setListId(id);
    try { localStorage.setItem(PREFERENCE_KEY, id); } catch { /* 忽略偏好保存失败。 */ }
  };

  const query = useQuery({
    queryKey: ['hot-list', listId],
    queryFn: ({ signal }) => api.hotList(listId, signal),
    enabled: ready && listId !== 'anime',
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const items = query.data?.items ?? [];
  const loading = !ready || query.isLoading;

  return (
    <section aria-label="影视排行榜" className="pb-4">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-content">影视排行榜</h2>
          <p className="mt-1.5 text-xs text-muted">挑一部想看的，点击查找播放资源</p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-chip p-1" role="group" aria-label="排行榜分类">
          {CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              className={cn('btn px-3 sm:px-5 font-medium', board.category === category.id ? 'bg-accent text-on-accent' : 'text-muted hover:bg-hover hover:text-content')}
              aria-pressed={board.category === category.id}
              onClick={() => {
                if (board.category !== category.id) selectBoard(BOARDS.find((entry) => entry.category === category.id)!.id);
              }}
            >
              {category.label}
            </button>
          ))}
        </div>
      </div>

      {listId === 'anime' ? <AnimeCatalog onPick={onPick} /> : <>
      <div className="my-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="榜单范围">
          {BOARDS.filter((entry) => entry.category === board.category).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={cn('chip px-3 py-1.5 text-xs', listId === entry.id ? 'bg-accent/15 text-accent' : 'bg-chip text-muted hover:bg-hover hover:text-content')}
              aria-pressed={listId === entry.id}
              onClick={() => selectBoard(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-faint" aria-live="polite">
          {board.source} · {board.title}{items.length > 0 ? ` · ${items.length} 部上榜` : ''}
        </p>
      </div>

      {loading ? <RankingSkeleton /> : query.isError && !items.length ? (
        <div className="rounded-xl border border-line bg-card px-4 py-10 text-center" role="status">
          <p className="text-sm text-muted">这个榜单暂时加载失败，可以重试或切换其他榜单。</p>
          <button className="btn-ghost mt-4" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <Icon name="refresh" className="h-4 w-4" />{query.isFetching ? '重试中…' : '重新加载'}
          </button>
        </div>
      ) : !items.length ? (
        <p className="py-10 text-center text-sm text-muted" role="status">这个榜单暂时没有内容，换个分类看看。</p>
      ) : (
        <ol aria-label={board.title} className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {items.map((item, index) => (
            <RankingEntry key={`${listId}:${item.id}`} item={item} rank={item.rank ?? index + 1} rated={board.source === '豆瓣'} onPick={onPick} />
          ))}
        </ol>
      )}

      <p className="mt-4 text-xs leading-relaxed text-faint">
        {listId === 'douban_tv_korean' ? '豆瓣韩剧口碑条目与韩国电视剧目录交叉筛选，按口碑条目顺序排列。' : board.source === '豆瓣' ? '按豆瓣原榜名次排列，评分仅供参考。' : '按百度热播剧榜名次排列。'}榜单推荐不代表已找到可播放片源。
      </p>
      </>}
    </section>
  );
}

const RankingEntry = memo(function RankingEntry({ item, rank, rated, onPick }: { item: DoubanItem; rank: number; rated: boolean; onPick: (title: string) => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.cover, imageProxyMode, customImageProxy]);
  const rankColor = rank === 1 ? 'text-amber-600 dark:text-amber-300' : rank === 2 ? 'text-slate-500 dark:text-slate-300' : rank === 3 ? 'text-orange-600 dark:text-orange-300' : 'text-faint';

  return (
    <li value={rank}>
      <button
        type="button"
        onClick={() => onPick(item.title)}
        aria-label={`第 ${rank} 名 ${item.title}，搜索片源`}
        className="group flex h-full w-full items-center gap-3 rounded-xl border border-line bg-card p-3 text-left transition-colors hover:border-accent/50 hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <span className={cn('w-7 shrink-0 text-center text-xl font-bold tabular-nums sm:w-9 sm:text-2xl', rankColor)} aria-hidden>{String(rank).padStart(2, '0')}</span>
        <div className="relative h-[84px] w-14 shrink-0 overflow-hidden rounded-md bg-chip">
          {item.cover && !failed ? (
            <SmartImage url={item.cover} mode={imageProxyMode} customProxy={customImageProxy} alt="" className="h-full w-full object-cover" onExhausted={() => setFailed(true)} />
          ) : <div className="flex h-full items-center justify-center px-1 text-center text-[10px] text-faint">暂无海报</div>}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-semibold leading-relaxed text-content sm:text-base">{item.title}</h3>
          <p className="mt-2 text-xs text-muted">
            {rated && item.rating ? <><span className="font-semibold tabular-nums text-rating">★ {item.rating}</span><span className="ml-2 text-faint">豆瓣评分</span></> : rated ? '暂无评分' : '百度热播剧榜'}
          </p>
        </div>
        <Icon name="search" className="h-4 w-4 shrink-0 text-faint group-hover:text-accent" />
      </button>
    </li>
  );
});

function RankingSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2" role="status" aria-label="正在加载排行榜">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex h-[110px] items-center gap-3 rounded-xl border border-line bg-card p-3" aria-hidden>
          <div className="h-5 w-9 rounded bg-chip" />
          <div className="h-[84px] w-14 rounded-md bg-chip" />
          <div className="flex-1 space-y-3"><div className="h-4 w-3/4 rounded bg-chip" /><div className="h-3 w-1/3 rounded bg-chip" /></div>
        </div>
      ))}
    </div>
  );
}
