import type { SearchResultItem } from './types';

export interface CurrentVideoIdentity {
  title: string;
  year?: string;
  typeName?: string;
}

/** Normalization preserves words, episode/season numbers and Chinese numerals. */
export function normalizeVideoTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
}

// Only presentation/version suffixes are removable. In particular, sequel names,
// seasons, 电影版, 剧场版 and arbitrary extra words must remain part of the title.
const VERSION_SUFFIX = /(?:2160p?|1440p?|1080p?|720p?|480p?|[48]k|uhd|fhd|hd|sd|hdr10?|webdl|webrip|bluray|bdrip|bd|原声版|国语版|粤语版|英语版|英文版|中文版|日语版|韩语版|普通话版|配音版|国配版|英配版|中配版|国语中字|粤语中字|英语中字|日语中字|韩语中字|中英双字|中英字幕|国粤双语|双语中字|中文字幕|简体中字|繁体中字|国语|粤语|英语|日语|韩语|普通话|中字|字幕|高清|超清|蓝光|杜比视界|修复版)$/u;

function withoutVersionSuffix(title: string): string {
  let result = title;
  while (VERSION_SUFFIX.test(result)) {
    const next = result.replace(VERSION_SUFFIX, '');
    if (!next) break;
    result = next;
  }
  return result;
}

function isOnlyVersionSuffix(value: string): boolean {
  // Accept common version wrappers/separators, not arbitrary trailing title
  // punctuation (for example the question mark in "Who? HD").
  if (/[^\p{L}\p{N}\s()[\]{}【】（）.·:：/_\-]/u.test(value)) return false;
  let rest = normalizeVideoTitle(value);
  if (!rest) return false;
  while (rest) {
    const next = rest.replace(VERSION_SUFFIX, '');
    if (next === rest) return false;
    rest = next;
  }
  return true;
}

function hasBalancedTitleDelimiters(value: string): boolean {
  const closing: Record<string, string> = { '(': ')', '（': '）', '[': ']', '【': '】', '{': '}', '《': '》', '〈': '〉' };
  const stack: string[] = [];
  for (const character of value) {
    if (closing[character]) stack.push(closing[character]);
    else if (Object.values(closing).includes(character) && stack.pop() !== character) return false;
  }
  return stack.length === 0;
}

/**
 * Removes explicit trailing edition labels while preserving the source's title
 * spelling, internal punctuation/spaces, and complete season/movie identity.
 * Search APIs can treat "蝙蝠侠：黑暗骑士" differently from its normalized key.
 */
export function sourceSearchTitle(title: string): string {
  const original = title.trim();
  let end = 0;
  for (const character of original) {
    end += character.length;
    const prefix = original.slice(0, end).trimEnd();
    if (prefix && isOnlyVersionSuffix(original.slice(end)) && hasBalancedTitleDelimiters(prefix)) return prefix;
  }
  return original;
}

function knownYear(value?: string): string | undefined {
  return value?.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/)?.[1];
}

function contentKind(typeName?: string): string | undefined {
  const type = normalizeVideoTitle(typeName ?? '');
  if (/纪录|记录片/u.test(type)) return 'documentary';
  if (/解说/u.test(type)) return 'commentary';
  if (/动漫|动画/u.test(type)) return 'animation';
  if (/综艺/u.test(type)) return 'variety';
  if (/电视剧|连续剧|国产剧|欧美剧|韩剧|日剧|台剧|港剧|泰剧|海外剧|短剧/u.test(type)) return 'series';
  if (/电影|剧情片|动作片|科幻片|爱情片|恐怖片|喜剧片|战争片|悬疑片|犯罪片/u.test(type)) return 'movie';
  return undefined;
}

function derivativeKinds(title: string, typeName?: string): string[] {
  const text = `${normalizeVideoTitle(title)} ${normalizeVideoTitle(typeName ?? '')}`;
  return [
    ['commentary', /解说/u],
    ['trailer', /预告/u],
    ['extras', /花絮/u],
    ['behind-scenes', /幕后/u],
    ['documentary', /纪录|记录片/u],
  ].filter(([, pattern]) => (pattern as RegExp).test(text)).map(([kind]) => kind as string);
}

/**
 * Retains a bounded selection of same-title editions so a separate language
 * edition with better video quality can be inspected rather than discarded.
 * Search order never overrides a different year, season, or derivative title.
 * Unknown metadata is allowed, except for the narrow series/variety mislabel case.
 */
export function selectSourceMatches(
  current: CurrentVideoIdentity,
  hits: readonly SearchResultItem[],
  limit = 3,
): SearchResultItem[] {
  const title = normalizeVideoTitle(current.title);
  if (!title || !Number.isFinite(limit) || limit < 1) return [];
  const baseTitle = withoutVersionSuffix(title);
  const year = knownYear(current.year);
  const kind = contentKind(current.typeName);
  const derivatives = derivativeKinds(current.title, current.typeName);
  const candidates = hits.flatMap((hit, index) => {
    const hitTitle = normalizeVideoTitle(hit.name ?? '');
    const exact = hitTitle === title;
    if (!exact && withoutVersionSuffix(hitTitle) !== baseTitle) return [];
    const hitYear = knownYear(hit.year);
    if (year && hitYear && year !== hitYear) return [];
    const hitKind = contentKind(hit.typeName);
    if (kind && hitKind && kind !== hitKind) {
      // Some CMS catalogs misclassify an entire series as variety. Relax this
      // only for exact same-season names with the same explicit release year.
      const seriesVariety = (kind === 'series' && hitKind === 'variety') || (kind === 'variety' && hitKind === 'series');
      const explicitSeason = /(?:第[零〇一二两三四五六七八九十百\d]+季|season\d+|s\d{1,2}(?!\d))/u.test(title);
      if (!(seriesVariety && exact && explicitSeason && !!year && year === hitYear)) return [];
    }
    if (derivativeKinds(hit.name, hit.typeName).some((value) => !derivatives.includes(value))) return [];
    return [{ hit, exact, sameYear: !!year && year === hitYear, sameKind: !!kind && kind === hitKind, index }];
  });
  candidates.sort((a, b) => Number(b.exact) - Number(a.exact)
    || Number(b.sameYear) - Number(a.sameYear)
    || Number(b.sameKind) - Number(a.sameKind)
    || a.index - b.index);
  const seen = new Set<string>();
  return candidates.flatMap(({ hit }) => {
    const key = `${hit.sourceKey}\0${hit.vodId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [hit];
  }).slice(0, Math.floor(limit));
}

/** Compatibility wrapper for a single result and detail identity validation. */
export function selectSourceMatch(
  current: CurrentVideoIdentity,
  hits: readonly SearchResultItem[],
): SearchResultItem | undefined {
  return selectSourceMatches(current, hits, 1)[0];
}

function chineseInteger(value: string): number | undefined {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  if (!/[十百千]/u.test(value)) {
    const number = [...value].map((character) => digits[character]).join('');
    return number ? Number(number) : undefined;
  }
  let result = 0;
  let digit = 0;
  for (const character of value) {
    if (character in digits) digit = digits[character];
    else if (character in units) {
      result += (digit || 1) * units[character];
      digit = 0;
    } else return undefined;
  }
  return result + digit;
}

function episodeKey(value: string): string | undefined {
  const raw = value.normalize('NFKC').toLowerCase().replace(/\s/gu, '');
  // Keep fractional/range episode identities: "1.5" and "1-2" must never
  // collapse to episode 15 or 12 when punctuation is normalized away.
  if (/\d[^\p{L}\p{N}]+\d/u.test(raw)) return `label:${raw}`;
  const label = withoutVersionSuffix(normalizeVideoTitle(value));
  if (!label) return undefined;
  const match = label.match(/^(?:第|ep|episode)?(\d+|[零〇一二两三四五六七八九十百千]+)(?:集|话|回|期)?(上|中|下)?$/u);
  if (!match) return `label:${label}`;
  const number = /^\d+$/.test(match[1]) ? Number(match[1]) : chineseInteger(match[1]);
  if (number === undefined || !Number.isSafeInteger(number)) return undefined;
  return `episode:${number}:${match[2] ?? ''}`;
}

export type EpisodeTarget =
  | { ok: true; index: number; matchedBy: 'label' | 'position' | 'movie' }
  | { ok: false; reason: string };

/** Resolve an episode without silently resetting a missing episode to index 0. */
export function resolveEpisodeTarget({
  currentIndex,
  currentLabel,
  targetEpisodeCount,
  targetLabels,
  movieVersions = false,
}: {
  currentIndex: number;
  currentLabel?: string;
  currentEpisodeCount?: number;
  targetEpisodeCount: number;
  targetLabels?: readonly string[];
  /** Caller has verified the same movie identity and that entries are editions, not episodes. */
  movieVersions?: boolean;
}): EpisodeTarget {
  if (!Number.isInteger(currentIndex) || currentIndex < 0) return { ok: false, reason: '当前集数无效' };
  if (!Number.isInteger(targetEpisodeCount) || targetEpisodeCount < 1) return { ok: false, reason: '该源无可用播放资源' };
  if (movieVersions) {
    const labels = targetLabels?.slice(0, targetEpisodeCount) ?? [];
    const currentVersion = normalizeVideoTitle(currentLabel ?? '');
    const sameLabel = currentVersion ? labels.findIndex((label) => normalizeVideoTitle(label) === currentVersion) : -1;
    if (sameLabel >= 0) return { ok: true, index: sameLabel, matchedBy: 'label' };
    const choices = labels.map((label, index) => ({ label: normalizeVideoTitle(label), index }))
      .filter(({ label }) => !/国语|粤语|普通话|配音|国配|中配|粤配|国粤|国英/u.test(label));
    for (const preference of [/原声/u, /英语|英文/u, /中字|字幕/u]) {
      const preferred = choices.find(({ label }) => preference.test(label));
      if (preferred) return { ok: true, index: preferred.index, matchedBy: 'movie' };
    }
    return { ok: true, index: 0, matchedBy: 'movie' };
  }
  // A series source may retain only its latest episode. A one-entry list is
  // therefore not evidence of a movie; explicit episode labels still take priority.
  const currentKey = currentLabel ? episodeKey(currentLabel) : undefined;
  const hasTargetLabels = targetLabels?.some((label, index) => index < targetEpisodeCount && !!label.trim());
  if (currentKey && hasTargetLabels) {
    const matches = targetLabels!.flatMap((label, index) => index < targetEpisodeCount && episodeKey(label) === currentKey ? [index] : []);
    if (matches.length === 1) return { ok: true, index: matches[0], matchedBy: 'label' };
    return { ok: false, reason: matches.length > 1 ? '该源集数标签重复，无法确认对应集数' : `该源没有对应的${currentLabel}` };
  }
  if (currentIndex >= targetEpisodeCount) return { ok: false, reason: `该源没有第 ${currentIndex + 1} 集` };
  return { ok: true, index: currentIndex, matchedBy: 'position' };
}

export interface SourceQualityEvidence {
  /** A completed media-chain probe, not just a successful search/detail API. */
  available?: boolean;
  /** Actual decoded/bitstream dimensions. Do not populate from title or manifest labels. */
  width?: number;
  height?: number;
  /** Estimated encoded media bitrate, not network download throughput. */
  mediaKbps?: number;
  interfaceMs?: number;
  isCurrent?: boolean;
}

function positiveNumber(value?: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Measured results sort ahead of unknowns; unknowns never acquire a guessed 4K grade. */
export function rankSourceCandidates<T extends SourceQualityEvidence>(
  candidates: readonly T[],
  { pinCurrent = false }: { pinCurrent?: boolean } = {},
): T[] {
  const availability = (value?: boolean) => value === true ? 2 : value === false ? 0 : 1;
  const pixels = (item: T) => {
    const width = positiveNumber(item.width);
    const height = positiveNumber(item.height);
    return width && height ? positiveNumber(width * height) ?? 0 : 0;
  };
  return [...candidates].sort((a, b) => {
    if (pinCurrent && !!a.isCurrent !== !!b.isCurrent) return a.isCurrent ? -1 : 1;
    const latencyA = positiveNumber(a.interfaceMs);
    const latencyB = positiveNumber(b.interfaceMs);
    return availability(b.available) - availability(a.available)
      || pixels(b) - pixels(a)
      || (positiveNumber(b.mediaKbps) ?? 0) - (positiveNumber(a.mediaKbps) ?? 0)
      || (latencyA === undefined && latencyB === undefined ? 0 : (latencyA ?? Infinity) - (latencyB ?? Infinity));
  });
}

/**
 * Groups matching measured samples while retaining every configured source.
 * A matching sample is evidence about that sample, not proof entire videos match.
 * Missing hashes remain independent; CDN host names alone are not deduplication.
 */
export function groupIdenticalSamples<T extends { sampleHash?: string }>(items: readonly T[]): T[][] {
  const groups: T[][] = [];
  const measured = new Map<string, T[]>();
  for (const item of items) {
    const hash = item.sampleHash?.trim().toLowerCase();
    if (!hash) {
      groups.push([item]);
      continue;
    }
    const group = measured.get(hash);
    if (group) group.push(item);
    else {
      const next = [item];
      measured.set(hash, next);
      groups.push(next);
    }
  }
  return groups;
}
