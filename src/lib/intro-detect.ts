/**
 * 片头识别（服务端）：取视频开头若干秒，用 ffmpeg 分析黑场、音频静默与镜头切换，
 * 推断「正片开始」的时间点，供播放器自动跳过片头。
 *
 * 设计原则：宁可不跳，也不误切正片。
 * - 只有在「片头段切换频繁 + 正片段画面平稳 + 黑场/静默转场」同时成立时才给出结果；
 * - 证据不足返回 skipTo=0（前端保持从头播放）；
 * - 分析结果由 API 层按「剧集 + 源」缓存，同一部剧只在第一次播放时分析一次。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface BlackRange {
  start: number;
  end: number;
}

export interface SilenceRange {
  start: number;
  end: number;
}

export interface IntroTimeline {
  blackRanges: BlackRange[];
  cutTimes: number[];
  silences: SilenceRange[];
}

export type IntroConfidence = 'none' | 'medium' | 'high';

export interface IntroDetection {
  /** 0 表示没有识别到明确片头，播放器应从头播放 */
  skipTo: number;
  confidence: IntroConfidence;
  /** 人类可读的判定依据，便于在日志/界面上解释 */
  evidence: string;
  /** 实际分析的前 N 秒 */
  scanned: number;
}

/** 默认只分析开头 2 分 45 秒：足够覆盖常见片头 + 片头前回顾，又不至于下载过多分片。 */
export const INTRO_SAMPLE_SECONDS = 165;
/** 片头结束点不会晚于这个秒数（同时要求后面至少留 18 秒正片用于判断稳定度）。 */
export const INTRO_MAX_BOUNDARY_SECONDS = 150;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** 片头结束点不会早于这个秒数：更早的黑场通常是片头开始或平台水印。 */
export const INTRO_MIN_BOUNDARY_SECONDS = 15;
/** 黑场至少持续这么久，才视为「片头 → 正片」的转场（短暂闪黑不算）。 */
export const INTRO_BLACK_MIN_DURATION = 0.4;
/** 「片头」观察窗：候选点前 24 秒应为切换频繁的片头/回顾段 */
const BEFORE_WINDOW_SECONDS = 24;
/** 「正片」观察窗：候选点后 18 秒用来观察切换节奏 */
const AFTER_WINDOW_SECONDS = 18;

export const INTRO_SCORE_PREFIX = {
  blackTransition: 2,
  cutBeforeMany: 2,
  cutBeforeSome: 1,
  cutAfterQuiet: 2,
  cutAfterSome: 1,
  silence: 1,
} as const;

/** 评分达到该值才视为「有片头」；6 分以上视为高置信。 */
const MEDIUM_SCORE = 4;
const HIGH_SCORE = 6;

/** 解析 ffmpeg blackdetect 日志中的黑场区间（秒）。 */
export function parseBlackRanges(log: string): BlackRange[] {
  const ranges: BlackRange[] = [];
  const pattern = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(log)) !== null) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

/** 解析 metadata=print 输出里的镜头切换时间点（秒）。 */
export function parseCutTimes(metadata: string): number[] {
  const times = new Set<number>();
  const pattern = /pts_time:\s*([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(metadata)) !== null) {
    const time = Number(match[1]);
    if (Number.isFinite(time) && time >= 0) times.add(time);
  }
  return [...times].sort((a, b) => a - b);
}

/** 解析 silencedetect 日志中的静默区间（秒）。 */
export function parseSilenceRanges(log: string): SilenceRange[] {
  const starts = [...log.matchAll(/silence_start:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...log.matchAll(/silence_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const ranges: SilenceRange[] = [];
  let endIndex = 0;
  for (const start of starts) {
    while (endIndex < ends.length && ends[endIndex] <= start) endIndex += 1;
    const end = ends[endIndex];
    if (!Number.isFinite(start) || start < 0) continue;
    if (Number.isFinite(end) && end > start) {
      ranges.push({ start, end });
      endIndex += 1;
    }
  }
  return ranges;
}

interface Candidate {
  time: number;
  score: number;
  evidence: string[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 纯函数：根据时间线判断片头结束点。
 * 主信号是「片头段结束处的黑场转场」——电视剧/电影片头结束通常是淡出到黑再进入正片；
 * 黑场证据不足时退回「音频静默」与「镜头节奏骤停」两种信号。
 * 只在证据充分时返回 skipTo > 0；否则返回 0（宁可不跳）。
 */
export function analyzeIntroTimeline(
  timeline: IntroTimeline,
  options: { scanSeconds: number; maxIntroSeconds?: number },
): IntroDetection {
  const scanSeconds = Math.max(1, options.scanSeconds);
  const maxIntro = Math.min(
    options.maxIntroSeconds ?? INTRO_MAX_BOUNDARY_SECONDS,
    scanSeconds - AFTER_WINDOW_SECONDS,
  );
  const minIntro = Math.min(INTRO_MIN_BOUNDARY_SECONDS, maxIntro);
  const cuts = timeline.cutTimes
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= scanSeconds)
    .sort((a, b) => a - b);
  const blacks = timeline.blackRanges
    .filter((range) => Number.isFinite(range.start) && range.start >= 0 && range.start <= scanSeconds)
    .map((range) => ({ start: range.start, end: Math.min(range.end, scanSeconds) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const silences = timeline.silences
    .filter((range) => Number.isFinite(range.start) && range.start >= 0 && range.start <= scanSeconds)
    .sort((a, b) => a.start - b.start);

  if (maxIntro <= minIntro || cuts.length === 0) {
    return { skipTo: 0, confidence: 'none', evidence: '开头没有可分析的镜头切换', scanned: scanSeconds };
  }

  const cutsBetween = (from: number, to: number): number => {
    let count = 0;
    for (const time of cuts) {
      if (time >= from && time < to) count += 1;
    }
    return count;
  };
  const nearBlack = (time: number, tolerance = 1.2): boolean =>
    blacks.some((range) => Math.abs(range.start - time) <= tolerance || Math.abs(range.end - time) <= tolerance);
  const nearSilence = (time: number, tolerance = 1.5): boolean =>
    silences.some((range) => Math.abs(range.start - time) <= tolerance || Math.abs(range.end - time) <= tolerance);

  /** 给候选边界打分：黑场/静默证据 + 之前片头段的切换密度 + 之后正片段的切换节奏。 */
  const scoreBoundary = (time: number, extra: { black: boolean; silence: boolean }): Candidate | null => {
    const before = cutsBetween(time - BEFORE_WINDOW_SECONDS, time);
    const after = cutsBetween(time, time + AFTER_WINDOW_SECONDS);
    const evidence: string[] = [];
    let score = 0;
    if (extra.black) {
      score += INTRO_SCORE_PREFIX.blackTransition;
      evidence.push('黑场转场');
    }
    if (before >= 5) {
      score += INTRO_SCORE_PREFIX.cutBeforeMany;
      evidence.push(`片头段切换频繁（${before} 次/${BEFORE_WINDOW_SECONDS}s）`);
    } else if (before >= 3) {
      score += INTRO_SCORE_PREFIX.cutBeforeSome;
      evidence.push(`片头段有切换（${before} 次/${BEFORE_WINDOW_SECONDS}s）`);
    }
    if (after <= 2) {
      score += INTRO_SCORE_PREFIX.cutAfterQuiet;
      evidence.push(`正片段开头平稳（${after} 次/${AFTER_WINDOW_SECONDS}s）`);
    } else if (after <= 4) {
      score += INTRO_SCORE_PREFIX.cutAfterSome;
      evidence.push(`正片段开头切换较少（${after} 次/${AFTER_WINDOW_SECONDS}s）`);
    }
    if (extra.silence) {
      score += INTRO_SCORE_PREFIX.silence;
      evidence.push('音频静默');
    }
    return score > 0 ? { time: round1(time), score, evidence } : null;
  };

  // 1) 黑场转场（主信号）：持续 >=0.4s、落在片头可能区间、且之前片头段有足够切换。
  const blackCandidates: Candidate[] = [];
  for (const range of blacks) {
    if (range.end - range.start < INTRO_BLACK_MIN_DURATION) continue;
    for (const boundary of [range.start, range.end]) {
      if (boundary < minIntro || boundary > maxIntro) continue;
      if (cutsBetween(boundary - BEFORE_WINDOW_SECONDS, boundary) < 3) continue;
      const candidate = scoreBoundary(boundary, { black: true, silence: nearSilence(boundary) });
      if (candidate) blackCandidates.push(candidate);
    }
  }

  // 2) 音频静默（次信号）：黑场候选不足时使用；要求之前片头段切换更密集。
  const silenceCandidates: Candidate[] = [];
  for (const range of silences) {
    for (const boundary of [range.start, range.end]) {
      if (boundary < minIntro || boundary > maxIntro) continue;
      if (cutsBetween(boundary - BEFORE_WINDOW_SECONDS, boundary) < 5) continue;
      const candidate = scoreBoundary(boundary, { black: nearBlack(boundary), silence: true });
      if (candidate) silenceCandidates.push(candidate);
    }
  }

  // 3) 镜头节奏骤停（兜底）：没有黑场/静默，但片头段之后突然长时间不切换。
  const gapCandidates: Candidate[] = [];
  for (let index = 0; index < cuts.length; index += 1) {
    const start = cuts[index];
    const next = cuts[index + 1];
    if (next === undefined || next - start < 15) continue;
    if (start < minIntro || start > maxIntro) continue;
    if (cutsBetween(start - BEFORE_WINDOW_SECONDS, start) < 6) continue;
    if (cutsBetween(start, start + AFTER_WINDOW_SECONDS) > 2) continue;
    const candidate = scoreBoundary(start, { black: nearBlack(start), silence: nearSilence(start) });
    if (candidate) gapCandidates.push(candidate);
  }

  // 同一信号里取「最早达到中置信」的边界：电视剧片头结束的那个黑场通常是第一个合格转场，
  // 之后正片里的黑场或停顿时不应让跳转点后移。
  const pickEarliest = (pool: Candidate[]): Candidate | null =>
    pool
      .filter((candidate) => candidate.score >= MEDIUM_SCORE)
      .sort((a, b) => a.time - b.time)[0] ?? null;
  const best = pickEarliest(blackCandidates) ?? pickEarliest(silenceCandidates) ?? pickEarliest(gapCandidates);
  if (!best) {
    return { skipTo: 0, confidence: 'none', evidence: '未找到片头结束的转场信号', scanned: scanSeconds };
  }
  const confidence: IntroConfidence = best.score >= HIGH_SCORE ? 'high' : 'medium';
  return {
    skipTo: best.time,
    confidence,
    evidence: best.evidence.join('、'),
    scanned: scanSeconds,
  };
}

/** 找到可用的 ffmpeg：环境变量 → 部署目录 → PATH。 */
export function resolveFfmpegPath(): string | null {
  const candidates = [
    process.env.FFMPEG_PATH,
    process.platform === 'win32' ? 'D:\\LibreTV\\bin\\ffmpeg.exe' : null,
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  return 'ffmpeg';
}

interface FfmpegRun {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE = 6_000_000;

function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<FfmpegRun> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
      finish(-2);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-MAX_CAPTURE);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_CAPTURE);
    });
    child.on('error', (error) => {
      stderr += String(error instanceof Error ? error.message : error);
      finish(-1);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  });
}

export interface DetectIntroOptions {
  sampleSeconds?: number;
  timeoutMs?: number;
  /** 部分 CDN 分片要求带 Referer/Origin，缺省用部署地址。 */
  referer?: string;
}

const DEFAULT_REFERER = 'http://localhost:8080/';

/**
 * 下载视频开头一小段并做黑场/静音/镜头分析。
 * 返回识别结果；分析失败时抛错，由 API 层转换成「暂不可用」。
 */
export async function detectIntro(
  url: string,
  options: DetectIntroOptions = {},
): Promise<IntroDetection & { timeline: IntroTimeline }> {
  const bin = resolveFfmpegPath();
  if (!bin) throw new Error('未找到 ffmpeg，可设置 FFMPEG_PATH 指定可执行文件');
  const sampleSeconds = Math.min(300, Math.max(60, Math.round(options.sampleSeconds ?? INTRO_SAMPLE_SECONDS)));
  const workDir = await mkdtemp(path.join(tmpdir(), 'libretv-intro-'));
  const samplePath = path.join(workDir, 'sample.ts');
  const referer = options.referer?.trim() || DEFAULT_REFERER;
  // 部分 CDN 会对没有 Referer/Origin 的分片请求返回 403，因此统一带上。
  const requestHeaders = `Referer: ${referer}\r\nOrigin: ${referer}\r\n`;
  const downloadArgs = (extra: string[]): string[] => [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-user_agent', USER_AGENT,
    '-headers', requestHeaders,
    // 卡住不动的分片连接 20s 就放弃，避免一次识别把整个队列拖住几分钟。
    '-rw_timeout', '20000000',
    '-i', url, '-t', String(sampleSeconds), ...extra, '-c', 'copy', '-f', 'mpegts', samplePath,
  ];
  try {
    // 优先连音频一起取（静默检测需要）；音频轨 copy 失败时降级为纯视频。
    const downloadTimeout = options.timeoutMs ?? 90_000;
    let download = await runFfmpeg(bin, downloadArgs(['-map', '0:v:0', '-map', '0:a:0?']), downloadTimeout);
    if (download.code !== 0) {
      download = await runFfmpeg(bin, downloadArgs(['-map', '0:v:0']), Math.min(downloadTimeout, 45_000));
    }
    if (download.code !== 0) {
      const detail = download.stderr.trim().split('\n').slice(-2).join(' ');
      throw new Error(`下载视频开头失败${detail ? `：${detail}` : ''}`);
    }
    // 用 showinfo 把「通过场景阈值筛选后的帧」时间点打到 stderr：比 metadata=print:file=…
    // 更兼容（旧版 ffmpeg 在 Windows 上会因路径盘符里的冒号解析失败）。
    const analysis = await runFfmpeg(bin, [
      '-hide_banner', '-nostdin', '-loglevel', 'info', '-i', samplePath,
      '-vf', "fps=2,scale=160:90,blackdetect=d=0.10:pix_th=0.10,select='gt(scene,0.30)',showinfo",
      '-af', 'silencedetect=noise=-32dB:d=0.5',
      '-f', 'null', '-',
    ], 45_000);
    if (analysis.code !== 0) {
      throw new Error(`分析视频开头失败（ffmpeg 退出码 ${analysis.code}）`);
    }
    const timeline: IntroTimeline = {
      blackRanges: parseBlackRanges(analysis.stderr),
      cutTimes: parseCutTimes(analysis.stderr),
      silences: parseSilenceRanges(analysis.stderr),
    };
    const detection = analyzeIntroTimeline(timeline, { scanSeconds: sampleSeconds });
    return { ...detection, timeline };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => { /* 清理失败不影响结果 */ });
  }
}
