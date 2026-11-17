import { describe, expect, it } from 'vitest';
import type { VodQualityResult } from './types';
import { isAlreadySharp, isClearlyBetter, qualityLabel, sampleKbps, samplePixels } from './quality-boost';

function sample(overrides: Partial<VodQualityResult> = {}): VodQualityResult {
  return {
    url: 'https://example.com/index.m3u8',
    ok: true,
    evidence: 'bitstream',
    width: 1920,
    height: 1080,
    mediaKbps: 1821,
    ...overrides,
  };
}

describe('quality boost comparison', () => {
  it('treats a 1080p stream as clearly better than a 1080-wide letterboxed low-bitrate stream', () => {
    expect(isClearlyBetter(sample({ width: 1080, height: 606, mediaKbps: 768 }), sample())).toBe(true);
  });

  it('treats 1080p as clearly better than 720p', () => {
    expect(isClearlyBetter(sample({ width: 1280, height: 720, mediaKbps: 747 }), sample())).toBe(true);
  });

  it('does not flag the same resolution and a lower bitrate', () => {
    expect(isClearlyBetter(sample(), sample({ mediaKbps: 1200 }))).toBe(false);
  });

  it('flags a same-resolution stream when bitrate improves enough', () => {
    expect(isClearlyBetter(sample({ mediaKbps: 1000 }), sample({ mediaKbps: 1600 }))).toBe(true);
    expect(isClearlyBetter(sample({ mediaKbps: 1000 }), sample({ mediaKbps: 1300 }))).toBe(false);
  });

  it('requires decoded bitstream evidence instead of manifest labels', () => {
    expect(isClearlyBetter(sample(), sample({ evidence: 'manifest' }))).toBe(false);
    expect(isClearlyBetter(sample(), sample({ ok: false }))).toBe(false);
    expect(isClearlyBetter(sample(), undefined)).toBe(false);
  });

  it('does not count the identical media sample as another line', () => {
    expect(isClearlyBetter(
      sample({ width: 1280, height: 720, mediaKbps: 747, sampleHash: 'abc' }),
      sample({ sampleHash: 'ABC' }),
    )).toBe(false);
  });

  it('when current quality is unknown, only high-definition candidates qualify', () => {
    expect(isClearlyBetter(undefined, sample())).toBe(true);
    expect(isClearlyBetter(undefined, sample({ width: 1280, height: 720, mediaKbps: 747 }))).toBe(false);
    expect(isClearlyBetter(undefined, sample({ width: 1280, height: 720, mediaKbps: 2500 }))).toBe(true);
  });

  it('stops looking when the current line is already sharp', () => {
    expect(isAlreadySharp(sample({ mediaKbps: 3000 }))).toBe(true);
    expect(isAlreadySharp(sample())).toBe(false);
    expect(isAlreadySharp(sample({ width: 1080, height: 606, mediaKbps: 768 }))).toBe(false);
  });

  it('formats measured samples for the hint text', () => {
    expect(qualityLabel(sample())).toBe('1920×1080 · 1.82 Mbps');
    expect(qualityLabel(sample({ width: undefined, height: undefined, mediaKbps: 768 }))).toBe('0.77 Mbps');
    expect(qualityLabel(undefined)).toBeUndefined();
    expect(samplePixels(sample({ width: 1080, height: 606 }))).toBe(654480);
    expect(sampleKbps(sample({ mediaKbps: 0 }))).toBe(0);
  });
});
