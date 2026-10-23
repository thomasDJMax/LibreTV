import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { probeVodQuality, readQualityBody } from '@/lib/vod-quality';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Authenticated sample inspection. It does not proxy whole movies or trust manifest quality labels. */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let url = '';
  // Small JSON requests get a separate short body deadline; the upstream probe has its own 8 s budget.
  const bodyController = new AbortController();
  const bodyTimer = setTimeout(() => bodyController.abort(new DOMException('请求读取超时', 'TimeoutError')), 2000);
  const bodySignal = AbortSignal.any([req.signal, bodyController.signal]);
  try {
    const bodyBytes = await readQualityBody(req, 16 * 1024, bodySignal, true);
    const body = JSON.parse(new TextDecoder().decode(bodyBytes)) as { url?: unknown };
    if (typeof body.url !== 'string') throw new Error('无效地址');
    url = body.url.trim();
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 8192) throw new Error('无效地址');
  } catch {
    if (bodySignal.aborted) return NextResponse.json({ url, ok: false, evidence: 'unknown', error: '请求读取超时或已取消' }, { status: 408 });
    return NextResponse.json({ url, ok: false, evidence: 'unknown', error: '请求格式或 HLS 地址无效' }, { status: 400 });
  } finally {
    clearTimeout(bodyTimer);
  }
  return NextResponse.json(await probeVodQuality(url, req.signal));
}
