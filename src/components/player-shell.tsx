'use client';

import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import {
  getVideoPrefetcher,
  getNextEpisodePrefetcher,
} from '@/lib/video-prefetcher';
import { loadCacheSettings } from '@/lib/video-cache';
import { formatTime } from '@/lib/utils';
import {
  buildPlayerQualityOptions,
  createFragmentRateSample,
  formatDownloadSpeed,
  formatMediaBitrate,
  formatVideoDimensions,
  recentMediaBitrate,
  DEFAULT_INTRO_SKIP,
  DEFAULT_OUTRO_SKIP,
  normalizeIntroSkipPreferences,
  normalizeOutroSkipPreferences,
  resolveStartPosition,
  shouldAutoSkipOutro,
  shouldResumeFinishedEpisode,
  type EpisodeCompletion,
  type FragmentRateSample,
  type IntroSkipPreferences,
  type OutroSkipPreferences,
  type PlayerQualityOption,
} from '@/lib/player-quality';

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集（url 变化）只「切换 HLS 源」
 * 而不销毁重建。否则在「网页全屏（页面全屏）」下整实例重建会丢失全屏上下文、
 * 重建 <video> 元素，触发「黑屏有声」的渲染竞态。
 */

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（片段缓存按集淘汰的分组键） */
  episodeKey?: string;
  /** 下一集 m3u8 地址：当前集预取完成后预热下一集前 7 分钟 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: (reason?: 'ended' | 'outro') => void;
  onPause?: (position: number, duration: number) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
}

interface QualityControlsState {
  session: number;
  ready: boolean;
  options: PlayerQualityOption[];
  selected: number;
  active: number;
}

interface QualityRatesState {
  media: string | null;
  download: string | null;
  cached: boolean;
}

interface EpisodeStartState {
  preferences: IntroSkipPreferences;
  saved: number;
  ready: boolean;
  lookup?: Promise<number>;
}

const INTRO_SKIP_KEY = 'libretv:intro-skip:v1';
const OUTRO_SKIP_KEY = 'libretv:outro-skip:v1';
const INTRO_SKIP_PRESETS = [30, 60, 90, 120];

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onRequestSwitchSource,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [actualDimensions, setActualDimensions] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityControlsState>({
    session: 0, ready: false, options: [], selected: -1, active: -1,
  });
  const [qualityRates, setQualityRates] = useState<QualityRatesState>({
    media: null, download: null, cached: false,
  });
  const [introPreferences, setIntroPreferences] = useState(DEFAULT_INTRO_SKIP);
  const [customIntroSeconds, setCustomIntroSeconds] = useState(false);
  const introPreferencesRef = useRef(DEFAULT_INTRO_SKIP);
  const [outroPreferences, setOutroPreferences] = useState(DEFAULT_OUTRO_SKIP);
  const [customOutroSeconds, setCustomOutroSeconds] = useState(false);
  const outroPreferencesRef = useRef(DEFAULT_OUTRO_SKIP);
  // Snapshot preferences per episode: changing the controls never seeks the current video.
  const episodeStartRef = useRef<EpisodeStartState>({
    preferences: DEFAULT_INTRO_SKIP, saved: 0, ready: false,
  });
  // Instance identity prevents an old manifest, deferred callback or select event from
  // applying a previous episode's level indexes after fallback or a source switch.
  const qualitySessionRef = useRef(0);
  const fragmentSamplesRef = useRef<Array<FragmentRateSample & { key: string }>>([]);
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext, episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onRequestSwitchSource,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onRequestSwitchSource,
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次（MANIFEST_PARSED 可能因代理回退再次触发）
  const restoredRef = useRef(false);
  // timeupdate 续跑预取的游标：必须按集清零，否则会沿用上一集的时间戳推迟首次续跑
  const lastPrefetchEnsureRef = useRef(0);
  // setupHls 可能改走代理形式，video:error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完或跳片尾后的完成标记，所有进度回写与完成事件都必须检查它。
  const endedRef = useRef<EpisodeCompletion>(false);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  const updateIntroPreferences = (patch: Partial<IntroSkipPreferences>) => {
    const next = normalizeIntroSkipPreferences({ ...introPreferencesRef.current, ...patch });
    introPreferencesRef.current = next;
    setIntroPreferences(next);
    try { localStorage.setItem(INTRO_SKIP_KEY, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
  };

  const updateOutroPreferences = (patch: Partial<OutroSkipPreferences>) => {
    const next = normalizeOutroSkipPreferences({ ...outroPreferencesRef.current, ...patch });
    outroPreferencesRef.current = next;
    setOutroPreferences(next);
    try { localStorage.setItem(OUTRO_SKIP_KEY, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
  };

  const finishEpisode = (reason: 'ended' | 'outro') => {
    if (endedRef.current) return;
    // Set this before pause: pause/timeupdate/visibility events must not overwrite
    // the completion record or accidentally invoke the callback a second time.
    const p = propsRef.current;
    endedRef.current = reason === 'outro' || (p.autoplayNext && !!p.nextUrl) ? 'advancing' : 'ended';
    getVideoPrefetcher().stop();
    if (reason === 'outro') {
      artRef.current?.pause();
      hlsRef.current?.stopLoad();
    }
    propsRef.current.onEnded?.(reason);
  };

  const applyInitialPosition = (video: HTMLVideoElement) => {
    const start = episodeStartRef.current;
    if (restoredRef.current || !start.ready || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const planned = resolveStartPosition({ duration: video.duration, savedPosition: start.saved, preferences: start.preferences });
    if (planned === null) return;
    // A user may already have sought while the asynchronous history lookup completed.
    const current = Number.isFinite(video.currentTime) && video.currentTime < video.duration - 2 ? video.currentTime : 0;
    const target = Math.max(planned, current);
    restoredRef.current = true;
    try {
      if (target > video.currentTime + 0.5) video.currentTime = target;
    } catch {
      restoredRef.current = false;
      return;
    }
    if (planned > 0) showHint(`已从 ${formatTime(target)} 开始播放`);
    ensurePrefetch(currentMediaUrlRef.current, target);
  };

  const skipIntroNow = () => {
    const video = artRef.current?.video as HTMLVideoElement | undefined;
    if (!video) return;
    const target = resolveStartPosition({
      duration: video.duration,
      preferences: { ...introPreferencesRef.current, enabled: true },
    });
    if (target === null) { showHint('正在读取视频时长，请稍后重试'); return; }
    if (target <= 0) { showHint('设定时长为零或视频较短，已保留片尾'); return; }
    if (video.currentTime >= target) { showHint('已超过设定的片头位置'); return; }
    try { video.currentTime = target; } catch { showHint('视频尚未准备好，请稍后重试'); return; }
    restoredRef.current = true;
    ensurePrefetch(currentMediaUrlRef.current, target);
    showHint(`已跳至 ${formatTime(target)}`);
  };

  // 片段缓存开启时调大 hls.js 自身缓冲，缓冲之外的空窗由预取器补齐
  const buildHlsConfig = (): Partial<HlsConfig> => {
    const p = propsRef.current;
    const cacheSettings = loadCacheSettings();
    const cacheEnabled = cacheSettings.enabled && !!p.episodeKey;
    return {
      debug: false,
      // Wait for the resume lookup before requesting video fragments. Direct media
      // playlists can start near the intro target without downloading the opening.
      autoStartLoad: false,
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: cacheEnabled ? 120 : 30,
      maxMaxBufferLength: cacheEnabled ? 600 : 60,
      maxBufferSize: (cacheEnabled ? 90 : 30) * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
      // 组合 loader：广告过滤（blockAd 随设置）+ 片段缓存命中（cacheEnabled）
      loader: createHlsLoader(Hls, { blockAd: p.adFilter }) as unknown as HlsConfig['loader'],
    };
  };

  // 当前集预取（episodeKey 缺省 = 关闭，见 ensure 内部 settings.enabled 判断）
  const ensurePrefetch = (mediaUrl: string, currentTime: number, horizonSeconds?: number) => {
    const p = propsRef.current;
    if (!p.episodeKey) return;
    getVideoPrefetcher().ensure({
      m3u8Url: mediaUrl,
      currentTime,
      episodeKey: p.episodeKey,
      horizonSeconds,
      onProgress: (stats) => {
        // 当前集预取完成且存在下一集：用独立预取器预热下一集前 7 分钟
        if (stats.state === 'done' && p.nextUrl && p.nextEpisodeKey) {
          getNextEpisodePrefetcher().ensure({
            m3u8Url: p.nextUrl,
            currentTime: 0,
            episodeKey: p.nextEpisodeKey,
            horizonSeconds: 420,
          });
        }
      },
    });
  };

  /**
   * 初始化/切换 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
   * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
   * 注意：不销毁 ArtPlayer，只销毁并重建 hls，从而保留网页全屏等播放器状态。
   */
  const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    const retryPosition = restoredRef.current && Number.isFinite(video.currentTime) ? video.currentTime : undefined;
    const session = ++qualitySessionRef.current;
    setActualDimensions(null);
    setQuality({ session, ready: false, options: [], selected: -1, active: -1 });
    fragmentSamplesRef.current = [];
    setQualityRates((previous) => previous.media || previous.download || previous.cached
      ? { media: null, download: null, cached: false } : previous);
    hlsRef.current?.destroy();
    currentMediaUrlRef.current = mediaUrl;
    const hls = new Hls(buildHlsConfig());
    hlsRef.current = hls;
    const isCurrent = () => hlsRef.current === hls && qualitySessionRef.current === session;
    const updateOptions = () => {
      if (!isCurrent()) return;
      const options = buildPlayerQualityOptions(hls.levels);
      setQuality((previous) => {
        if (previous.session !== session) return previous;
        if (previous.ready && JSON.stringify(previous.options) === JSON.stringify(options)) return previous;
        return { ...previous, ready: true, options };
      });
    };

    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, async () => {
      if (!isCurrent()) return;
      updateOptions();
      recoveryRef.current?.markHealthy();
      const start = episodeStartRef.current;
      if (!restoredRef.current && !start.ready) {
        const getSaved = propsRef.current.getRestorePosition;
        start.lookup ??= Promise.resolve().then(() => getSaved?.() ?? 0).catch(() => 0);
        const saved = await start.lookup;
        if (!isCurrent() || episodeStartRef.current !== start) return;
        start.saved = saved;
        start.ready = true;
      }
      if (!isCurrent() || endedRef.current) return;
      const details = hls.levels[hls.firstLevel]?.details;
      const knownDuration = details && !details.live ? details.totalduration : NaN;
      const prefetchAnchor = restoredRef.current
        ? retryPosition ?? video.currentTime
        : resolveStartPosition({ duration: knownDuration, savedPosition: start.saved, preferences: start.preferences }) ?? 0;
      hls.startLoad(prefetchAnchor);
      // A master playlist may not expose duration yet. Metadata/durationchange
      // retries this once actual duration is available, never on every timeupdate.
      applyInitialPosition(video);
      // 新集立即预取（否则要等 timeupdate 的 30s 节流，起播初期无缓存）
      ensurePrefetch(mediaUrl, prefetchAnchor);
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.LEVELS_UPDATED, () => {
      if (!isCurrent()) return;
      // Removing an unavailable variant can reindex every later level.
      // Reset manual selection instead of silently choosing a different version.
      if (!hls.autoLevelEnabled) hls.nextLevel = -1;
      fragmentSamplesRef.current = [];
      const active = hls.currentLevel;
      setQuality((previous) => previous.session === session
        ? { ...previous, selected: -1, active } : previous);
      setQualityRates((previous) => previous.media || previous.download || previous.cached
        ? { media: null, download: null, cached: false } : previous);
      updateOptions();
    });
    hls.on(Hls.Events.LEVEL_SWITCHING, () => {
      if (isCurrent()) fragmentSamplesRef.current = [];
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      if (!isCurrent()) return;
      setQuality((previous) => previous.session === session && previous.active !== data.level
        ? { ...previous, active: data.level } : previous);
    });
    // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
    hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      if (!isCurrent()) return;
      recoveryRef.current?.markHealthy();
      // Init segments, separate audio tracks and subtitle payloads cannot provide
      // a complete video-fragment rate. LL parts use their own media duration.
      if (data.frag.type !== 'main' || typeof data.frag.sn !== 'number') return;
      const stats = data.part?.stats ?? data.frag.stats;
      const sample = createFragmentRateSample({
        bytes: data.payload.byteLength,
        duration: data.part?.duration ?? data.frag.duration,
        // Our cache loader omits networkDetails and synthesizes loading timings.
        fromNetwork: data.networkDetails != null,
        loadingStart: stats.loading.start,
        loadingEnd: stats.loading.end,
      });
      if (!sample) return;
      const key = `${data.frag.level}:${data.frag.sn}:${data.part?.index ?? 'full'}`;
      const samples = fragmentSamplesRef.current;
      if (samples.some((item) => item.key === key)) return;
      const recent = [...samples, { ...sample, key }].slice(-3);
      fragmentSamplesRef.current = recent;
      const bitrate = recentMediaBitrate(recent);
      const rates = {
        media: bitrate === null ? null : formatMediaBitrate(bitrate),
        download: sample.downloadBytesPerSecond === null ? null : formatDownloadSpeed(sample.downloadBytesPerSecond),
        cached: data.networkDetails == null,
      };
      setQualityRates((previous) => previous.media === rates.media
        && previous.download === rates.download && previous.cached === rates.cached ? previous : rates);
    });
    // 分片真正进入 MSE buffer 才算媒体恢复：此时视频轨可渲染，错误态可解除
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (!isCurrent()) return;
      mediaHealthyRef.current = true;
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!isCurrent()) return;
      if (!data.fatal) return;
      const recovery = recoveryRef.current;
      if (!recovery) return;
      const decision = recovery.onFatal(data.type, data.details);
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
          // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
          if (
            allowProxyFallback &&
            !mediaUrl.startsWith('/api/proxy') &&
            (decision.attempt >= 2 || data.details === 'manifestLoadError')
          ) {
            showHint('直连失败，改用代理重试...');
            setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
            return;
          }
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          recovery.schedule(decision.delayMs, () => hls.startLoad());
          break;
        }
        case 'recover-media': {
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          if (decision.swapAudio) hls.swapAudioCodec?.();
          hls.recoverMediaError();
          break;
        }
        case 'switch-source': {
          // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
          // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
          const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
          if (playbackStartedRef.current) {
            showHint(message);
            propsRef.current.onRequestSwitchSource?.(decision.reason);
          } else {
            setError(`视频加载失败，${message}，请尝试其他视频源`);
          }
          break;
        }
      }
    });
  };

  const selectQuality = (value: string) => {
    const hls = hlsRef.current;
    if (!hls || !quality.ready || quality.session !== qualitySessionRef.current) return;
    const index = value === 'auto' ? -1 : /^\d+$/.test(value) ? Number(value) : NaN;
    if (index !== -1 && !quality.options.some((option) => option.levelIndex === index)) return;
    if (!Number.isInteger(index) || index >= hls.levels.length) return;
    // nextLevel switches without replacing the player or dropping the currently
    // playing fragment, preserving progress and both fullscreen modes.
    hls.nextLevel = index;
    setQuality((previous) => previous.session === quality.session && previous.selected !== index
      ? { ...previous, selected: index } : previous);
    showHint(index === -1 ? '已恢复自动选择画质' : '已选择版本，后续片段将切换');
  };

  /** 换集：重置每集状态并切换到新 HLS 源（不重建 ArtPlayer）。 */
  const loadEpisode = (targetUrl: string, resetStart = true) => {
    if (!targetUrl) return;
    if (!resetStart && endedRef.current) return;
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    if (resetStart) {
      restoredRef.current = false;
      episodeStartRef.current = { preferences: { ...introPreferencesRef.current }, saved: 0, ready: false };
      endedRef.current = false;
    }
    lastPrefetchEnsureRef.current = 0;
    recoveryRef.current = new PlaybackRecovery();
    // 换集时清掉上一集的预取窗口，避免带宽被旧集占用
    getVideoPrefetcher().stop();
    setError('');
    setShowPoster(true);
    const art = artRef.current;
    if (!art) return;
    setupHls(art.video, targetUrl, true);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;
    let storedPreferences = DEFAULT_INTRO_SKIP;
    try { storedPreferences = normalizeIntroSkipPreferences(JSON.parse(localStorage.getItem(INTRO_SKIP_KEY) ?? 'null')); } catch { /* Use defaults. */ }
    introPreferencesRef.current = storedPreferences;
    setIntroPreferences(storedPreferences);
    episodeStartRef.current = { preferences: { ...storedPreferences }, saved: 0, ready: false };
    let storedOutro = DEFAULT_OUTRO_SKIP;
    try { storedOutro = normalizeOutroSkipPreferences(JSON.parse(localStorage.getItem(OUTRO_SKIP_KEY) ?? 'null')); } catch { /* Use defaults. */ }
    outroPreferencesRef.current = storedOutro;
    setOutroPreferences(storedOutro);

    // 初始化每集状态
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;

    let lastSave = 0;

    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
      type: 'm3u8',
      volume: 0.8,
      autoplay: true,
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
      theme: '#2563eb',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;
    const updateActualDimensions = () => {
      // Manifest dimensions are only declarations. Use the decoded video element
      // for this field, including resize events during an adaptive level switch.
      const dimensions = formatVideoDimensions(art.video.videoWidth, art.video.videoHeight);
      setActualDimensions((previous) => previous === dimensions ? previous : dimensions);
    };
    art.video.addEventListener('loadedmetadata', updateActualDimensions);
    art.video.addEventListener('resize', updateActualDimensions);
    const applyStart = () => applyInitialPosition(art.video);
    art.video.addEventListener('loadedmetadata', applyStart);
    art.video.addEventListener('durationchange', applyStart);
    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = propsRef.current.title;
      } catch { /* 忽略 */ }
    });

    art.on('video:playing', () => {
      if (shouldResumeFinishedEpisode({
        completion: endedRef.current,
        currentTime: art.currentTime,
        duration: art.duration,
        paused: art.video.paused,
        ended: art.video.ended,
      })) {
        // Replaying a completed movie/final episode starts a new progress session.
        // Automatic next-episode navigation remains locked until loadEpisode.
        endedRef.current = false;
        lastSave = 0;
        lastPrefetchEnsureRef.current = 0;
      }
      updateActualDimensions();
      applyInitialPosition(art.video);
      playbackStartedRef.current = true;
      setShowPoster(false);
      // 仅在媒体真正恢复（有分片进入 buffer）后清错误遮罩：
      // 否则「视频轨挂了、音频轨先播出来」时会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
    });
    art.on('video:error', () => {
      mediaHealthyRef.current = false;
      // 起播阶段的 video 元素级错误（MSE/解码偶发失败）：重建一次播放链路自愈，
      // 而不是直接钉死错误遮罩——重建后视频轨重新 append，黑屏有声即可解除
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        showHint('播放异常，正在重试...');
        setupHls(art.video, currentMediaUrlRef.current, true);
        return;
      }
      setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      if (endedRef.current) return;
      const p = propsRef.current;
      if (p.onEnded && shouldAutoSkipOutro({
        duration: art.duration,
        currentTime: art.currentTime,
        introPreferences: episodeStartRef.current.preferences,
        outroPreferences: outroPreferencesRef.current,
        autoplayNext: p.autoplayNext,
        hasNext: !!p.nextUrl,
        isPlaying: playbackStartedRef.current && mediaHealthyRef.current
          && art.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !art.video.ended,
        isPaused: art.video.paused,
        isSeeking: art.video.seeking,
        alreadyFinished: !!endedRef.current,
      })) {
        finishEpisode('outro');
        return;
      }
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      // 每 30s 续跑一次前向预取窗口（ensure 幂等，窗口未覆盖足够余量才会重建）
      if (now - lastPrefetchEnsureRef.current > 30_000) {
        lastPrefetchEnsureRef.current = now;
        // 用 currentMediaUrlRef（代理回退后的实际地址）：否则预取的 key 与
        // loader 读取的 key 不一致，缓存永不命中且直连 fetch 白耗流量
        ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      }
    });
    art.on('video:seeked', () => {
      if (endedRef.current) return;
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
    });
    art.on('video:pause', () => {
      if (endedRef.current || art.video.ended) return;
      propsRef.current.onPause?.(art.currentTime, art.duration);
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      // waiting 触发的限速在此解除，否则黄金窗口会被 500ms 轮询冻结
      getVideoPrefetcher().setThrottled(false);
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime, 0);
    });
    art.on('video:waiting', () => {
      // 卡顿：预取临时让出带宽给播放
      getVideoPrefetcher().setThrottled(true);
    });
    art.on('video:playing', () => {
      getVideoPrefetcher().setThrottled(false);
    });
    art.on('video:ended', () => {
      finishEpisode('ended');
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活
      if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(target.tagName) || target.closest('button')) return;
      const current = artRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          current.fullscreen = !current.fullscreen; e.preventDefault();
          break;
      }
    };
    document.addEventListener('keydown', shortcuts);

    // —— 移动端长按 3 倍速 ——
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isLongPress = false;
    let originalRate = 1.0;
    const el = containerRef.current;

    const onTouchStart = (e: TouchEvent) => {
      if (art.video?.paused) return;
      // 已有触控在处理时忽略新手指：否则第二指会把 originalRate 捕获成 3.0，
      // 松手后倍速永久卡在 3x；旧定时器句柄也会被覆盖成无法清除的幽灵触发
      if (isLongPress || longPressTimer) return;
      // 控制栏 / 设置面板上的长按不触发倍速（按住进度条拖动、长按倍速菜单项会误触）
      if ((e.target as HTMLElement).closest?.('.art-controls, .art-settings')) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        showHint('3 倍速');
      }, 500);
    };
    const onTouchEnd = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (isLongPress) {
        art.video.playbackRate = originalRate;
        isLongPress = false;
        showHint(`${originalRate} 倍速`);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isLongPress) e.preventDefault();
    };
    // ArtPlayer 的 contextmenu 组件只在桌面端初始化（移动端构造函数里跳过 init），
    // 长按倍速因而会连带呼出系统原生菜单/气泡。播放器表面没有可用的原生菜单，统一抑制
    const onContextMenu = (e: Event) => e.preventDefault();
    el?.addEventListener('touchstart', onTouchStart, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('touchcancel', onTouchEnd);
    el?.addEventListener('touchmove', onTouchMove, { passive: false });
    el?.addEventListener('contextmenu', onContextMenu);

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden' && !endedRef.current) {
        propsRef.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current) {
        try {
          propsRef.current.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('contextmenu', onContextMenu);
      art.video.removeEventListener('loadedmetadata', updateActualDimensions);
      art.video.removeEventListener('resize', updateActualDimensions);
      art.video.removeEventListener('loadedmetadata', applyStart);
      art.video.removeEventListener('durationchange', applyStart);
      fragmentSamplesRef.current = [];
      hlsRef.current?.destroy();
      hlsRef.current = null;
      recoveryRef.current?.dispose();
      getVideoPrefetcher().stop();
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 换集：仅切换 HLS 源，不重建播放器（保留网页全屏等状态） ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 customType 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    loadEpisode(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // —— 广告过滤开关变化：重建 HLS loader（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    if (artRef.current && hlsRef.current) {
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  const activeOption = quality.options.find((option) => option.levelIndexes.includes(quality.active));

  return (
    <div className="w-full">
      <div className="relative aspect-video bg-black">
        <div ref={containerRef} className="w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm">{error}</p>
          <button className="btn-ghost text-xs" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      )}
      {hint && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/70 text-white text-sm px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          {hint}
        </div>
      )}
      {autoplayNext && !error && (
        <div className="absolute bottom-16 right-3 text-[10px] text-muted bg-black/50 px-2 py-0.5 rounded pointer-events-none">
          自动连播已开启
        </div>
      )}
      </div>
      <div className="border-t border-line bg-surface px-3 py-2 text-xs text-muted">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span>
            实际画面 <strong className="font-medium tabular-nums text-content">{actualDimensions ?? '读取中'}</strong>
          </span>
          {qualityRates.media ? (
            <span title="根据最近三个视频分片的实际字节数和播放时长估算，包含容器及其中的音频；不能单独代表画面细节。">
              分片码率约 <span className="tabular-nums">{qualityRates.media}</span>
            </span>
          ) : null}
          {qualityRates.download ? (
            <span title="最近一次分片实际传输速度，与视频自身码率不同。">
              本次下载 <span className="tabular-nums">{qualityRates.download}</span>
            </span>
          ) : qualityRates.cached ? <span>本次从本地缓存读取</span> : null}
          {quality.ready && quality.options.length > 1 ? (
            <label className="ml-auto flex flex-wrap items-center gap-2">
              <span>版本 <span className="text-faint">（来源标注）</span></span>
              <select
                className="max-w-full rounded-md border border-line bg-chip px-2 py-1 text-xs text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label="选择画质版本，选项为来源标注"
                title="版本切换在后续片段生效；实际画面尺寸以左侧显示为准。"
                value={quality.selected === -1 ? 'auto' : quality.selected}
                onChange={(event) => selectQuality(event.target.value)}
              >
                <option value="auto">自动{activeOption ? `（当前 ${activeOption.label}）` : ''}</option>
                {quality.options.map((option) => (
                  <option key={option.levelIndex} value={option.levelIndex}>{option.label}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {quality.ready && quality.options.length === 1 ? (
          <p className="mt-1.5 text-faint">当前视频仅提供一个清晰度档位，想更清晰可切换资源。</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2">
          <label className="flex items-center gap-1.5 cursor-pointer" title="按设定秒数跳过，不自动识别广告；修改设置从下次播放或下一集生效。">
            <input
              type="checkbox"
              checked={introPreferences.enabled}
              onChange={(event) => updateIntroPreferences({ enabled: event.target.checked })}
            />
            自动跳过片头
          </label>
          <label className="flex items-center gap-1.5">
            <select
              className="rounded border border-line bg-chip px-1.5 py-1 text-xs text-content"
              aria-label="片头跳过时长"
              value={customIntroSeconds || !INTRO_SKIP_PRESETS.includes(introPreferences.seconds) ? 'custom' : introPreferences.seconds}
              onChange={(event) => {
                if (event.target.value === 'custom') setCustomIntroSeconds(true);
                else {
                  setCustomIntroSeconds(false);
                  updateIntroPreferences({ seconds: Number(event.target.value) });
                }
              }}
            >
              {INTRO_SKIP_PRESETS.map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
              <option value="custom">自定秒数</option>
            </select>
            {customIntroSeconds || !INTRO_SKIP_PRESETS.includes(introPreferences.seconds) ? (
              <>
                <input
                  type="number"
                  className="w-16 rounded border border-line bg-chip px-1.5 py-1 text-xs tabular-nums text-content"
                  min={0}
                  max={600}
                  step={1}
                  aria-label="自定片头秒数，零至六百秒"
                  value={introPreferences.seconds}
                  onChange={(event) => updateIntroPreferences({ seconds: Number(event.target.value) })}
                />
                <span>秒</span>
              </>
            ) : null}
          </label>
          <button className="btn-ghost text-xs px-2 py-1" onClick={skipIntroNow} disabled={introPreferences.seconds === 0}>
            跳过片头
          </button>
          <span className="text-faint">按设定秒数跳过 · 设置下次生效</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex items-center gap-1.5 cursor-pointer" title="进入设定的片尾区间后直接播放下一集，需要开启自动连播；短视频会保留至少30秒正片。">
            <input
              type="checkbox"
              checked={outroPreferences.enabled}
              onChange={(event) => updateOutroPreferences({ enabled: event.target.checked })}
            />
            自动跳过片尾
          </label>
          <label className="flex items-center gap-1.5">
            <select
              className="rounded border border-line bg-chip px-1.5 py-1 text-xs text-content"
              aria-label="片尾跳过时长"
              value={customOutroSeconds || !INTRO_SKIP_PRESETS.includes(outroPreferences.seconds) ? 'custom' : outroPreferences.seconds}
              onChange={(event) => {
                if (event.target.value === 'custom') setCustomOutroSeconds(true);
                else {
                  setCustomOutroSeconds(false);
                  updateOutroPreferences({ seconds: Number(event.target.value) });
                }
              }}
            >
              {INTRO_SKIP_PRESETS.map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
              <option value="custom">自定秒数</option>
            </select>
            {customOutroSeconds || !INTRO_SKIP_PRESETS.includes(outroPreferences.seconds) ? (
              <>
                <input
                  type="number"
                  className="w-16 rounded border border-line bg-chip px-1.5 py-1 text-xs tabular-nums text-content"
                  min={0}
                  max={600}
                  step={1}
                  aria-label="自定片尾秒数，零至六百秒"
                  value={outroPreferences.seconds}
                  onChange={(event) => updateOutroPreferences({ seconds: Number(event.target.value) })}
                />
                <span>秒</span>
              </>
            ) : null}
          </label>
          <span className="text-faint">
            {!nextUrl ? '没有下一集，将自然播完' : !autoplayNext ? '需开启自动连播' : '按设定秒数跳过，直接播放下一集'}
          </span>
        </div>
      </div>
    </div>
  );
}
