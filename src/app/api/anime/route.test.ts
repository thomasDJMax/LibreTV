import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchAnimeCatalog } from '@/lib/anime-catalog';

vi.mock('@/lib/api-guard', () => ({ guardRequest: vi.fn() }));
vi.mock('@/lib/anime-catalog', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/anime-catalog')>()), fetchAnimeCatalog: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(guardRequest).mockReturnValue(null); });

describe('GET /api/anime', () => {
  it('沿用访问验证，未授权请求不访问上游', async () => {
    vi.mocked(guardRequest).mockReturnValue(new NextResponse('Unauthorized', { status: 401 }));
    const response = await GET(new Request('http://localhost/api/anime'));
    expect(response.status).toBe(401);
    expect(fetchAnimeCatalog).not.toHaveBeenCalled();
  });
  it('正常查询返回目录和真实分页信息', async () => {
    const result = { items: [], query: { category: 'japan' as const, sort: 'heat' as const, year: 1999, keyword: '', page: 2 }, page: 2, pageSize: 20, total: 96, totalCapped: false, hasMore: true, maxPages: 5, source: 'Bangumi' as const };
    vi.mocked(fetchAnimeCatalog).mockResolvedValue(result);
    const response = await GET(new Request('http://localhost/api/anime?category=japan&year=1999&page=2'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(fetchAnimeCatalog).toHaveBeenCalledWith(result.query);
  });
  it('非法参数400，上游错误502，均不返回伪榜单', async () => {
    expect((await GET(new Request('http://localhost/api/anime?sort=date'))).status).toBe(400);
    expect(fetchAnimeCatalog).not.toHaveBeenCalled();
    vi.mocked(fetchAnimeCatalog).mockRejectedValue(new Error('动漫目录暂时不可用 (503)'));
    const response = await GET(new Request('http://localhost/api/anime'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: '动漫目录暂时不可用 (503)' });
  });
});
