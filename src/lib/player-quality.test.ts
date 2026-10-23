import { describe, expect, it } from 'vitest';
import {
  buildPlayerQualityOptions,
  createFragmentRateSample,
  formatDownloadSpeed,
  formatMediaBitrate,
  formatVideoDimensions,
  recentMediaBitrate,
  normalizeIntroSkipPreferences,
  resolveStartPosition,
  normalizeOutroSkipPreferences,
  shouldAutoSkipOutro,
  shouldResumeFinishedEpisode,
} from './player-quality';

describe('player quality metadata boundaries', () => {
  it('does not invent a resolution from missing, non-finite or fractional dimensions', () => {
    expect(formatVideoDimensions(2542, 1080)).toBe('2542 × 1080');
    for (const invalid of [0, -1, NaN, Infinity, 1920.5]) {
      expect(formatVideoDimensions(invalid, 1080)).toBeNull();
      expect(formatVideoDimensions(1920, invalid)).toBeNull();
    }
  });

  it('keeps same-resolution variants with different bitrates or codecs mapped to their original indexes', () => {
    const options = buildPlayerQualityOptions([
      { width: 1920, height: 1080, bitrate: 4_000_000, videoCodec: 'avc1' },
      { width: 1280, height: 720, bitrate: 2_000_000 },
      { width: 1920, height: 1080, bitrate: 8_000_000, videoCodec: 'avc1' },
      { width: 1920, height: 1080, bitrate: 4_000_000, videoCodec: 'avc1' },
      { width: 1920, height: 1080, bitrate: 4_000_000, videoCodec: 'hvc1' },
    ]);
    expect(options.map((option) => option.levelIndex)).toEqual([0, 1, 2, 4]);
    expect(options[0].levelIndexes).toEqual([0, 3]);
    expect(options[2].label).toContain('8.0 Mb/s');
    expect(new Set(options.map((option) => option.label)).size).toBe(4);
  });

  it('does not collapse unknown variants or fabricate a resolution for them', () => {
    const options = buildPlayerQualityOptions([
      { width: 0, height: 0, bitrate: 0 },
      { width: 0, height: 0, bitrate: 0 },
    ]);
    expect(options.map((option) => option.label)).toEqual(['版本 1', '版本 2']);
  });
});

describe('replaying a completed episode', () => {
  const playingAgain = { completion: 'ended' as const, currentTime: 600, duration: 1500, paused: false, ended: false };

  it('restores progress tracking after replaying a movie or final episode', () => {
    expect(shouldResumeFinishedEpisode(playingAgain)).toBe(true);
    expect(shouldResumeFinishedEpisode({ ...playingAgain, currentTime: 0 })).toBe(true);
  });

  it('keeps automatic next-episode transitions locked even if an old video emits playing', () => {
    expect(shouldResumeFinishedEpisode({ ...playingAgain, completion: 'advancing' })).toBe(false);
    expect(shouldResumeFinishedEpisode({ ...playingAgain, completion: false })).toBe(false);
  });

  it('does not reset completion from paused seeks, terminal frames or unknown media', () => {
    expect(shouldResumeFinishedEpisode({ ...playingAgain, paused: true })).toBe(false);
    expect(shouldResumeFinishedEpisode({ ...playingAgain, ended: true })).toBe(false);
    expect(shouldResumeFinishedEpisode({ ...playingAgain, currentTime: 1500 })).toBe(false);
    expect(shouldResumeFinishedEpisode({ ...playingAgain, currentTime: -1 })).toBe(false);
    expect(shouldResumeFinishedEpisode({ ...playingAgain, duration: Infinity })).toBe(false);
    expect(shouldResumeFinishedEpisode({ ...playingAgain, duration: NaN })).toBe(false);
  });
});

describe('automatic outro advancement', () => {
  const playable = {
    duration: 1500, currentTime: 1410,
    introPreferences: { enabled: true, seconds: 90 },
    outroPreferences: { enabled: true, seconds: 90 },
    autoplayNext: true, hasNext: true, isPlaying: true,
    isPaused: false, isSeeking: false, alreadyFinished: false,
  };

  it('defaults to 90 seconds and accepts only bounded stored preferences', () => {
    expect(normalizeOutroSkipPreferences(null)).toEqual({ enabled: true, seconds: 90 });
    expect(normalizeOutroSkipPreferences({ enabled: false, seconds: 1234 })).toEqual({ enabled: false, seconds: 600 });
  });

  it('advances at the configured boundary, never just before it or on an ended element', () => {
    expect(shouldAutoSkipOutro(playable)).toBe(true);
    expect(shouldAutoSkipOutro({ ...playable, currentTime: 1409.9 })).toBe(false);
    expect(shouldAutoSkipOutro({ ...playable, currentTime: 1500 })).toBe(false);
    expect(shouldAutoSkipOutro({ ...playable, outroPreferences: { enabled: true, seconds: 30 }, currentTime: 1470 })).toBe(true);
  });

  it('requires next episode, autoplay, normal playback and a fresh completion guard', () => {
    for (const blocked of [
      { autoplayNext: false }, { hasNext: false }, { isPlaying: false },
      { isPaused: true }, { isSeeking: true }, { alreadyFinished: true },
      { outroPreferences: { enabled: false, seconds: 90 } },
      { outroPreferences: { enabled: true, seconds: 0 } },
    ]) expect(shouldAutoSkipOutro({ ...playable, ...blocked })).toBe(false);
  });

  it('preserves at least 30 seconds between the applied intro setting and outro', () => {
    expect(shouldAutoSkipOutro({ ...playable, duration: 209, currentTime: 120 })).toBe(false);
    expect(shouldAutoSkipOutro({ ...playable, duration: 210, currentTime: 120 })).toBe(true);
    expect(shouldAutoSkipOutro({ ...playable, duration: 200, currentTime: 110, introPreferences: { enabled: false, seconds: 90 } })).toBe(true);
    expect(shouldAutoSkipOutro({ ...playable, duration: 119, currentTime: 90 })).toBe(false);
  });

  it('rejects unknown/live durations and malformed positions', () => {
    for (const duration of [0, -1, Infinity, NaN]) expect(shouldAutoSkipOutro({ ...playable, duration })).toBe(false);
    for (const currentTime of [-1, Infinity, NaN]) expect(shouldAutoSkipOutro({ ...playable, currentTime })).toBe(false);
  });
});

describe('intro skip and resume position', () => {
  it('defaults to enabled 90 seconds and clamps untrusted client storage', () => {
    expect(normalizeIntroSkipPreferences(null)).toEqual({ enabled: true, seconds: 90 });
    expect(normalizeIntroSkipPreferences({ enabled: false, seconds: 999 })).toEqual({ enabled: false, seconds: 600 });
    expect(normalizeIntroSkipPreferences({ enabled: 'false', seconds: -30 })).toEqual({ enabled: true, seconds: 0 });
    expect(normalizeIntroSkipPreferences({ seconds: Infinity })).toEqual({ enabled: true, seconds: 90 });
    expect(normalizeIntroSkipPreferences({ seconds: 30.4 })).toEqual({ enabled: true, seconds: 30 });
  });

  it('skips a new episode but never moves valid later history backwards', () => {
    const preferences = { enabled: true, seconds: 90 };
    expect(resolveStartPosition({ duration: 1500, preferences })).toBe(90);
    expect(resolveStartPosition({ duration: 1500, savedPosition: 45, preferences })).toBe(90);
    expect(resolveStartPosition({ duration: 1500, savedPosition: 900, preferences })).toBe(900);
    expect(resolveStartPosition({ duration: 1500, savedPosition: 1501, preferences })).toBe(90);
  });

  it('does not skip short clips or live/unknown durations into their ending', () => {
    const preferences = { enabled: true, seconds: 90 };
    expect(resolveStartPosition({ duration: 99, preferences })).toBe(0);
    expect(resolveStartPosition({ duration: 100, preferences })).toBe(90);
    expect(resolveStartPosition({ duration: 50, savedPosition: 20, preferences })).toBe(20);
    expect(resolveStartPosition({ duration: NaN, preferences })).toBeNull();
    expect(resolveStartPosition({ duration: Infinity, preferences })).toBeNull();
    expect(resolveStartPosition({ duration: 0, preferences })).toBeNull();
  });

  it('keeps resume working when intro skipping is disabled or set to zero', () => {
    expect(resolveStartPosition({ duration: 1500, savedPosition: 500, preferences: { enabled: false, seconds: 90 } })).toBe(500);
    expect(resolveStartPosition({ duration: 1500, preferences: { enabled: false, seconds: 90 } })).toBe(0);
    expect(resolveStartPosition({ duration: 1500, preferences: { enabled: true, seconds: 0 } })).toBe(0);
  });
});

describe('fragment bitrate versus transfer speed', () => {
  it('weights the media rate by duration and keeps network speed a separate quantity', () => {
    const first = createFragmentRateSample({ bytes: 1_000_000, duration: 2, fromNetwork: true, loadingStart: 100, loadingEnd: 600 })!;
    const second = createFragmentRateSample({ bytes: 1_000_000, duration: 6, fromNetwork: true, loadingStart: 700, loadingEnd: 1700 })!;
    expect(recentMediaBitrate([first, second])).toBe(2_000_000);
    expect(first.downloadBytesPerSecond).toBe(2_000_000);
    expect(formatMediaBitrate(recentMediaBitrate([first, second])!)).toBe('2.0 Mb/s');
    expect(formatDownloadSpeed(first.downloadBytesPerSecond!)).toBe('2.0 MB/s');
  });

  it('retains media samples from cache without presenting synthetic cache timings as network speed', () => {
    const cached = createFragmentRateSample({ bytes: 1_000_000, duration: 4, fromNetwork: false, loadingStart: 100, loadingEnd: 101 })!;
    expect(recentMediaBitrate([cached])).toBe(2_000_000);
    expect(cached.downloadBytesPerSecond).toBeNull();
    expect(createFragmentRateSample({ bytes: 0, duration: 4, fromNetwork: true, loadingStart: 0, loadingEnd: 10 })).toBeNull();
    expect(createFragmentRateSample({ bytes: 1000, duration: NaN, fromNetwork: true, loadingStart: 0, loadingEnd: 10 })).toBeNull();
    expect(createFragmentRateSample({ bytes: 1000, duration: 4, fromNetwork: true, loadingStart: 0, loadingEnd: 0 })!.downloadBytesPerSecond).toBeNull();
    expect(recentMediaBitrate([])).toBeNull();
  });
});
