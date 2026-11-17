/**
 * 智能跳过片头（客户端）：
 * - 偏好开关存 localStorage；
 * - 识别结果按「源 + 剧集」缓存，同一部剧只在第一集播放时识别一次；
 * - 请求后端 /api/intro，由服务端用 ffmpeg 分析开头片段得出正片开始时间。
 *
 * 识别不出来时返回 INTRO_AUTO_NO_INTRO，播放器照常从头播放。
 */

export const INTRO_AUTO_PREF_KEY = 'libretv:intro-auto:v1';
export const INTRO_AUTO_CACHE_KEY = 'libretv:intro-auto-cache:v1';
/** 缓存里的哨兵值：这部剧本集开头没有片头（不用跳）。 */
export const INTRO_AUTO_NO_INTRO = -1;
const MAX_CACHED_SERIES = 300;

export interface IntroAutoPreference {
  enabled: boolean;
}

/** 默认开启：新装的播放器直接享受自动识别，用户可随时关掉回退到固定秒数。 */
export const DEFAULT_INTRO_AUTO: IntroAutoPreference = { enabled: true };

export function normalizeIntroAutoPreference(value: unknown): IntroAutoPreference {
  if (!value || typeof value !== 'object') return { ...DEFAULT_INTRO_AUTO };
  const record = value as Record<string, unknown>;
  return { enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_INTRO_AUTO.enabled };
}

export function readIntroAutoPreference(): IntroAutoPreference {
  if (typeof window === 'undefined') return { ...DEFAULT_INTRO_AUTO };
  try {
    return normalizeIntroAutoPreference(JSON.parse(window.localStorage.getItem(INTRO_AUTO_PREF_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_INTRO_AUTO };
  }
}

export function writeIntroAutoPreference(preference: IntroAutoPreference): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(INTRO_AUTO_PREF_KEY, JSON.stringify(normalizeIntroAutoPreference(preference))); } catch { /* Storage may be unavailable. */ }
}

/** 识别缓存的键：同一部剧（同一源的同一个 vodId）共用一次识别结果。 */
export function introSeriesKey(seriesKey: string | undefined, title: string): string {
  return seriesKey?.trim() || title.trim() || 'unknown';
}

type IntroAutoCache = Record<string, number>;

function readCache(): IntroAutoCache {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(INTRO_AUTO_CACHE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const record: IntroAutoCache = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) record[key] = value;
    }
    return record;
  } catch {
    return {};
  }
}

function writeCache(cache: IntroAutoCache): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(INTRO_AUTO_CACHE_KEY, JSON.stringify(cache)); } catch { /* Storage may be unavailable. */ }
}

/** 返回缓存的片头秒数；null 表示还没识别过；INTRO_AUTO_NO_INTRO 表示识别过但没有片头。 */
export function readIntroAutoCache(key: string): number | null {
  const cache = readCache();
  const value = cache[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function writeIntroAutoCache(key: string, seconds: number): void {
  const cache = readCache();
  cache[key] = Math.round(seconds);
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHED_SERIES) {
    for (const extra of keys.slice(0, keys.length - MAX_CACHED_SERIES)) delete cache[extra];
  }
  writeCache(cache);
}

export interface IntroDetectionResult {
  ok: boolean;
  skipTo?: number;
  confidence?: 'none' | 'medium' | 'high';
  evidence?: string;
  scanned?: number;
  cached?: boolean;
  reason?: string;
}

export interface IntroDetectionRequest {
  title: string;
  key: string;
  url: string;
  signal?: AbortSignal;
}

export function introDetectionQuery(request: IntroDetectionRequest): URLSearchParams {
  const params = new URLSearchParams();
  params.set('title', request.title);
  params.set('key', request.key);
  params.set('url', request.url);
  return params;
}

/** 请求服务端识别片头；失败返回 null（播放器照常播放，不做任何跳转）。 */
export async function requestIntroDetection(request: IntroDetectionRequest): Promise<IntroDetectionResult | null> {
  const params = introDetectionQuery(request);
  try {
    const response = await fetch(`/api/intro?${params.toString()}`, {
      signal: request.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return (await response.json()) as IntroDetectionResult;
  } catch {
    return null;
  }
}
