/**
 * 弹幕（客户端）：把当前播放目标交给服务端代理 /api/danmaku 匹配，并归一化为
 * artplayer-plugin-danmuku 需要的 { text, time, mode, color } 列表。
 *
 * 匹配与聚合成败由服务端决定：这里失败一律返回空数组（播放器只是没有弹幕，
 * 不能让弹幕服务故障影响正片播放）。
 */

export interface DanmakuTarget {
  /** 视频标题（详情接口 title，可能带「第二季」「(2024)」等噪声） */
  title: string;
  /** 当前集标签（如「第3集」），用于推断集数 */
  episodeLabel?: string;
  /** 当前集下标（从 0 开始），标签里读不出集数时的兜底 */
  episodeIndex?: number;
  /** 是否为「同一电影多版本」列表（此时按电影匹配，不带集数） */
  isMovie?: boolean;
  /** 年份：电影匹配时作为补充线索 */
  year?: string;
}

export interface DanmakuComment {
  text: string;
  /** 出现时间（秒） */
  time: number;
  /** 0 滚动 · 1 顶部 · 2 底部 */
  mode: 0 | 1 | 2;
  /** #RRGGBB */
  color: string;
}

export interface DanmakuResponse {
  /** 服务端是否启用了弹幕源（未配置 DANMU_API_BASE 时为 false） */
  enabled: boolean;
  matched: boolean;
  comments: DanmakuComment[];
  animeTitle?: string;
  episodeTitle?: string;
  count?: number;
  reason?: string;
}

/** 构造 /api/danmaku 查询串；标题为空时返回空串表示无需请求 */
export function danmakuQuery(target: DanmakuTarget | undefined): string {
  const title = (target?.title || '').trim();
  if (!title) return '';
  const params = new URLSearchParams({ title });
  const label = (target?.episodeLabel || '').trim();
  if (label) params.set('label', label);
  if (typeof target?.episodeIndex === 'number') params.set('index', String(target.episodeIndex));
  if (target?.isMovie) params.set('movie', '1');
  const year = (target?.year || '').trim();
  if (year) params.set('year', year);
  return params.toString();
}

/**
 * 拉取当前集弹幕。
 * 服务端未启用 / 匹配失败 / 网络错误都返回空数组，由插件按「本集无弹幕」处理。
 */
export async function fetchDanmaku(
  target: DanmakuTarget | undefined,
  signal?: AbortSignal
): Promise<DanmakuComment[]> {
  const query = danmakuQuery(target);
  if (!query) return [];
  try {
    const res = await fetch(`/api/danmaku?${query}`, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as DanmakuResponse;
    if (!data?.enabled || !data.matched || !Array.isArray(data.comments)) return [];
    return data.comments;
  } catch {
    return [];
  }
}
