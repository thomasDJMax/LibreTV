import { describe, expect, it } from 'vitest';
import {
  analyzeIntroTimeline,
  parseBlackRanges,
  parseCutTimes,
  parseSilenceRanges,
  type IntroTimeline,
} from './intro-detect';

/** 把「每 step 秒切一次」的片头节奏转成镜头切换列表（模拟 OP/回顾）。 */
function montage(from: number, to: number, step = 2): number[] {
  const cuts: number[] = [];
  for (let time = from; time <= to; time += step) cuts.push(time);
  return cuts;
}

function timeline(partial: Partial<IntroTimeline>): IntroTimeline {
  return {
    blackRanges: partial.blackRanges ?? [],
    cutTimes: partial.cutTimes ?? [],
    silences: partial.silences ?? [],
  };
}

describe('parseBlackRanges', () => {
  it('提取黑场起止并忽略非法区间', () => {
    const log = [
      '[blackdetect @ 000001e4] black_start:41.566667 black_end:43.066667 black_duration:1.5',
      '[blackdetect @ 000001e4] black_start:8.6 black_end:8.6 black_duration:0',
      '[blackdetect @ 000001e4] black_start:60.2 black_end:61.9 black_duration:1.7',
    ].join('\n');
    expect(parseBlackRanges(log)).toEqual([
      { start: 41.566667, end: 43.066667 },
      { start: 60.2, end: 61.9 },
    ]);
  });

  it('没有黑场时返回空数组', () => {
    expect(parseBlackRanges('frame= 100 fps=0.0 q=-1.0 size=N/A time=00:00:04.00 bitrate=N/A')).toEqual([]);
  });
});

describe('parseCutTimes', () => {
  it('去重并升序排序', () => {
    const metadata = [
      'frame:2 pts:4000 pts_time:4.0',
      'lavfi.scene_score=0.512',
      'frame:4 pts:8000 pts_time:8.0',
      'lavfi.scene_score=0.377',
      'frame:2 pts:4000 pts_time:4.0',
    ].join('\n');
    expect(parseCutTimes(metadata)).toEqual([4, 8]);
  });
});

describe('parseSilenceRanges', () => {
  it('按顺序配对静默起止', () => {
    const log = [
      '[silencedetect @ 000001cd] silence_start: 0.2343',
      '[silencedetect @ 000001cd] silence_end: 2.3986 | silence_duration: 2.1643',
      '[silencedetect @ 000001cd] silence_start: 41.2',
      '[silencedetect @ 000001cd] silence_end: 43.0 | silence_duration: 1.8',
    ].join('\n');
    expect(parseSilenceRanges(log)).toEqual([
      { start: 0.2343, end: 2.3986 },
      { start: 41.2, end: 43 },
    ]);
  });

  it('没有收尾的静默不计入', () => {
    expect(parseSilenceRanges('silence_start: 120.5')).toEqual([]);
  });
});

describe('analyzeIntroTimeline', () => {
  it('片头频繁切换 + 黑场/静默转场 + 正片平稳 → 高置信跳过', () => {
    const result = analyzeIntroTimeline(
      timeline({
        cutTimes: montage(2, 40),
        blackRanges: [{ start: 41, end: 42.5 }],
        silences: [{ start: 40, end: 42 }],
      }),
      { scanSeconds: 165 },
    );
    expect(result.confidence).toBe('high');
    // 黑场结束点之后的 18 秒没有镜头切换，说明已进入正片。
    expect(result.skipTo).toBeGreaterThanOrEqual(41);
    expect(result.skipTo).toBeLessThanOrEqual(42.5);
    expect(result.evidence).toContain('黑场转场');
  });

  it('正片从开头就切换频繁（没有片头）→ 不跳', () => {
    const result = analyzeIntroTimeline(
      timeline({ cutTimes: montage(3, 150, 8) }),
      { scanSeconds: 165 },
    );
    expect(result).toMatchObject({ skipTo: 0, confidence: 'none' });
  });

  it('只有两次切换就静默 → 证据不足，不跳', () => {
    const result = analyzeIntroTimeline(
      timeline({
        cutTimes: [2, 4],
        silences: [{ start: 6, end: 7.5 }],
      }),
      { scanSeconds: 165 },
    );
    expect(result).toMatchObject({ skipTo: 0, confidence: 'none' });
  });

  it('片头后长时间无切换（无黑场/静默）→ 中置信跳过', () => {
    const result = analyzeIntroTimeline(
      timeline({ cutTimes: [...montage(2, 38), 100] }),
      { scanSeconds: 165 },
    );
    expect(result.skipTo).toBe(38);
    expect(result.confidence).toBe('medium');
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('候选点晚于片头上限 → 忽略', () => {
    const result = analyzeIntroTimeline(
      timeline({
        cutTimes: montage(2, 140),
        blackRanges: [{ start: 150, end: 152 }],
      }),
      { scanSeconds: 300, maxIntroSeconds: 100 },
    );
    expect(result.skipTo).toBe(0);
  });

  it('开头没有镜头切换（如纯色广告）→ 不跳', () => {
    const result = analyzeIntroTimeline(
      timeline({ blackRanges: [{ start: 1, end: 2 }] }),
      { scanSeconds: 165 },
    );
    expect(result).toMatchObject({ skipTo: 0, confidence: 'none' });
  });

  it('scanned 回传实际分析秒数', () => {
    const result = analyzeIntroTimeline(timeline({ cutTimes: montage(2, 40) }), { scanSeconds: 120 });
    expect(result.scanned).toBe(120);
  });
});
