const SERIES_TYPE = /电视剧|连续剧|剧集|短剧|国产剧|欧美剧|海外剧|港台剧|港剧|台剧|韩剧|日剧|泰剧|英剧|美剧|综艺|动漫连载|动漫剧集|国产动漫|日韩动漫|欧美动漫/u;
const MOVIE_TYPE = /电影|(?:剧情|动作|爱情|科幻|喜剧|恐怖|惊悚|战争|悬疑|犯罪|奇幻|冒险|灾难|纪录|记录|动画|动漫|伦理|音乐|歌舞|武侠|家庭|儿童|历史|传记|古装|运动|同性)片/u;

/** Explicit source categories only; a title or a quality label is not a movie category. */
export function isMovieType(typeName?: string): boolean {
  const type = typeName?.normalize('NFKC').replace(/\s/gu, '') ?? '';
  return !!type && !SERIES_TYPE.test(type) && MOVIE_TYPE.test(type);
}

function isEpisodeLabel(label: string): boolean {
  return /第\s*[\d零〇一二两三四五六七八九十百千]+(?:\s*[-~至/、&+]\s*[\d零〇一二两三四五六七八九十百千]+)?\s*(?:集|话|期|回)|(?:^|\W)(?:ep|episode)\s*\d|s\d+\s*e\d+|^\d+(?:\s*[-~至]\s*\d+)?(?:集|话|期|回)?$/iu.test(label);
}

// A closed vocabulary prevents titles such as “正片上/正片下” or “HD中字1”
// from being mistaken for complete alternative editions of the same movie.
const VERSION_LABEL = /^(?:(?:2160p?|1440p?|1080p?|720p?|480p?|1280|1024|4k|8k|uhd|fhd|hdr10?|sdr|bd|hd|sd|dvd|webdl|webrip|bluray|bdrip|dvdrip)|(?:蓝光|高清|超清|标清|原画|正片|完整版|导演剪辑|加长|修复|重制|原声|原音|配音|国英双语|国粤双语|双语|普通话|国语|粤语|英语|英文|日语|日文|韩语|法语|德语|俄语|西班牙语|中文|中文字幕|中字|中英双字|中英字幕|双字|双字幕|简体|繁体|简中|繁中|字幕|无字|内嵌|内封|外挂|版))+$/iu;

/**
 * Movie editions are manually selectable alternatives, never automatic next episodes.
 * Missing movie labels are conservative: do not replay an unlabelled second edition.
 * Explicit numbered episodes override even a mistaken movie category from the source.
 */
export function isMovieVersionList(typeName?: string, episodeLabels?: readonly string[]): boolean {
  if (!isMovieType(typeName)) return false;
  const labels = (episodeLabels ?? []).map((label) => label.normalize('NFKC').trim());
  if (labels.some(isEpisodeLabel)) return false;
  // A single movie entry may repeat the title, e.g. 360's 盗梦空间(原声版).
  // Its label cannot create an accidental next-edition transition.
  if (labels.length <= 1) return true;
  return labels.every((label) => !label || VERSION_LABEL.test(label.replace(/[\s\p{P}\p{S}]/gu, '')));
}

/** Preserve the source label, including merged episodes such as 第01-02集. */
export function playbackEntryLabel(
  episodeLabels: readonly string[] | undefined,
  index: number,
  movieVersions = false,
): string {
  return episodeLabels?.[index]?.trim() || (movieVersions ? `版本 ${index + 1}` : `第 ${index + 1} 集`);
}
