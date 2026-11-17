import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { guardRequest } from '@/lib/api-guard';
import { getCache, setCache } from '@/lib/fetch-utils';
import { detectIntro, type IntroConfidence } from '@/lib/intro-detect';

export const runtime = 'nodejs';

/** 识别到片头缓存 24 小时；没识别到缓存 6 小时（源更新后还有机会识别出来）。 */
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

interface StoredDetection {
  skipTo: number;
  confidence: IntroConfidence;
  evidence: string;
  scanned: number;
  detectedAt: number;
}

const inflight = new Map<string, Promise<StoredDetection>>();
/** ffmpeg 下载+分析很吃带宽，串行执行，避免同一部剧多集同时探测拖慢播放。 */
let queue: Promise<unknown> = Promise.resolve();

function cacheKeyFor(seriesKey: string, title: string): string {
  const digest = createHash('sha1').update(`${seriesKey}|${title}`).digest('hex').slice(0, 16);
  return `intro:${digest}`;
}

export async function GET(req: NextRequest) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const params = req.nextUrl.searchParams;
  const title = (params.get('title') ?? '').trim();
  const seriesKey = (params.get('key') ?? '').trim();
  const url = (params.get('url') ?? '').trim();
  if (!title && !seriesKey) {
    return NextResponse.json({ ok: false, reason: '缺少剧集信息' }, { status: 400 });
  }
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, reason: '视频地址无效' }, { status: 400 });
  }

  const cacheKey = cacheKeyFor(seriesKey, title);
  const cached = getCache<StoredDetection>(cacheKey);
  if (cached) {
    return NextResponse.json({ ok: true, ...cached, cached: true });
  }

  let task = inflight.get(cacheKey);
  if (!task) {
    // 部分 CDN 校验 Referer/Origin：带上播放页同源地址。
    const origin = req.headers.get('origin');
    const host = req.headers.get('host');
    const referer = origin ?? (host ? `http://${host}` : undefined);
    const run = queue.then(async (): Promise<StoredDetection> => {
      const detection = await detectIntro(url, { referer });
      const stored: StoredDetection = {
        skipTo: detection.skipTo,
        confidence: detection.confidence,
        evidence: detection.evidence,
        scanned: detection.scanned,
        detectedAt: Date.now(),
      };
      setCache(cacheKey, stored, detection.skipTo > 0 ? HIT_TTL_MS : MISS_TTL_MS);
      return stored;
    });
    // 识别失败不能把 inflight 卡住：finally 里删除，后续请求可重试。
    task = run.finally(() => { inflight.delete(cacheKey); });
    inflight.set(cacheKey, task);
    queue = run.catch(() => undefined);
  }

  try {
    const stored = await task;
    return NextResponse.json({ ok: true, ...stored, cached: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '片头识别失败';
    return NextResponse.json({ ok: false, reason }, { status: 502 });
  }
}
