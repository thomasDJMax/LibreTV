import type { SearchResultItem } from './types';

export interface AggregatedGroup {
  key: string;
  name: string;
  year?: string;
  typeName?: string;
  pic?: string;
  remarks?: string;
  items: SearchResultItem[];
}

// Ignore typography only. Keep season numbers, languages and edition suffixes.
function titleKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

/** The original CSI series is catalogued without its city prefix by these providers. */
export function resolveSearchQuery(value: string): string {
  return titleKey(value) === '拉斯维加斯犯罪现场调查' ? '犯罪现场调查' : value;
}

function seasonIdentity(value: string): { base: string; season: number } | undefined {
  const match = value.match(/^(.*?)(?:第([零〇一二两三四五六七八九十百\d]+)季|season(\d+)|s(\d{1,2}))$/u);
  if (!match) return undefined;
  const raw = match[2] || match[3] || match[4];
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let season = Number(raw);
  if (!Number.isFinite(season)) {
    let total = 0;
    let digit = 0;
    for (const char of raw) {
      if (char === '十' || char === '百') { total += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
      else digit = digits[char];
    }
    season = total + digit;
  }
  return { base: match[1], season };
}

function derivative(value: string): boolean {
  return /解说|预告|花絮|幕后|特辑/u.test(value);
}

function relevance(item: SearchResultItem, query: string): number {
  const title = titleKey(item.name);
  const extra = !derivative(query) && derivative(`${title} ${item.typeName ?? ''}`) ? 4 : 0;
  if (title === query) return extra;
  if (seasonIdentity(title)?.base === query) return 1 + extra;
  if (title.startsWith(query)) return 2 + extra;
  return 3 + extra;
}

/** Rank matching seasons ahead of loosely related shows; keep distinct editions visible. */
export function aggregateResults(list: SearchResultItem[], query = ''): AggregatedGroup[] {
  const normalizedQuery = titleKey(query);
  const ordered = normalizedQuery ? [...list].sort((a, b) => {
    const difference = relevance(a, normalizedQuery) - relevance(b, normalizedQuery);
    if (difference) return difference;
    const aSeason = seasonIdentity(titleKey(a.name));
    const bSeason = seasonIdentity(titleKey(b.name));
    if (aSeason && bSeason && aSeason.base === bSeason.base && aSeason.season !== bSeason.season) return aSeason.season - bSeason.season;
    return titleKey(a.name).localeCompare(titleKey(b.name), 'zh-Hans-CN', { numeric: true });
  }) : list;
  const byName = new Map<string, SearchResultItem[]>();
  const seen = new Set<string>();
  for (const item of ordered) {
    const normalized = titleKey(item.name || '');
    const id = `${item.sourceKey}:${item.vodId}`;
    if (!normalized || seen.has(id)) continue;
    seen.add(id);
    // A source occasionally gives a commentary the same plain title as the film.
    const kind = /解说/u.test(item.typeName ?? '') ? 'commentary' : /纪录|记录片/u.test(item.typeName ?? '') ? 'documentary' : 'main';
    const key = `${normalized}|${kind}`;
    const items = byName.get(key) ?? [];
    items.push(item);
    byName.set(key, items);
  }
  const groups: AggregatedGroup[] = [];
  const add = (key: string, year: string | undefined, items: SearchResultItem[]) => {
    groups.push({ key: `${key}|${year ?? ''}`, name: items[0].name, year,
      typeName: items.find((item) => item.typeName)?.typeName,
      pic: items.find((item) => item.pic)?.pic,
      remarks: items.find((item) => item.remarks)?.remarks, items });
  };
  for (const [key, items] of byName) {
    const years = [...new Set(items.map((item) => item.year).filter(Boolean))] as string[];
    if (years.length > 1) {
      for (const year of years) add(key, year, items.filter((item) => item.year === year));
      const unknown = items.filter((item) => !item.year);
      if (unknown.length) add(key, undefined, unknown);
    } else add(key, years[0], items);
  }
  return groups;
}
