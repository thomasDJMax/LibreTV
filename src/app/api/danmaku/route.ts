import { NextResponse } from 'next/server';

import { guardRequest } from '@/lib/api-guard';
import { getCache, setCache } from '@/lib/fetch-utils';
import type { DanmakuComment, DanmakuResponse, DanmakuTarget } from '@/lib/danmaku';

export const runtime = 'nodejs';

/**
 * 弹幕代理：把「视频标题 + 集数」交给自建的 danmu_api（默认 http://127.0.0.1:9321）
 * 自动匹配到具体剧集，再取回弹幕并归一化成播放器格式。
 *
 * 设计要点：
 * - 自建 danmu_api 才有完整匹配能力（B 站/腾讯/爱奇艺等聚合），浏览器直连会被风控；
 * - 匹配一次约 1-4 秒、弹幕体量大，服务端缓存 10 分钟，换集/重进页面不重复请求上游；
 * - 未配置 DANMU_API_BASE 时返回 enabled:false —— 前端静默无弹幕，不影响播放。
 */

const MATCH_TIMEOUT_MS = 20_000;
const COMMENT_TIMEOUT_MS = 25_000;
/** 单集弹幕上限：danmu_api 已做等间隔采样，这里再兜底，避免超大弹幕集一次性灌进浏览器 */
const MAX_COMMENTS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const UNMATCHED_CACHE_TTL_MS = 5 * 60 * 1000;

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 中文/阿拉伯数字季号转整数（支持「三」「十二」「二」等） */
function parseSmallNumber(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '十') return 10;
  if (text.length === 2 && text.startsWith('十') && CN_DIGITS[text[1]] !== undefined) {
    return 10 + CN_DIGITS[text[1]];
  }
  if (text.length === 2 && text.endsWith('十') && CN_DIGITS[text[0]] !== undefined) {
    return CN_DIGITS[text[0]] * 10;
  }
  if (text.length === 3 && text[1] === '十' && CN_DIGITS[text[0]] !== undefined && CN_DIGITS[text[2]] !== undefined) {
    return CN_DIGITS[text[0]] * 10 + CN_DIGITS[text[2]];
  }
  return CN_DIGITS[text] ?? null;
}

/** 从标题里读季号：「第二季」「第 2 季」「Season 2」；读不出按第一季 */
function parseSeason(title: string): number {
  const cn = title.match(/第\s*([零一二三四五六七八九十\d]+)\s*季/);
  if (cn) {
    const n = parseSmallNumber(cn[1]);
    if (n && n > 0) return n;
  }
  const en = title.match(/season\s*(\d+)/i);
  if (en) return Math.max(1, Number(en[1]));
  return 1;
}

/** 从集标签读集数：「第3集」「03」「EP03」；读不出用当前下标 + 1 */
function parseEpisode(label: string, fallbackIndex: number): number {
  const cn = label.match(/第\s*([零一二三四五六七八九十\d]+)\s*[集话話期]/);
  if (cn) {
    const n = parseSmallNumber(cn[1]);
    if (n && n > 0) return n;
  }
  const en = label.match(/(?:ep|e)\s*(\d+)/i) || label.match(/(\d{1,4})/);
  if (en) {
    const n = Number(en[1]);
    if (n > 0) return n;
  }
  return Math.max(1, fallbackIndex + 1);
}

/** 弹幕 API 基地址（可含 token 路径，如 http://127.0.0.1:9321/87654321） */
function danmuBase(): string {
  return (process.env.DANMU_API_BASE || '').trim().replace(/\/+$/, '');
}

function buildFileName(title: string, isMovie: boolean, season: number, episode: number, year: string): string {
  if (isMovie) return [title, year].filter(Boolean).join(' ');
  return `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/** danmu_api 的 p 字段：4 段「时间,类型,颜色,平台」，类型沿用 B 站约定 1 滚动 / 4 底部 / 5 顶部 */
function normalizeComments(raw: unknown): DanmakuComment[] {
  if (!Array.isArray(raw)) return [];
  const comments: DanmakuComment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { p, m } = item as { p?: unknown; m?: unknown };
    const text = typeof m === 'string' ? m.trim() : '';
    if (!text || typeof p !== 'string') continue;
    const parts = p.split(',');
    const time = Number.parseFloat(parts[0]);
    if (!Number.isFinite(time) || time < 0) continue;
    const kind = Number.parseInt(parts[1], 10);
    const mode: 0 | 1 | 2 = kind === 4 ? 2 : kind === 5 ? 1 : 0;
    const colorInt = Number.parseInt(parts[2], 10);
    const color = Number.isInteger(colorInt) && colorInt >= 0 && colorInt <= 0xffffff
      ? `#${colorInt.toString(16).padStart(6, '0')}`
      : '#ffffff';
    comments.push({ text, time, mode, color });
    if (comments.length >= MAX_COMMENTS) break;
  }
  return comments;
}

interface MatchJson {
  isMatched?: boolean;
  matches?: Array<{ episodeId?: number; animeTitle?: string; episodeTitle?: string }>;
}

interface CommentJson {
  comments?: unknown;
  count?: number;
}

/** 命中的剧集：episodeId 即 danmu_api 的弹幕 ID */
interface MatchedEpisode {
  episodeId: number;
  animeTitle?: string;
  episodeTitle?: string;
}

/** 调 danmu_api 自动匹配，返回命中的剧集信息；未命中返回 null */
async function matchEpisode(base: string, fileName: string): Promise<MatchedEpisode | null> {
  const res = await fetch(`${base}/api/v2/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName }),
    signal: AbortSignal.timeout(MATCH_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`弹幕匹配 HTTP ${res.status}`);
  const data = (await res.json()) as MatchJson;
  const first = data.matches?.[0];
  if (!data.isMatched || !first?.episodeId) return null;
  return { episodeId: first.episodeId, animeTitle: first.animeTitle, episodeTitle: first.episodeTitle };
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const params = new URL(req.url).searchParams;
  const title = (params.get('title') || '').trim();
  if (!title) return NextResponse.json({ error: '缺少视频标题' }, { status: 400 });
  if (title.length > 200) return NextResponse.json({ error: '视频标题过长' }, { status: 400 });

  const base = danmuBase();
  const empty: DanmakuResponse = { enabled: false, matched: false, comments: [], reason: '未配置弹幕服务' };
  if (!base) return NextResponse.json(empty);

  const target: DanmakuTarget = {
    title,
    episodeLabel: params.get('label') || '',
    episodeIndex: Number.parseInt(params.get('index') || '0', 10) || 0,
    isMovie: params.get('movie') === '1',
    year: (params.get('year') || '').trim(),
  };

  const season = parseSeason(title);
  const episode = target.isMovie ? 0 : parseEpisode(target.episodeLabel || '', target.episodeIndex || 0);
  const fileName = buildFileName(title, Boolean(target.isMovie), season, episode, target.year || '');
  const cacheKey = `danmaku:${fileName}`;

  const cached = getCache<DanmakuResponse>(cacheKey);
  if (cached) return NextResponse.json(cached);

  const fallback = (reason: string): NextResponse => {
    const payload: DanmakuResponse = { enabled: true, matched: false, comments: [], reason };
    setCache(cacheKey, payload, UNMATCHED_CACHE_TTL_MS);
    return NextResponse.json(payload);
  };

  try {
    const match = await matchEpisode(base, fileName);
    if (!match?.episodeId) return fallback('未匹配到对应剧集');

    const res = await fetch(
      `${base}/api/v2/comment/${match.episodeId}?format=json&duration=true`,
      { signal: AbortSignal.timeout(COMMENT_TIMEOUT_MS), cache: 'no-store' }
    );
    if (!res.ok) return fallback(`弹幕拉取失败（HTTP ${res.status}）`);
    const data = (await res.json()) as CommentJson;
    const comments = normalizeComments(data.comments);
    if (comments.length === 0) return fallback('该集暂无弹幕');

    const payload: DanmakuResponse = {
      enabled: true,
      matched: true,
      comments,
      count: comments.length,
      animeTitle: match.animeTitle,
      episodeTitle: match.episodeTitle,
    };
    setCache(cacheKey, payload, CACHE_TTL_MS);
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : '弹幕服务请求失败';
    return fallback(`弹幕服务不可用：${message}`);
  }
}
