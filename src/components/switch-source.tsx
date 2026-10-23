'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import type { SourceConfig, SearchResultItem, VodQualityResult } from '@/lib/types';
import { buildWatchUrl, cn } from '@/lib/utils';
import { useAppStore, resolveSource, isSourceDisabled, isInDisabledSubscription } from '@/lib/store';
import { groupIdenticalSamples, rankSourceCandidates, resolveEpisodeTarget, selectSourceMatch, selectSourceMatches, sourceSearchTitle } from '@/lib/source-quality-selection';
import { isMovieType, isMovieVersionList } from '@/lib/playback-navigation';
import { useToast } from './toast';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { EmptyState, LoadingState } from './states';
import { useFocusTrap } from './use-focus-trap';

interface Candidate {
  source: SourceConfig;
  result: SearchResultItem;
  ms?: number;
  detailOk?: boolean;
  episodes?: number;
  targetIndex?: number;
  reason?: string;
  probing: boolean;
  quality?: VodQualityResult;
}

interface SwitchSourceProps {
  currentTitle: string;
  currentSourceKey: string;
  currentVodId: string;
  currentIndex: number;
  currentYear?: string;
  currentTypeName?: string;
  currentEpisodeLabel?: string;
  currentEpisodeCount?: number;
  onClose: () => void;
}

/** Small, cancellable worker pool: opening the dialog must not flood media hosts. */
async function runLimited<T>(items: T[], limit: number, signal: AbortSignal, task: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!signal.aborted && cursor < items.length) await task(items[cursor++]);
  }));
}

function isAvailable(candidate: Candidate): boolean {
  return !candidate.probing && candidate.detailOk === true && candidate.targetIndex !== undefined && candidate.quality?.ok !== false;
}

export function SwitchSourceModal({
  currentTitle, currentSourceKey, currentVodId, currentIndex, currentYear,
  currentTypeName, currentEpisodeLabel, currentEpisodeCount, onClose,
}: SwitchSourceProps) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [phase, setPhase] = useState<'searching' | 'quality' | 'done'>('searching');
  const [searchFailures, setSearchFailures] = useState(0);
  const [sortBy, setSortBy] = useState<'quality' | 'response'>('quality');
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, panelRef);
  const { selectedKeys, customAPIs, envSources, subscriptions, sourceHealth } = store;

  const sources = useMemo(() => {
    const state = { selectedKeys, customAPIs, envSources, subscriptions, sourceHealth };
    const seen = new Set<string>();
    return state.selectedKeys.map((key) => resolveSource(state, key)).filter((source): source is SourceConfig => {
      if (!source || seen.has(source.key) || isSourceDisabled(state, source.key) || isInDisabledSubscription(state, source.key)) return false;
      seen.add(source.key);
      return true;
    });
  }, [selectedKeys, customAPIs, envSources, subscriptions, sourceHealth]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const current = { title: currentTitle, year: currentYear, typeName: currentTypeName };
    const update = (candidate: Candidate) => {
      if (signal.aborted) return;
      setCandidates((previous) => previous.map((item) => item.source.key === candidate.source.key && item.result.vodId === candidate.result.vodId ? { ...candidate } : item));
    };
    void (async () => {
      setPhase('searching');
      setCandidates([]);
      setSearchFailures(0);
      if (!sources.length) { setPhase('done'); return; }
      try {
        const { list, failures } = await api.search(sourceSearchTitle(currentTitle), sources, store.yellowFilter, { signal });
        if (signal.aborted) return;
        setSearchFailures(failures.length);
        const matched = sources.flatMap((source) => {
          const hits = list.filter((hit) => hit.sourceKey === source.key);
          const versions = selectSourceMatches(current, hits);
          const playing = source.key === currentSourceKey
            ? selectSourceMatch(current, hits.filter((hit) => hit.vodId === currentVodId)) : undefined;
          // The limit bounds media probes, but must never hide the current edition.
          if (playing && !versions.some((hit) => hit.vodId === playing.vodId)) versions.splice(2, 1, playing);
          return versions.map((result) => ({ source, result, probing: true } satisfies Candidate));
        });
        setCandidates(matched);
        setPhase('quality');
        await runLimited<Candidate>(matched, 2, signal, async (candidate) => {
          const response = await api.detailSpeed(candidate.result.vodId, candidate.source, signal);
          if (signal.aborted) return;
          candidate.ms = response.ms;
          candidate.detailOk = response.ok;
          candidate.episodes = response.detail?.episodes.length;
          if (!response.ok || !response.detail) {
            candidate.reason = response.error || '无法获取影片信息';
          } else {
            const info = response.detail.videoInfo;
            const sameVersion = selectSourceMatch(current, [{ ...candidate.result, name: info.title || candidate.result.name, year: info.year || candidate.result.year, typeName: info.typeName || candidate.result.typeName }]);
            const target = resolveEpisodeTarget({ currentIndex, currentLabel: currentEpisodeLabel, currentEpisodeCount, targetEpisodeCount: response.detail.episodes.length, targetLabels: response.detail.episodeLabels,
              movieVersions: isMovieType(currentTypeName) && isMovieVersionList(info.typeName || candidate.result.typeName, response.detail.episodeLabels),
            });
            if (!sameVersion) candidate.reason = '影片版本不匹配';
            else if (!target.ok) candidate.reason = target.reason;
            else {
              candidate.targetIndex = target.index;
              update(candidate);
              try {
                candidate.quality = await api.vodQuality(response.detail.episodes[target.index], signal);
              } catch (error) {
                if (signal.aborted) return;
                // A failed quality service must not turn an otherwise valid source into a playback failure.
                candidate.quality = undefined;
                candidate.reason = error instanceof Error ? error.message : '暂未识别画质';
              }
            }
          }
          candidate.probing = false;
          update(candidate);
        });
        if (!signal.aborted) setPhase('done');
      } catch (error) {
        if (signal.aborted) return;
        toast(error instanceof Error ? error.message : '换源搜索失败', 'error');
        setPhase('done');
      }
    })();
    return () => controller.abort();
  }, [currentTitle, currentYear, currentTypeName, currentSourceKey, currentVodId, currentIndex, currentEpisodeLabel, currentEpisodeCount, sources, store.yellowFilter, toast]);

  const ranked = rankSourceCandidates(candidates.map((candidate) => ({
    ...candidate,
    available: candidate.probing ? undefined : candidate.quality?.ok === true && isAvailable(candidate)
      ? true : isAvailable(candidate) ? undefined : false,
    isCurrent: candidate.source.key === currentSourceKey && candidate.result.vodId === currentVodId && (candidate.targetIndex === undefined || candidate.targetIndex === currentIndex),
    width: candidate.quality?.evidence === 'bitstream' ? candidate.quality.width : undefined,
    height: candidate.quality?.evidence === 'bitstream' ? candidate.quality.height : undefined,
    mediaKbps: candidate.quality?.mediaKbps,
    interfaceMs: candidate.ms,
    sampleHash: candidate.quality?.sampleHash,
  })), { pinCurrent: false });
  if (sortBy === 'response') ranked.sort((a, b) => Number(a.available === false) - Number(b.available === false) || (a.ms ?? Infinity) - (b.ms ?? Infinity));
  const filtered = ranked.filter((candidate) => showUnavailable || candidate.available !== false || candidate.isCurrent);
  const groups = groupIdenticalSamples(filtered);
  const visible = showDuplicates ? filtered : groups.flatMap((group) => {
    const current = group.find((item) => item.isCurrent);
    const alternative = group.find((item) => !item.isCurrent);
    // Keep one backup directly selectable when the current source shares its sample.
    return current && alternative ? [current, alternative] : [group[0]];
  });
  const groupByHash = new Map(groups.filter((group) => group.length > 1).map((group) => [group[0].sampleHash, group]));
  const pending = candidates.filter((candidate) => candidate.probing).length;
  const skipped = new Set(store.selectedKeys).size - sources.length;

  const switchTo = (candidate: Candidate) => {
    if (!isAvailable(candidate) || candidate.targetIndex === undefined) return;
    onClose();
    router.push(buildWatchUrl({ sourceKey: candidate.source.key, vodId: candidate.result.vodId, index: candidate.targetIndex, title: candidate.result.name || currentTitle, sourceUrl: candidate.source.url, detail: candidate.source.detail }));
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto overscroll-contain bg-black/80 py-6 px-3" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} tabIndex={-1} className="bg-surface-raised rounded-xl w-full max-w-3xl shadow-2xl p-4 sm:p-5 animate-slide-up outline-none" role="dialog" aria-modal="true" aria-label={`换源：${currentTitle}`}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content truncate" title={currentTitle}>{currentTitle}</h2>
            <p className="text-xs text-faint mt-1" aria-live="polite">
              {phase === 'searching' ? '正在查找同名影片…' : `找到 ${candidates.length} 个同名版本${pending ? ` · 正在检测 ${pending} 个` : ''}`}
              {skipped > 0 ? ` · 跳过 ${skipped} 个已暂停来源` : ''}
              {searchFailures > 0 ? ` · ${searchFailures} 个来源搜索失败` : ''}
            </p>
          </div>
          <button className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover" onClick={onClose} aria-label="关闭"><Icon name="close" className="w-5 h-5" /></button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex gap-1 rounded-lg bg-card p-1" role="group" aria-label="来源排序">
            <button className={cn('btn-ghost btn-sm', sortBy === 'quality' && 'bg-hover text-content')} aria-pressed={sortBy === 'quality'} onClick={() => setSortBy('quality')}>画质优先</button>
            <button className={cn('btn-ghost btn-sm', sortBy === 'response' && 'bg-hover text-content')} aria-pressed={sortBy === 'response'} onClick={() => setSortBy('response')}>响应优先</button>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted">
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={showDuplicates} onChange={(event) => setShowDuplicates(event.target.checked)} />显示同片段来源</label>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={showUnavailable} onChange={(event) => setShowUnavailable(event.target.checked)} />显示不可用来源</label>
          </div>
        </div>
        {phase === 'searching' ? <LoadingState label="查找同名影片中…" /> : !visible.length ? (
          <EmptyState variant="plain" title={candidates.length ? '当前没有可切换的版本，可查看不可用来源' : '其他点播源未找到同名资源'} />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {visible.map((candidate) => {
              const key = `${candidate.source.key}_${candidate.result.vodId}`;
              const repeated = candidate.sampleHash ? groupByHash.get(candidate.sampleHash) : undefined;
              const dimensions = candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : undefined;
              const available = isAvailable(candidate);
              return (
                <button key={key} className={cn('text-left group relative rounded-lg overflow-hidden bg-card transition-transform disabled:cursor-default', available && !candidate.isCurrent && 'hover:scale-[1.02]')} onClick={() => switchTo(candidate)} disabled={candidate.isCurrent || !available}>
                  <div className="relative aspect-[2/3] bg-chip">
                    {candidate.result.pic && !imgFailed[key] ? <SmartImage url={candidate.result.pic} mode={store.imageProxyMode} customProxy={store.customImageProxy} alt={candidate.result.name} className="w-full h-full object-cover" onExhausted={() => setImgFailed((previous) => ({ ...previous, [key]: true }))} /> : <div className="w-full h-full flex items-center justify-center text-faint"><Icon name="link" className="w-6 h-6" /></div>}
                    <span className={cn('absolute top-1.5 right-1.5 tag', candidate.probing || !candidate.quality ? 'bg-chip text-content' : !available ? 'bg-danger-solid/85 text-white' : 'bg-success-solid/85 text-white')}>{candidate.probing ? '检测中' : available ? dimensions || '尺寸未知' : '暂不可用'}</span>
                    {candidate.isCurrent && <span className="absolute inset-x-0 bottom-0 bg-accent/90 text-on-accent text-xs text-center py-1">当前播放</span>}
                  </div>
                  <div className="p-2 space-y-1">
                    <div className="text-xs font-medium text-content truncate" title={candidate.source.name}>{candidate.source.name}</div>
                    <div className="text-[11px] text-content line-clamp-2" title={candidate.result.name}>{candidate.result.name}</div>
                    <div className="text-[11px] text-faint truncate" title={candidate.result.name}>{[candidate.result.year, candidate.result.remarks].filter(Boolean).join(' · ') || candidate.result.name}</div>
                    {candidate.episodes !== undefined && candidate.episodes > 1 && <div className="text-[11px] text-faint">{candidate.episodes} 个播放条目</div>}
                    <div className="text-[11px] text-muted">{candidate.quality?.mediaKbps ? `片段码率约 ${(candidate.quality.mediaKbps / 1000).toFixed(2)} Mbps` : candidate.probing ? '读取视频样本…' : available ? '片段码率未知' : candidate.reason || candidate.quality?.error || '视频样本不可访问'}</div>
                    <div className="text-[11px] text-faint" title="影片信息响应时间，不代表视频清晰度或下载速度">{candidate.ms === undefined ? '等待影片信息' : `影片响应 ${(candidate.ms / 1000).toFixed(1)} 秒`}</div>
                    {repeated && <div className="text-[11px] text-faint truncate" title={repeated.map((item) => item.source.name).join('、')}>同片段 {repeated.length} 个来源</div>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-faint mt-4">优先比较实测视频尺寸；码率为片段估算。尺寸未知的来源仍可选择，实际观感取决于原片。</p>
      </div>
    </div>
  );
}
