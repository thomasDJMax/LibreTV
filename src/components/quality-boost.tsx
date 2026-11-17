'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import type { SearchResultItem, SourceConfig, VodQualityResult } from '@/lib/types';
import { buildWatchUrl } from '@/lib/utils';
import { isSourceDisabled, isInDisabledSubscription, resolveSource, useAppStore } from '@/lib/store';
import { rankSourceCandidates, resolveEpisodeTarget, selectSourceMatches, sourceSearchTitle } from '@/lib/source-quality-selection';
import { isMovieType, isMovieVersionList } from '@/lib/playback-navigation';
import { isAlreadySharp, isClearlyBetter, qualityLabel } from '@/lib/quality-boost';

interface QualityBoostProps {
  title: string;
  year?: string;
  typeName?: string;
  sourceKey: string;
  vodId: string;
  index: number;
  episodeLabel?: string;
  episodeCount?: number;
  currentUrl?: string;
  movieVersions: boolean;
}

interface BoostCandidate {
  source: SourceConfig;
  result: SearchResultItem;
  index: number;
  quality: VodQualityResult;
}

/** 最多比较几条线路：再多会明显增加源站请求量，收益有限。 */
const MAX_CANDIDATES = 6;
const PROBE_CONCURRENCY = 2;
/** 起播稳定后再探测，不和首屏分片抢带宽。 */
const START_DELAY_MS = 4000;

function dismissKey(sourceKey: string, vodId: string) {
  return `quality-boost-dismissed:${sourceKey}:${vodId}`;
}

async function runLimited<T>(items: readonly T[], limit: number, signal: AbortSignal, task: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!signal.aborted && cursor < items.length) await task(items[cursor++]);
  }));
}

/**
 * 后台画质提升：播放页稳定后，用换源同样的探测链路比较其他线路的实测码流，
 * 找到明显更清晰的线路时给出一次性提示（不自动切换，避免打断观看）。
 */
export function QualityBoost({
  title, year, typeName, sourceKey, vodId, index, episodeLabel, episodeCount, currentUrl, movieVersions,
}: QualityBoostProps) {
  const router = useRouter();
  const store = useAppStore();
  const [found, setFound] = useState<BoostCandidate | null>(null);
  const [baseline, setBaseline] = useState<VodQualityResult | undefined>(undefined);
  const [probing, setProbing] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const sources = useMemo(() => {
    const state = {
      selectedKeys: store.selectedKeys,
      customAPIs: store.customAPIs,
      envSources: store.envSources,
      subscriptions: store.subscriptions,
      sourceHealth: store.sourceHealth,
    };
    const seen = new Set<string>();
    return state.selectedKeys.map((key) => resolveSource(state, key)).filter((source): source is SourceConfig => {
      if (!source || seen.has(source.key) || isSourceDisabled(state, source.key) || isInDisabledSubscription(state, source.key)) return false;
      seen.add(source.key);
      return true;
    });
  }, [store.selectedKeys, store.customAPIs, store.envSources, store.subscriptions, store.sourceHealth]);

  // 单独取出基本类型，避免把整个 store 挂进 effect 依赖导致重复探测
  const yellowFilter = store.yellowFilter;

  useEffect(() => {
    setFound(null);
    setBaseline(undefined);
    setProbing(false);
    setDismissed(false);
    if (!title || !sourceKey || !vodId || !currentUrl) return;
    try {
      if (window.sessionStorage.getItem(dismissKey(sourceKey, vodId))) {
        setDismissed(true);
        return;
      }
    } catch {
      /* 隐私模式下没有 sessionStorage，照常探测 */
    }
    const controller = new AbortController();
    const { signal } = controller;
    let cancelled = false;
    const enabled = sources.filter((source) => source.key !== sourceKey);

    const run = async () => {
      if (signal.aborted || !enabled.length) return;
      setProbing(true);
      try {
        const current = await api.vodQuality(currentUrl, signal).catch(() => undefined);
        if (signal.aborted) return;
        setBaseline(current);
        if (isAlreadySharp(current)) return;
        const identity = { title, year, typeName };
        const { list } = await api.search(sourceSearchTitle(title), enabled, yellowFilter, { signal });
        if (signal.aborted) return;
        const candidates: { source: SourceConfig; result: SearchResultItem }[] = [];
        for (const source of enabled) {
          const hits = list.filter((hit) => hit.sourceKey === source.key);
          const match = selectSourceMatches(identity, hits, 1)[0];
          if (match) candidates.push({ source, result: match });
          if (candidates.length >= MAX_CANDIDATES) break;
        }
        const probed: BoostCandidate[] = [];
        await runLimited(candidates, PROBE_CONCURRENCY, signal, async ({ source, result }) => {
          const detail = await api.detailSpeed(result.vodId, source, signal);
          if (signal.aborted || !detail.ok || !detail.detail) return;
          const info = detail.detail.videoInfo;
          const target = resolveEpisodeTarget({
            currentIndex: index,
            currentLabel: episodeLabel,
            currentEpisodeCount: episodeCount,
            targetEpisodeCount: detail.detail.episodes.length,
            targetLabels: detail.detail.episodeLabels,
            movieVersions: isMovieType(typeName) && isMovieVersionList(info.typeName || result.typeName, detail.detail.episodeLabels),
          });
          if (!target.ok) return;
          const quality = await api.vodQuality(detail.detail.episodes[target.index], signal).catch(() => undefined);
          if (!quality || signal.aborted) return;
          probed.push({ source, result, index: target.index, quality });
        });
        if (signal.aborted) return;
        const ranked = rankSourceCandidates(probed.map((candidate) => ({
          ...candidate,
          available: candidate.quality.ok === true,
          width: candidate.quality.evidence === 'bitstream' ? candidate.quality.width : undefined,
          height: candidate.quality.evidence === 'bitstream' ? candidate.quality.height : undefined,
          mediaKbps: candidate.quality.mediaKbps,
        })));
        const best = ranked.find((candidate) => isClearlyBetter(current, candidate.quality));
        if (best) setFound(best);
      } catch {
        /* 后台探测失败不影响播放 */
      } finally {
        if (!cancelled) setProbing(false);
      }
    };

    const timer = setTimeout(() => { void run(); }, START_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [title, year, typeName, sourceKey, vodId, index, episodeLabel, episodeCount, currentUrl, movieVersions, sources, yellowFilter]);

  const dismiss = () => {
    try { window.sessionStorage.setItem(dismissKey(sourceKey, vodId), '1'); } catch { /* 忽略存储失败 */ }
    setDismissed(true);
  };

  const switchTo = () => {
    if (!found) return;
    try { window.sessionStorage.setItem(dismissKey(sourceKey, vodId), '1'); } catch { /* 忽略存储失败 */ }
    router.push(buildWatchUrl({
      sourceKey: found.source.key,
      vodId: found.result.vodId,
      index: found.index,
      title: found.result.name || title,
      sourceUrl: found.source.url,
      detail: found.source.detail,
    }));
  };

  if (found && !dismissed) {
    const better = qualityLabel(found.quality);
    const now = qualityLabel(baseline);
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
        <span className="text-xs font-medium text-content">发现更清晰线路</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {found.source.name}{better ? ` · ${better}` : ''}{now ? `（当前 ${now}）` : ''}
        </span>
        <button className="btn-primary btn-sm shrink-0" onClick={switchTo}>切换线路</button>
        <button className="btn-ghost btn-sm shrink-0" onClick={dismiss}>忽略</button>
      </div>
    );
  }

  if (!probing) return null;
  return <p className="mt-3 text-xs text-faint" aria-live="polite">正在比较其他线路的画质…</p>;
}
