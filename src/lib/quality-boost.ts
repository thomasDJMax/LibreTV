import type { VodQualityResult } from './types';

/** 像素面积提升达到这一比例，才算「更清晰线路」。 */
export const PIXEL_IMPROVEMENT = 1.1;
/** 码率提升达到这一比例，才算「更清晰线路」（同分辨率下码率翻倍才够明显）。 */
export const BITRATE_IMPROVEMENT = 1.4;
/** 1080p 的像素数，作为「当前画质未知时」的候选门槛。 */
export const HIGH_DEFINITION_PIXELS = 1920 * 1080;
/** 已经足够清晰的基线：达到这两项就不再后台找源，避免无谓请求。 */
export const ALREADY_SHARP_KBPS = 2500;

/** 只有真实解码出的码流样本才算证据，清单标注或失败结果一律视为未知。 */
export function isMeasuredQuality(sample?: VodQualityResult): boolean {
  if (!sample || sample.ok !== true || sample.evidence !== 'bitstream') return false;
  return samplePixels(sample) > 0 || sampleKbps(sample) > 0;
}

export function samplePixels(sample?: VodQualityResult): number {
  const width = sample?.width;
  const height = sample?.height;
  return Number.isFinite(width) && Number.isFinite(height) && (width as number) > 0 && (height as number) > 0
    ? (width as number) * (height as number)
    : 0;
}

export function sampleKbps(sample?: VodQualityResult): number {
  const value = sample?.mediaKbps;
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0;
}

/** 「1920×1080 · 1.82 Mbps」；只有码率时退化为「1.82 Mbps」。 */
export function qualityLabel(sample?: VodQualityResult): string | undefined {
  const pixels = samplePixels(sample);
  const kbps = sampleKbps(sample);
  const parts: string[] = [];
  if (pixels > 0) parts.push(`${sample?.width}×${sample?.height}`);
  if (kbps > 0) parts.push(`${(kbps / 1000).toFixed(2)} Mbps`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** 当前样本已经足够清晰（1080p 且码率不低），无需再找。 */
export function isAlreadySharp(sample?: VodQualityResult): boolean {
  return isMeasuredQuality(sample) && samplePixels(sample) >= HIGH_DEFINITION_PIXELS && sampleKbps(sample) >= ALREADY_SHARP_KBPS;
}

/**
 * 候选线路是否明显优于当前线路。
 * - 当前画质未知：候选必须是实测 1080p 以上或高码率，避免低分辨率噪音；
 * - 当前画质已知：像素面积或码率其中一项明显提升即可；
 * - 同一份码流样本（sampleHash 相同）不是另一条线路。
 */
export function isClearlyBetter(current: VodQualityResult | undefined, candidate: VodQualityResult | undefined): boolean {
  if (!isMeasuredQuality(candidate)) return false;
  const candidateHash = candidate?.sampleHash?.trim().toLowerCase();
  const currentHash = current?.sampleHash?.trim().toLowerCase();
  if (candidateHash && currentHash && candidateHash === currentHash) return false;
  const candidatePixels = samplePixels(candidate);
  const candidateKbps = sampleKbps(candidate);
  if (!isMeasuredQuality(current)) {
    return candidatePixels >= HIGH_DEFINITION_PIXELS || candidateKbps >= ALREADY_SHARP_KBPS;
  }
  const currentPixels = samplePixels(current);
  const currentKbps = sampleKbps(current);
  const pixelsBetter = currentPixels > 0 && candidatePixels >= currentPixels * PIXEL_IMPROVEMENT;
  const bitrateBetter = currentKbps > 0 && candidateKbps >= currentKbps * BITRATE_IMPROVEMENT;
  return pixelsBetter || bitrateBetter;
}
