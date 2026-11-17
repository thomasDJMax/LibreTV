import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchHotList, getHotListUpdatedAt, isHotListId } from '@/lib/douban-weekly';

export const runtime = 'nodejs';

/**
 * 影视热榜（经 60s API 免 key）：豆瓣五个周榜 + 韩剧口碑榜 + 百度热播剧。
 * 服务端转发 + 内存缓存；`force=1` 跳过新鲜缓存强制刷新（前端手动刷新按钮用）。
 * 响应带 updatedAt（该榜单数据的抓取时间），前端据此展示「更新于」。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const params = new URL(req.url).searchParams;
  const id = params.get('id') || '';
  if (!isHotListId(id)) {
    return NextResponse.json({ error: `未知榜单: ${id.slice(0, 30)}` }, { status: 400 });
  }

  try {
    const items = await fetchHotList(id, { force: params.get('force') === '1' });
    return NextResponse.json({ items, updatedAt: getHotListUpdatedAt(id) ?? Date.now() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '榜单获取失败' },
      { status: 502 }
    );
  }
}
