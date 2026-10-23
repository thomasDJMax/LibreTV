import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createHash } from 'node:crypto';
import {
  decryptQualitySample, dimensionsFromQualitySample, parseH264Sps, parseQualityPlaylist,
  probeVodQuality, qualityIv, readQualityBody,
} from './vod-quality';

// Baseline SPS test vector in mux.js/test/transmuxer.test.js: cropped 720 × 404,
// with emulation-prevention bytes and VUI. Keeping a real vector avoids only testing our fixture writer.
const REAL_SPS = new Uint8Array([
  0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xb4, 0x35, 0xf9, 0xe1, 0x00, 0x00,
  0x03, 0x00, 0x01, 0x00, 0x00, 0x03, 0x00, 0x3c, 0x0f, 0x16, 0x2e, 0x48,
]);

function spsFixture(chroma = 1, frameOnly = 1, crop = [0, 0, 0, 4], mbsWide = 120): Uint8Array {
  let bits = '';
  const uint = (value: number, count: number) => { bits += value.toString(2).padStart(count, '0'); };
  const ue = (value: number) => { const n = (value + 1).toString(2); bits += '0'.repeat(n.length - 1) + n; };
  uint(100, 8); uint(0, 8); uint(40, 8); ue(0);
  ue(chroma); if (chroma === 3) uint(0, 1);
  ue(0); ue(0); uint(0, 1); uint(0, 1);
  ue(0); ue(0); ue(0); ue(1); uint(0, 1);
  ue(mbsWide - 1); ue(frameOnly ? 67 : 33); uint(frameOnly, 1);
  if (!frameOnly) uint(0, 1);
  uint(1, 1); uint(1, 1);
  crop.forEach(ue); uint(0, 1); uint(1, 1);
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  return new Uint8Array([0x67, ...bits.match(/.{8}/g)!.map((part) => parseInt(part, 2))]);
}

function packet(payload: Uint8Array, start: boolean, cc: number, pid = 256): Uint8Array {
  const bytes = new Uint8Array(188).fill(0xff);
  bytes[0] = 0x47; bytes[1] = (start ? 0x40 : 0) | (pid >> 8); bytes[2] = pid & 255;
  bytes[3] = (payload.byteLength === 184 ? 0x10 : 0x30) | cc;
  if (payload.byteLength < 184) {
    bytes[4] = 183 - payload.byteLength;
    if (bytes[4]) bytes[5] = 0;
  }
  bytes.set(payload, 188 - payload.byteLength);
  return bytes;
}

function tsFixture(): Uint8Array<ArrayBuffer> {
  const elementary = new Uint8Array([0, 0, 0, 1, ...REAL_SPS, 0, 0, 1, 0x68, 0xaa]);
  // SPS straddles packets; the first packet includes an ordinary video PES header.
  const first = new Uint8Array(184).fill(0xff);
  first.set([0, 0, 1, 0xe0, 0, 0, 0x80, 0, 0]);
  first.set(elementary.subarray(0, 10), 174);
  return new Uint8Array([
    ...packet(first, true, 0), ...packet(elementary.subarray(10), false, 1),
    ...packet(new Uint8Array([0, 0]), false, 0, 8191),
  ]);
}

let caseId = 0;
const publicUrl = (path = 'master.m3u8') => `https://93.184.216.34/quality-${++caseId}/${path}`;

function upstream(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn((url: string | URL, init: RequestInit) => handler(String(url), init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('真实 H.264 尺寸', () => {
  it('reads a real cropped SPS and removes emulation-prevention bytes', () => {
    expect(parseH264Sps(REAL_SPS)).toEqual({ width: 720, height: 404, codec: 'H.264' });
  });

  it('uses 4:2:0 crop units rather than declaring the coded 1088 lines as 1080', () => {
    expect(parseH264Sps(spsFixture())).toMatchObject({ width: 1920, height: 1080 });
    expect(parseH264Sps(spsFixture(1, 1, [0, 1, 0, 0]))).toMatchObject({ width: 1918, height: 1088 });
  });

  it('accounts for 4:4:4 and interlaced crop units', () => {
    expect(parseH264Sps(spsFixture(3, 0, [0, 2, 0, 4]))).toMatchObject({ width: 1918, height: 1080 });
  });

  it('does not throw or invent dimensions for truncated or malicious Exp-Golomb values', () => {
    for (let end = 0; end < 8; end++) expect(parseH264Sps(REAL_SPS.subarray(0, end))).toBeUndefined();
    expect(parseH264Sps(new Uint8Array([0x67, 66, 0, 30, ...new Uint8Array(200)]))).toBeUndefined();
    expect(parseH264Sps(spsFixture(1, 1, [0, 0, 0, 0], 65535))).toBeUndefined();
    expect(parseH264Sps(spsFixture(1, 1, [0, 0, 0, 16384]))).toBeUndefined();
    const noReference = REAL_SPS.slice(); noReference[0] = 7;
    expect(parseH264Sps(noReference)).toBeUndefined();
  });

  it('removes TS packet/PES framing even when SPS crosses packet boundaries', () => {
    expect(dimensionsFromQualitySample(tsFixture())).toMatchObject({ width: 720, height: 404 });
  });

  it('does not splice a missing TS continuity sequence into a fake SPS', () => {
    const bytes = tsFixture(); bytes[191] = (bytes[191] & 0xf0) | 3;
    expect(dimensionsFromQualitySample(bytes)).toBeUndefined();
  });

  it('treats fMP4 and unsupported streams as unknown', () => {
    expect(dimensionsFromQualitySample(new Uint8Array(Buffer.from('000000186674797069736f36', 'hex')))).toBeUndefined();
    expect(dimensionsFromQualitySample(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});

describe('HLS 和 AES-128', () => {
  it('selects the largest declared variant only as a fetch hint', () => {
    const parsed = parseQualityPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720\nsmall.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=3840x2160\nbig.m3u8', 'https://example.com/a/master.m3u8');
    expect(parsed.variants.map((item) => item.url)).toEqual(['https://example.com/a/big.m3u8', 'https://example.com/a/small.m3u8']);
    expect(parsed.segment).toBeUndefined();
  });

  it('captures sequence and key of the first non-gap segment, not a later replacement key', () => {
    const parsed = parseQualityPlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:257\n#EXT-X-GAP\n#EXTINF:4,\nmissing.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x10\n#EXTINF:5.5,\nfirst.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:10,\nlast.ts', 'https://example.com/final/playlist.m3u8');
    expect(parsed.segment).toEqual({ url: 'https://example.com/final/first.ts', sequence: 258n, duration: 5.5, range: undefined, key: { method: 'AES-128', url: 'https://example.com/final/key.bin', iv: '0x10', format: undefined } });
    expect(Buffer.from(qualityIv(258n)).toString('hex')).toBe('00000000000000000000000000000102');
    expect(Buffer.from(qualityIv(258n, '0x10')).toString('hex')).toBe('00000000000000000000000000000010');
    expect(() => qualityIv(0n, '0x' + 'f'.repeat(33))).toThrow();
  });

  it('rejects invalid sequence/addresses and missing implicit byte-range offsets', () => {
    expect(() => parseQualityPlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:-1\na.ts', 'https://example.com/')).toThrow();
    expect(() => parseQualityPlaylist('#EXTM3U\nfile:///secret', 'https://example.com/')).toThrow();
    expect(() => parseQualityPlaylist('#EXTM3U\n#EXT-X-BYTERANGE:100\na.ts', 'https://example.com/')).toThrow();
  });

  it('decrypts a prefix without removing padding or requiring the end of the segment', () => {
    const plain = new Uint8Array(64).fill(23);
    const key = new Uint8Array(16).fill(9);
    const iv = qualityIv(72n);
    const cipher = createCipheriv('aes-128-cbc', key, iv); cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    expect(decryptQualitySample(encrypted.subarray(0, 35), key, iv)).toEqual(plain.subarray(0, 32));
    expect(() => decryptQualitySample(encrypted, new Uint8Array(32), iv)).toThrow(/密钥/);
  });
});

describe('网络边界和端到端抽样', () => {
  it('rejects private redirects even when LIVE_ALLOW_PRIVATE is set', async () => {
    vi.stubEnv('LIVE_ALLOW_PRIVATE', '1');
    const spy = upstream(() => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }));
    const result = await probeVodQuality(publicUrl());
    expect(result).toMatchObject({ ok: false, evidence: 'unknown' });
    expect(result.error).toContain('拒绝'); expect(spy).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it('inspects the chosen variant and reports actual SPS rather than a false 4K label', async () => {
    const sample = tsFixture();
    const spy = upstream((url) => {
      if (url.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160,BANDWIDTH=90000000\nhigh.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nlow.m3u8');
      if (url.endsWith('high.m3u8')) return new Response('#EXTM3U\n#EXTINF:4,\nfirst.ts\n#EXTINF:4,\nlast.ts');
      if (url.endsWith('first.ts')) return new Response(sample, { status: 206, headers: { 'content-range': `bytes 0-${sample.length - 1}/100000`, 'content-type': 'video/mp2t' } });
      throw new Error('不应读取较低档位或尾分片');
    });
    const url = publicUrl();
    const result = await probeVodQuality(url);
    expect(result).toMatchObject({ url, ok: true, width: 720, height: 404, codec: 'H.264', mediaKbps: 200, variantCount: 2, evidence: 'bitstream' });
    expect(result.sampleHash).toBe(createHash('sha256').update(sample).digest('hex'));
    expect(new Headers(spy.mock.calls[2][1].headers).get('Range')).toBe('bytes=0-262143');
    await probeVodQuality(url); expect(spy).toHaveBeenCalledTimes(3); // cached, no repeated media download
  });

  it('resolves relative segments against the final redirected playlist URL', async () => {
    const seen: string[] = [];
    upstream((url) => {
      seen.push(url);
      if (url.endsWith('master.m3u8')) return new Response(null, { status: 302, headers: { location: '/redirected/media.m3u8' } });
      if (url.endsWith('media.m3u8')) return new Response('#EXTM3U\n#EXTINF:4,\nfirst.ts');
      return new Response(tsFixture(), { status: 206 });
    });
    expect((await probeVodQuality(publicUrl())).width).toBe(720);
    expect(seen[2]).toBe('https://93.184.216.34/redirected/first.ts');
  });

  it('decrypts a real AES-128 sample with the playlist media sequence IV', async () => {
    const key = new Uint8Array(16).fill(5);
    const plain = new Uint8Array(576); plain.set(tsFixture());
    const cipher = createCipheriv('aes-128-cbc', key, qualityIv(513n)); cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    upstream((url) => {
      if (url.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:513\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:4,\nfirst.ts');
      if (url.endsWith('/key')) return new Response(key);
      return new Response(encrypted, { status: 206 });
    });
    const result = await probeVodQuality(publicUrl());
    expect(result).toMatchObject({ ok: true, width: 720, height: 404, evidence: 'bitstream' });
    expect(result.sampleHash).toBe(createHash('sha256').update(encrypted).digest('hex'));
  });

  it('keeps unsupported media accessible but unknown, with no manifest-derived dimensions or bitrate', async () => {
    upstream((url) => url.endsWith('master.m3u8') ? new Response('#EXTM3U\n#EXTINF:4,\nfirst.ts') : new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-length': '999999' } }));
    const result = await probeVodQuality(publicUrl());
    expect(result).toMatchObject({ ok: true, evidence: 'unknown' });
    expect(result.width).toBeUndefined(); expect(result.mediaKbps).toBeUndefined(); expect(result.error).toContain('未知');
  });

  it('ignores malformed or unsafe Content-Range values when estimating media bitrate', async () => {
    for (const range of ['bytes 0-900/100', 'bytes 0-563/9007199254740993', 'bytes 10-1/10000', 'bytes 0-10/10000']) {
      upstream((url) => url.endsWith('master.m3u8') ? new Response('#EXTM3U\n#EXTINF:4,\nfirst.ts') : new Response(tsFixture(), { status: 206, headers: { 'content-range': range } }));
      const result = await probeVodQuality(publicUrl());
      expect(result.width).toBe(720); expect(result.mediaKbps).toBeUndefined();
    }
  });

  it('refuses HTTP 200 HTML error pages masquerading as segments', async () => {
    upstream((url) => url.endsWith('master.m3u8') ? new Response('#EXTM3U\n#EXTINF:4,\nfirst.ts') : new Response('<!DOCTYPE html><title>Denied</title>', { headers: { 'content-type': 'text/html' } }));
    expect(await probeVodQuality(publicUrl())).toMatchObject({ ok: false, error: expect.stringContaining('未读取到视频') });
  });

  it('rejects JSON errors without a correct Content-Type and unreadable AES keys', async () => {
    upstream((url) => url.endsWith('master.m3u8') ? new Response('#EXTM3U\n#EXTINF:4,\nfirst.ts') : new Response('{"code":403,"message":"denied"}'));
    expect((await probeVodQuality(publicUrl())).ok).toBe(false);
    upstream((url) => {
      if (url.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:4,\nfirst.ts');
      if (url.endsWith('/key')) return new Response(new Uint8Array(17));
      return new Response(new Uint8Array(32), { status: 206 });
    });
    expect(await probeVodQuality(publicUrl())).toMatchObject({ ok: false, evidence: 'unknown', error: expect.stringContaining('密钥') });
    upstream((url) => url.endsWith('master.m3u8') ? new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:4,\nfirst.ts') : new Response(new Uint8Array(32), { status: 206 }));
    expect(await probeVodQuality(publicUrl())).toMatchObject({ ok: false, error: expect.stringContaining('缺少密钥地址') });
  });

  it('caps ignored Range responses and cancels without downloading the whole stream', async () => {
    const cancel = vi.fn(); let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { sent++; controller.enqueue(new Uint8Array(100000)); }, cancel });
    const result = await readQualityBody(new Response(stream), 256 * 1024, new AbortController().signal);
    expect(result.length).toBe(256 * 1024); expect(cancel).toHaveBeenCalled(); expect(sent).toBeLessThanOrEqual(4);
  });

  it('rejects oversized manifests/keys rather than silently truncating them', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel });
    await expect(readQualityBody(new Response(stream), 32, new AbortController().signal, true)).rejects.toThrow('大小限制');
    expect(cancel).toHaveBeenCalled();
    upstream(() => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    expect((await probeVodQuality(publicUrl())).error).toContain('大小限制');
  });

  it('accepts a long movie playlist above 256 KiB while still requesting only its first video sample', async () => {
    const longPlaylist = '#EXTM3U\n' + '#EXTINF:4,\nfirst.ts\n'.repeat(16000);
    expect(longPlaylist.length).toBeGreaterThan(256 * 1024);
    const spy = upstream((url) => url.endsWith('master.m3u8') ? new Response(longPlaylist) : new Response(tsFixture(), { status: 206 }));
    expect(await probeVodQuality(publicUrl())).toMatchObject({ ok: true, width: 720, height: 404, evidence: 'bitstream' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(new Headers(spy.mock.calls[1][1].headers).get('Range')).toBe('bytes=0-262143');
  });

  it('aborts a stalled body and never caches caller cancellation', async () => {
    const url = publicUrl(); let stalled = true;
    const spy = upstream((target) => {
      if (target.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXTINF:4,\nfirst.ts');
      return stalled ? new Response(new ReadableStream<Uint8Array>()) : new Response(tsFixture());
    });
    const controller = new AbortController();
    const pending = probeVodQuality(url, controller.signal);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: '检测已取消' });
    stalled = false;
    expect((await probeVodQuality(url)).width).toBe(720);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('finishes a completely stalled fetch within the single eight-second budget', async () => {
    vi.useFakeTimers(); upstream(() => new Promise<Response>(() => {}));
    const pending = probeVodQuality(publicUrl());
    await vi.advanceTimersByTimeAsync(8001);
    expect(await pending).toMatchObject({ ok: false, error: '画质检测超时' });
  });

  it('bounds concurrency to three and removes an aborted queued caller', async () => {
    const waits: (() => void)[] = [];
    const spy = upstream(() => new Promise<Response>((resolve) => waits.push(() => resolve(new Response('invalid playlist')))));
    const controller = new AbortController();
    const first = Array.from({ length: 3 }, () => probeVodQuality(publicUrl()));
    const fourth = probeVodQuality(publicUrl(), controller.signal);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    controller.abort(); expect(await fourth).toMatchObject({ error: '检测已取消' });
    waits.forEach((resolve) => resolve()); await Promise.all(first);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
