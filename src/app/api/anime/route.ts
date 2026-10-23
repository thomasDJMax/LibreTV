import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { AnimeQueryError, fetchAnimeCatalog, parseAnimeQuery } from '@/lib/anime-catalog';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  try {
    const query = parseAnimeQuery(new URL(req.url).searchParams);
    return NextResponse.json(await fetchAnimeCatalog(query));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '动漫目录获取失败' },
      { status: err instanceof AnimeQueryError ? 400 : 502 },
    );
  }
}
