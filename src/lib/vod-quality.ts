/** Server-only, bounded HLS sample inspection. Manifest labels never become measured dimensions. */
import { createDecipheriv, createHash } from 'node:crypto';
import { fetchUpstreamWithMeta } from './fetch-utils';
import type { VodQualityResult } from './types';

const BUDGET_MS = 8_000;
// Long VOD playlists can contain thousands of segments; keep the media sample small separately.
const MANIFEST_LIMIT = 2 * 1024 * 1024;
const SEGMENT_LIMIT = 256 * 1024;
const HASH_BYTES = 64 * 1024;
const MAX_CACHE = 200;
const MAX_CONCURRENCY = 3;
const MAX_QUEUE = 32;
const UA = process.env.USER_AGENT || 'Mozilla/5.0 AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36';

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason || new DOMException('请求已取消', 'AbortError');
}

/** Race even non-stream/DNS mocks against cancellation; actual fetch also receives this signal. */
async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void promise.catch(() => {});
  aborted(signal);
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason || new DOMException('请求已取消', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** Cap retained bytes and cancel the stream, including servers ignoring Range with HTTP 200. */
export async function readQualityBody(
  response: Pick<Response, 'body' | 'headers'>,
  limit: number,
  signal: AbortSignal,
  requireComplete = false,
): Promise<Uint8Array> {
  aborted(signal);
  if (!response.body) throw new Error('上游返回空内容');
  const contentLength = Number(response.headers.get('content-length'));
  if (requireComplete && Number.isFinite(contentLength) && contentLength > limit) {
    void response.body.cancel().catch(() => {});
    throw new Error('上游内容超过大小限制');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await withSignal(reader.read(), signal);
      if (done) break;
      if (requireComplete && length + value.byteLength > limit) throw new Error('上游内容超过大小限制');
      const keep = value.subarray(0, Math.max(0, limit - length));
      if (keep.byteLength) {
        chunks.push(keep.slice());
        length += keep.byteLength;
      }
      if (length >= limit && !requireComplete) break;
    }
  } finally {
    // Do not await an upstream stream's potentially stalled cancellation hook.
    void reader.cancel().catch(() => {});
  }
  aborted(signal);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

type HlsKey = { method: string; url?: string; iv?: string; format?: string };
export interface QualityPlaylist {
  variants: { url: string; area: number; bandwidth: number }[];
  segment?: { url: string; duration?: number; sequence: bigint; key?: HlsKey; range?: { offset: number; length: number } };
}

function attrs(line: string): Record<string, string> {
  const values: Record<string, string> = {};
  const part = line.slice(line.indexOf(':') + 1);
  for (const match of part.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g)) values[match[1]] = match[2] ?? match[3];
  return values;
}

function publicProtocolUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) {
    throw new Error('播放列表包含无效的媒体地址');
  }
  // The network request performs the DNS/private-address and every-redirect validation.
  return url.href;
}

/** First media segment only. Sequence and encryption state are captured at that segment. */
export function parseQualityPlaylist(text: string, base: string): QualityPlaylist {
  const lines = text.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('返回内容不是有效的 HLS 播放列表');
  const variants: QualityPlaylist['variants'] = [];
  let pendingVariant: Record<string, string> | undefined;
  let sequence = 0n;
  let key: HlsKey | undefined;
  let duration: number | undefined;
  let byteRange: { offset: number; length: number } | undefined;
  let awaitingRangeOffset = false;
  let segment: QualityPlaylist['segment'];
  let gap = false;
  let skippedRangeEnd = 0;
  let skippedRangeUrl = '';
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = attrs(line);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = line.slice(line.indexOf(':') + 1);
      if (!/^\d{1,39}$/.test(value)) throw new Error('无效的 HLS 分片序列号');
      sequence = BigInt(value);
      if (sequence >= 1n << 128n) throw new Error('HLS 分片序列号超出范围');
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const value = attrs(line);
      key = value.METHOD === 'NONE' ? undefined : {
        method: value.METHOD,
        url: value.URI ? publicProtocolUrl(value.URI, base) : undefined,
        iv: value.IV,
        format: value.KEYFORMAT,
      };
    } else if (line.startsWith('#EXTINF:')) {
      const value = Number(line.slice(8).split(',')[0]);
      duration = Number.isFinite(value) && value > 0 && value <= 86400 ? value : undefined;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const match = /^(\d+)(?:@(\d+))?$/.exec(line.slice(17));
      if (!match) throw new Error('无效的 HLS 字节范围');
      byteRange = { length: Number(match[1]), offset: match[2] === undefined ? skippedRangeEnd : Number(match[2]) };
      awaitingRangeOffset = match[2] === undefined;
      if (!Number.isSafeInteger(byteRange.length) || byteRange.length <= 0 || !Number.isSafeInteger(byteRange.offset) || byteRange.offset < 0 || !Number.isSafeInteger(byteRange.offset + byteRange.length)) {
        throw new Error('HLS 字节范围超出限制');
      }
    } else if (line === '#EXT-X-GAP') {
      gap = true;
    } else if (!line.startsWith('#')) {
      const url = publicProtocolUrl(line, base);
      if (pendingVariant) {
        const resolution = /^(\d{1,5})x(\d{1,5})$/i.exec(pendingVariant.RESOLUTION || '');
        const area = resolution ? Number(resolution[1]) * Number(resolution[2]) : 0;
        const bandwidth = Number(pendingVariant.BANDWIDTH);
        variants.push({ url, area, bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : 0 });
        pendingVariant = undefined;
      } else if (!segment) {
        if (awaitingRangeOffset && (!skippedRangeUrl || skippedRangeUrl !== url)) throw new Error('HLS 字节范围缺少起始偏移');
        if (gap) {
          if (byteRange) { skippedRangeEnd = byteRange.offset + byteRange.length; skippedRangeUrl = url; }
          sequence += 1n;
        } else {
          segment = { url, duration, sequence, key, range: byteRange };
        }
        duration = undefined;
        byteRange = undefined;
        awaitingRangeOffset = false;
        gap = false;
      }
    }
  }
  variants.sort((a, b) => b.area - a.area || b.bandwidth - a.bandwidth);
  return { variants, segment };
}

/** RFC 8216: explicit big-endian IV, otherwise the media sequence in 128 bits. */
export function qualityIv(sequence: bigint, declared?: string): Uint8Array {
  if (sequence < 0n || sequence >= 1n << 128n) throw new Error('HLS 分片序列号超出范围');
  const hex = declared === undefined ? sequence.toString(16) : declared.replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,32}$/i.test(hex)) throw new Error('无效的 AES-128 IV');
  return new Uint8Array(Buffer.from(hex.padStart(32, '0'), 'hex'));
}

export function decryptQualitySample(bytes: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  if (key.byteLength !== 16 || iv.byteLength !== 16) throw new Error('AES-128 密钥长度无效');
  const length = bytes.byteLength - bytes.byteLength % 16;
  if (!length) throw new Error('加密分片样本过短');
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false); // The prefix is not the final block: never unpad it.
  return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(0, length)), decipher.final()]));
}

class SpsBits {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(count = 1): number {
    if (count < 0 || count > 32 || this.offset + count > this.bytes.byteLength * 8) throw new Error('截断的 SPS');
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = value * 2 + ((this.bytes[this.offset >> 3] >> (7 - (this.offset & 7))) & 1);
      this.offset++;
    }
    return value;
  }
  ue(max = 16_777_215): number {
    let zeros = 0;
    while (!this.read()) { if (++zeros > 24) throw new Error('SPS 数值超出限制'); }
    const value = 2 ** zeros - 1 + this.read(zeros);
    if (value > max) throw new Error('SPS 数值超出限制');
    return value;
  }
  se(): number { const value = this.ue(); return value & 1 ? (value + 1) / 2 : -value / 2; }
}

/** Parse only the bounded syntax necessary for H.264 display dimensions, including chroma cropping. */
export function parseH264Sps(nal: Uint8Array): { width: number; height: number; codec: string } | undefined {
  try {
    if (nal.byteLength < 5 || nal.byteLength > 4096 || (nal[0] & 0x9f) !== 7 || !(nal[0] & 0x60)) return undefined;
    const rbsp: number[] = [];
    for (let i = 1; i < nal.byteLength; i++) {
      if (i > 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) {
        if (i + 1 >= nal.byteLength || nal[i + 1] > 3) return undefined;
        continue;
      }
      rbsp.push(nal[i]);
    }
    const bits = new SpsBits(new Uint8Array(rbsp));
    const profile = bits.read(8);
    bits.read(8); // constraint flags
    bits.read(8); // level
    bits.ue(31); // seq_parameter_set_id
    let chroma = 1;
    let separatePlane = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = bits.ue(3);
      if (chroma === 3) separatePlane = bits.read();
      bits.ue(6); // bit_depth_luma_minus8
      bits.ue(6); // bit_depth_chroma_minus8
      bits.read();
      if (bits.read()) {
        for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
          if (!bits.read()) continue;
          let last = 8;
          let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + bits.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    } else if (![66, 77, 88].includes(profile)) return undefined;
    bits.ue(12); // log2_max_frame_num_minus4
    const orderType = bits.ue(2);
    if (orderType === 0) bits.ue(12);
    else if (orderType === 1) {
      bits.read(); bits.se(); bits.se();
      const count = bits.ue(255);
      for (let i = 0; i < count; i++) bits.se();
    }
    bits.ue(32); // max_num_ref_frames
    bits.read();
    const mbsWide = bits.ue(1023) + 1;
    const mapUnitsHigh = bits.ue(1023) + 1;
    const frameOnly = bits.read();
    if (!frameOnly) bits.read();
    bits.read();
    let left = 0, right = 0, top = 0, bottom = 0;
    if (bits.read()) { left = bits.ue(16384); right = bits.ue(16384); top = bits.ue(16384); bottom = bits.ue(16384); }
    bits.read(); // vui_parameters_present_flag (parameters aren't required for coded dimensions)
    const chromaArray = separatePlane ? 0 : chroma;
    const cropX = chromaArray === 1 || chromaArray === 2 ? 2 : 1;
    const cropY = (chromaArray === 1 ? 2 : 1) * (2 - frameOnly);
    const width = mbsWide * 16 - cropX * (left + right);
    const height = mapUnitsHigh * 16 * (2 - frameOnly) - cropY * (top + bottom);
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 134_217_728) return undefined;
    return { width, height, codec: 'H.264' };
  } catch { return undefined; }
}

function annexBDimensions(bytes: Uint8Array): ReturnType<typeof parseH264Sps> {
  let nalStart = -1;
  for (let i = 0; i + 3 < bytes.byteLength; i++) {
    const prefix = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 ? 3 :
      (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0);
    if (!prefix) continue;
    if (nalStart >= 0 && (bytes[nalStart] & 31) === 7) {
      const dimensions = parseH264Sps(bytes.subarray(nalStart, i));
      if (dimensions) return dimensions;
    }
    nalStart = i + prefix;
    i += prefix - 1;
  }
  return nalStart >= 0 && (bytes[nalStart] & 31) === 7 ? parseH264Sps(bytes.subarray(nalStart)) : undefined;
}

/** TS packet boundaries and PES headers must be removed before searching NAL units. */
export function dimensionsFromQualitySample(bytes: Uint8Array): ReturnType<typeof parseH264Sps> {
  let sync = -1;
  for (let i = 0; i < Math.min(188, bytes.byteLength - 188); i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && (i + 376 >= bytes.byteLength || bytes[i + 376] === 0x47)) { sync = i; break; }
  }
  if (sync < 0) {
    // fMP4 needs parsing avcC/hvcC rather than assuming a manifest's declared resolution.
    if (bytes.byteLength >= 8 && ['ftyp', 'styp', 'moof', 'moov'].includes(Buffer.from(bytes.subarray(4, 8)).toString('ascii'))) return undefined;
    return annexBDimensions(bytes);
  }
  const streams = new Map<number, { chunks: Uint8Array[]; size: number; cc: number }>();
  for (let i = sync; i + 188 <= bytes.byteLength; i += 188) {
    if (bytes[i] !== 0x47 || bytes[i + 1] & 0x80 || bytes[i + 3] & 0xc0) continue;
    const pid = ((bytes[i + 1] & 31) << 8) | bytes[i + 2];
    const control = (bytes[i + 3] >> 4) & 3;
    if (control !== 1 && control !== 3) continue;
    let offset = i + 4;
    if (control === 3) offset += 1 + bytes[offset];
    if (offset >= i + 188) continue;
    const cc = bytes[i + 3] & 15;
    let stream = streams.get(pid);
    if (stream && cc === stream.cc) continue;
    if (stream && cc !== (stream.cc + 1) % 16) { streams.delete(pid); stream = undefined; }
    if (bytes[i + 1] & 0x40) {
      if (offset + 9 > i + 188 || bytes[offset] || bytes[offset + 1] || bytes[offset + 2] !== 1 || (bytes[offset + 3] & 0xf0) !== 0xe0 || (bytes[offset + 6] & 0xc0) !== 0x80) continue;
      const headerEnd = offset + 9 + bytes[offset + 8];
      if (headerEnd > i + 188) continue;
      offset = headerEnd;
      if (!stream && streams.size < 64) { stream = { chunks: [], size: 0, cc }; streams.set(pid, stream); }
    }
    if (!stream) continue;
    stream.cc = cc;
    const payload = bytes.subarray(offset, i + 188);
    stream.chunks.push(payload);
    stream.size += payload.byteLength;
  }
  for (const stream of streams.values()) {
    const elementary = new Uint8Array(stream.size);
    let offset = 0;
    for (const payload of stream.chunks) { elementary.set(payload, offset); offset += payload.byteLength; }
    const dimensions = annexBDimensions(elementary);
    if (dimensions) return dimensions;
  }
  return undefined;
}

const cache = new Map<string, { result: VodQualityResult; until: number }>();
let active = 0;
const queue: (() => void)[] = [];

async function slot(signal: AbortSignal): Promise<() => void> {
  aborted(signal);
  if (active >= MAX_CONCURRENCY) {
    if (queue.length >= MAX_QUEUE) throw new Error('画质检测繁忙，请稍后重试');
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => {
        const index = queue.indexOf(wake);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason || new DOMException('请求已取消', 'AbortError'));
      };
      queue.push(wake);
      signal.addEventListener('abort', cancel, { once: true });
    });
    // A slot is transferred to us by release(), rather than opened for competing callers.
    if (signal.aborted) { release(); aborted(signal); }
  } else active++;
  let released = false;
  return () => { if (!released) { released = true; release(); } };
}

function release(): void {
  const next = queue.shift();
  if (next) next(); else active--;
}

async function inspect(url: string, signal: AbortSignal): Promise<VodQualityResult> {
  const origin = new URL(url).origin + '/';
  const request = async (target: string, range?: string) => {
    aborted(signal);
    const response = await withSignal(fetchUpstreamWithMeta(target, {
      timeoutMs: BUDGET_MS, retries: 0, allowPrivate: false, signal,
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: origin, ...(range ? { Range: range } : {}) },
    }), signal);
    aborted(signal);
    if (!response.res.ok) {
      void response.res.body?.cancel().catch(() => {});
      throw new Error(`上游响应 HTTP ${response.res.status}`);
    }
    return response;
  };
  let current = url;
  let playlist: QualityPlaylist | undefined;
  let variantCount = 1;
  const visited = new Set<string>();
  for (let depth = 0; depth < 4; depth++) {
    if (visited.has(current)) throw new Error('HLS 播放列表循环跳转');
    visited.add(current);
    const { res, finalUrl } = await request(current);
    const body = await readQualityBody(res, MANIFEST_LIMIT, signal, true);
    playlist = parseQualityPlaylist(new TextDecoder().decode(body), finalUrl);
    if (!playlist.variants.length) break;
    if (depth === 0) variantCount = playlist.variants.length;
    current = playlist.variants[0].url;
    playlist = undefined;
  }
  const segment = playlist?.segment;
  if (!segment) throw new Error('HLS 播放列表中没有可检测的视频分片');
  const offset = segment.range?.offset ?? 0;
  const requestedBytes = Math.min(SEGMENT_LIMIT, segment.range?.length ?? SEGMENT_LIMIT);
  const { res } = await request(segment.url, `bytes=${offset}-${offset + requestedBytes - 1}`);
  const bytes = await readQualityBody(res, requestedBytes, signal);
  if (!bytes.byteLength) throw new Error('上游返回空视频分片');
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const prefix = new TextDecoder().decode(bytes.subarray(0, 80)).trimStart();
  let jsonErrorBody = false;
  if (bytes.byteLength <= 16 * 1024 && /^[{[]/.test(prefix)) {
    try { const value = JSON.parse(new TextDecoder().decode(bytes)); jsonErrorBody = !!value && typeof value === 'object'; } catch { /* binary prefixes can coincidentally begin with a brace */ }
  }
  const plainError = bytes.byteLength <= 1024 && /^(?:forbidden|access denied|unauthorized|not found|error[:\s])/i.test(prefix);
  if (/text\/html|application\/(?:json|xhtml|xml)/.test(contentType) || /^<(?:!doctype|html|\?xml)\b/i.test(prefix) || jsonErrorBody || plainError) {
    throw new Error('分片地址返回网页或接口错误，未读取到视频');
  }
  const base: VodQualityResult = {
    url, ok: true, variantCount, evidence: 'unknown',
    sampleHash: createHash('sha256').update(bytes.subarray(0, HASH_BYTES)).digest('hex'),
  };
  const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
  const [rangeStart, rangeEnd, total] = contentRange ? contentRange.slice(1).map(Number) : [NaN, NaN, NaN];
  const validRange = [rangeStart, rangeEnd, total].every(Number.isSafeInteger) &&
    rangeStart >= 0 && rangeEnd >= rangeStart && total > rangeEnd && bytes.byteLength <= rangeEnd - rangeStart + 1;
  if (validRange && rangeStart !== offset) return { ...base, error: '分片返回的字节范围与请求不符，画质未知' };
  if (!segment.range && validRange && rangeStart === offset && segment.duration) {
    const estimate = total * 8 / segment.duration / 1000;
    if (Number.isFinite(estimate) && estimate <= 1_000_000) base.mediaKbps = Math.round(estimate);
  }
  // A byte-range segment whose server ignored Range does not start at the requested fragment.
  if (offset && res.status !== 206) return { ...base, error: '分片服务器未按字节范围返回，画质未知' };
  let decoded = bytes;
  if (segment.key) {
    if (segment.key.method !== 'AES-128' || (segment.key.format && segment.key.format !== 'identity')) {
      return { ...base, error: '分片可访问，暂不支持此加密格式，画质未知' };
    }
    if (!segment.key.url) return { ...base, ok: false, error: 'AES-128 播放列表缺少密钥地址，无法验证播放' };
    try {
      const keyResponse = await request(segment.key.url);
      const key = await readQualityBody(keyResponse.res, 32, signal, true);
      decoded = decryptQualitySample(bytes, key, qualityIv(segment.sequence, segment.key.iv));
    } catch (error) {
      aborted(signal);
      return { ...base, ok: false, error: `密钥读取或解密失败，无法验证播放：${error instanceof Error ? error.message : '未知错误'}` };
    }
  }
  const dimensions = dimensionsFromQualitySample(decoded);
  if (!dimensions) return { ...base, error: '已读取视频样本，未识别支持的 H.264 码流头，画质未知' };
  return { ...base, ...dimensions, evidence: 'bitstream' };
}

/** One sample per URL, at most three network chains globally. Caller cancellation never enters cache. */
export async function probeVodQuality(url: string, callerSignal?: AbortSignal): Promise<VodQualityResult> {
  const start = performance.now();
  if (callerSignal?.aborted) return { url, ok: false, evidence: 'unknown', error: '检测已取消', ms: 0 };
  try { publicProtocolUrl(url, url); } catch { return { url, ok: false, evidence: 'unknown', error: '无效的 HLS 地址', ms: 0 }; }
  const stored = cache.get(url);
  if (stored && stored.until > Date.now()) return { ...stored.result };
  cache.delete(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('画质检测超时', 'TimeoutError')), BUDGET_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  let unlock: (() => void) | undefined;
  let result: VodQualityResult;
  try {
    unlock = await slot(signal);
    result = await inspect(url, signal);
  } catch (error) {
    const message = callerSignal?.aborted ? '检测已取消' : signal.aborted ? '画质检测超时' : error instanceof Error ? error.message : '画质检测失败';
    result = { url, ok: false, evidence: 'unknown', error: message };
  } finally {
    clearTimeout(timeout);
    unlock?.();
  }
  result.ms = Math.round(performance.now() - start);
  if (!callerSignal?.aborted) {
    if (cache.size >= MAX_CACHE) {
      for (const [key, entry] of cache) { if (entry.until <= Date.now()) cache.delete(key); }
      while (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
    }
    cache.set(url, { result: { ...result }, until: Date.now() + (result.ok ? 10 * 60_000 : 30_000) });
  }
  return result;
}
