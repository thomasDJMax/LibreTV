/** All dimensions shown as actual picture size must come from the video element. */
export function formatVideoDimensions(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  return `${width} × ${height}`;
}

export function formatMediaBitrate(bitsPerSecond: number): string | null {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
  const mbps = bitsPerSecond / 1_000_000;
  return `${mbps.toFixed(mbps < 1 ? 2 : 1)} Mb/s`;
}

export function formatDownloadSpeed(bytesPerSecond: number): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return bytesPerSecond >= 1_000_000
    ? `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`
    : `${Math.round(bytesPerSecond / 1000)} KB/s`;
}

interface DeclaredQualityLevel {
  width: number;
  height: number;
  bitrate: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
}

export interface PlayerQualityOption {
  /** This is the original hls.js level index, never the sorted option position. */
  levelIndex: number;
  levelIndexes: number[];
  label: string;
}

/** Collapse only identical declarations; equal size with different bitrates remains selectable. */
export function buildPlayerQualityOptions(levels: readonly DeclaredQualityLevel[]): PlayerQualityOption[] {
  const byDeclaration = new Map<string, PlayerQualityOption>();
  const labels = new Map<string, number>();
  for (let index = 0; index < levels.length; index++) {
    const level = levels[index];
    const dimensions = formatVideoDimensions(level.width, level.height);
    const bitrate = formatMediaBitrate(level.bitrate);
    const frameRate = Number.isFinite(level.frameRate) && level.frameRate! > 0 ? level.frameRate : 0;
    // Missing metadata cannot establish that two variants contain the same version.
    const key = dimensions || bitrate
      ? JSON.stringify([level.width, level.height, level.bitrate, frameRate, level.videoCodec, level.audioCodec])
      : `unknown:${index}`;
    const existing = byDeclaration.get(key);
    if (existing) {
      existing.levelIndexes.push(index);
      continue;
    }
    const baseLabel = [dimensions, bitrate, frameRate ? `${frameRate} 帧/秒` : null]
      .filter(Boolean).join(' · ') || `版本 ${index + 1}`;
    const duplicateCount = labels.get(baseLabel) ?? 0;
    labels.set(baseLabel, duplicateCount + 1);
    byDeclaration.set(key, {
      levelIndex: index,
      levelIndexes: [index],
      label: duplicateCount ? `${baseLabel}（版本 ${duplicateCount + 1}）` : baseLabel,
    });
  }
  return [...byDeclaration.values()];
}

export interface FragmentRateSample {
  bytes: number;
  duration: number;
  downloadBytesPerSecond: number | null;
}

/** The network timer is deliberately ignored for cache hits, whose loader stats are synthetic. */
export function createFragmentRateSample(input: {
  bytes: number;
  duration: number;
  fromNetwork: boolean;
  loadingStart: number;
  loadingEnd: number;
}): FragmentRateSample | null {
  const { bytes, duration, fromNetwork, loadingStart, loadingEnd } = input;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isFinite(duration) || duration <= 0) return null;
  const elapsed = loadingEnd - loadingStart;
  const downloadBytesPerSecond = fromNetwork && Number.isFinite(loadingStart) && loadingStart >= 0
    && Number.isFinite(loadingEnd) && elapsed > 0
    ? bytes * 1000 / elapsed
    : null;
  return { bytes, duration, downloadBytesPerSecond };
}

/** Weight by media duration: a short high bitrate segment must not dominate a longer one. */
export function recentMediaBitrate(samples: readonly FragmentRateSample[]): number | null {
  if (!samples.length) return null;
  const totals = samples.reduce((sum, sample) => ({
    bytes: sum.bytes + sample.bytes,
    duration: sum.duration + sample.duration,
  }), { bytes: 0, duration: 0 });
  return totals.duration > 0 ? totals.bytes * 8 / totals.duration : null;
}

export interface IntroSkipPreferences {
  enabled: boolean;
  seconds: number;
}

export const DEFAULT_INTRO_SKIP: IntroSkipPreferences = { enabled: true, seconds: 90 };
export type OutroSkipPreferences = IntroSkipPreferences;
export const DEFAULT_OUTRO_SKIP: OutroSkipPreferences = { enabled: true, seconds: 90 };

/** An automatic transition stays locked until the new episode loads. */
export type EpisodeCompletion = false | 'ended' | 'advancing';

export function shouldResumeFinishedEpisode({
  completion, currentTime, duration, paused, ended,
}: {
  completion: EpisodeCompletion;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
}): boolean {
  return completion === 'ended' && !paused && !ended
    && Number.isFinite(duration) && duration > 0
    && Number.isFinite(currentTime) && currentTime >= 0 && currentTime < duration;
}

/** Client storage is untrusted; accept only a boolean and a bounded integer duration. */
export function normalizeIntroSkipPreferences(value: unknown): IntroSkipPreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_INTRO_SKIP.enabled,
    seconds: typeof input.seconds === 'number' && Number.isFinite(input.seconds)
      ? Math.min(600, Math.max(0, Math.round(input.seconds)))
      : DEFAULT_INTRO_SKIP.seconds,
  };
}

export function normalizeOutroSkipPreferences(value: unknown): OutroSkipPreferences {
  return normalizeIntroSkipPreferences(value);
}

/** Null means duration is not known yet. Keep at least ten seconds after a configured intro. */
export function resolveStartPosition({
  duration,
  savedPosition = 0,
  preferences,
}: {
  duration: number;
  savedPosition?: number;
  preferences: IntroSkipPreferences;
}): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const saved = Number.isFinite(savedPosition) && savedPosition > 10 && savedPosition < duration - 2
    ? savedPosition : 0;
  const intro = normalizeIntroSkipPreferences(preferences);
  const skip = intro.enabled && intro.seconds > 0 && duration >= intro.seconds + 10 ? intro.seconds : 0;
  return Math.max(saved, skip);
}

/** Only active playback can automatically advance. Never consume the entire main feature. */
export function shouldAutoSkipOutro({
  duration,
  currentTime,
  introPreferences,
  outroPreferences,
  autoplayNext,
  hasNext,
  isPlaying,
  isPaused,
  isSeeking,
  alreadyFinished,
}: {
  duration: number;
  currentTime: number;
  introPreferences: IntroSkipPreferences;
  outroPreferences: OutroSkipPreferences;
  autoplayNext: boolean;
  hasNext: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  isSeeking: boolean;
  alreadyFinished: boolean;
}): boolean {
  if (!autoplayNext || !hasNext || !isPlaying || isPaused || isSeeking || alreadyFinished) return false;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime) || currentTime < 0 || currentTime >= duration) return false;
  const outro = normalizeOutroSkipPreferences(outroPreferences);
  if (!outro.enabled || outro.seconds <= 0) return false;
  const intro = normalizeIntroSkipPreferences(introPreferences);
  const introSeconds = intro.enabled && duration >= intro.seconds + 10 ? intro.seconds : 0;
  if (duration - introSeconds - outro.seconds < 30) return false;
  return currentTime >= duration - outro.seconds;
}
