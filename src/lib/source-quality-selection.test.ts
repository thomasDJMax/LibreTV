import { describe, expect, it } from 'vitest';
import type { SearchResultItem } from './types';
import { groupIdenticalSamples, normalizeVideoTitle, rankSourceCandidates, resolveEpisodeTarget, selectSourceMatch, selectSourceMatches, sourceSearchTitle } from './source-quality-selection';

function hit(name: string, overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return { name, sourceKey: 'test', sourceName: '测试源', vodId: name, ...overrides };
}

describe('safe same-film source matching', () => {
  it('does not replace Sintel with commentary or a trailer when no exact film exists', () => {
    expect(selectSourceMatch({ title: 'Sintel' }, [hit('Sintel[电影解说]'), hit('Sintel 预告片'), hit('Sintel 幕后花絮')])).toBeUndefined();
  });

  it('rejects derivative metadata even when the result title itself matches', () => {
    expect(selectSourceMatch({ title: 'Sintel' }, [hit('Sintel', { typeName: '电影解说' })])).toBeUndefined();
    expect(selectSourceMatch({ title: '西游记' }, [hit('西游记', { typeName: '纪录片' })])).toBeUndefined();
  });

  it('keeps commentary when commentary is the requested video', () => {
    expect(selectSourceMatch({ title: 'Sintel[电影解说]', typeName: '电影解说' }, [hit('Sintel[电影解说]', { typeName: '电影解说' })])?.name).toBe('Sintel[电影解说]');
  });

  it('normalizes full-width punctuation, case and spacing and accepts common version suffixes', () => {
    expect(normalizeVideoTitle(' Ｓｉｎｔｅｌ：黎明 ')).toBe('sintel黎明');
    expect(selectSourceMatch({ title: 'Ｓｉｎｔｅｌ' }, [hit('Sintel（1080P 国语中字）')])?.name).toBe('Sintel（1080P 国语中字）');
  });

  it('prefers an exact title over a version suffix without using arbitrary prefixes', () => {
    const exact = hit('西游记');
    expect(selectSourceMatch({ title: '西游记' }, [hit('西游记 HD'), exact])).toBe(exact);
    expect(selectSourceMatch({ title: '西游记' }, [hit('后西游记'), hit('西游记1986'), hit('西游记之暗黑人参果'), hit('西游记 第二季')])).toBeUndefined();
  });

  it('does not erase sequel, season or movie-edition identity', () => {
    expect(selectSourceMatch({ title: 'Sintel' }, [hit('Sintel 2'), hit('Sintel 剧场版'), hit('Sintel 电影版')])).toBeUndefined();
    expect(selectSourceMatch({ title: '仙逆 第二季' }, [hit('仙逆 第一季')])).toBeUndefined();
  });

  it('excludes known conflicting years, permits unknown years, and prefers a matching known year', () => {
    const matching = hit('西游记', { year: '1986' });
    expect(selectSourceMatch({ title: '西游记', year: '1986' }, [hit('西游记', { year: '2010' })])).toBeUndefined();
    expect(selectSourceMatch({ title: '西游记', year: '1986' }, [hit('西游记', { year: '未知' }), matching])).toBe(matching);
    expect(selectSourceMatch({ title: '西游记', year: '1986' }, [hit('西游记')])).toBeDefined();
  });

  it('does not replace a known TV series with a same-title movie', () => {
    expect(selectSourceMatch({ title: '西游记', typeName: '国产剧' }, [hit('西游记', { typeName: '动作片' })])).toBeUndefined();
  });
});

describe('multiple same-film editions', () => {
  it('keeps the bare 720p film and separate original-audio 1080p edition for later quality inspection', () => {
    const bare = hit('黑暗骑士', { year: '2008', typeName: '动作片', vodId: '720' });
    const originalAudio = hit('黑暗骑士（原声版）', { year: '2008', typeName: '动作片', vodId: '1080' });
    expect(selectSourceMatches({ title: '黑暗骑士', year: '2008', typeName: '动作片' }, [originalAudio, bare])).toEqual([bare, originalAudio]);
    expect(selectSourceMatch({ title: '黑暗骑士', year: '2008' }, [originalAudio, bare])).toBe(bare);
  });

  it('recognizes explicit language editions, while keeping originals, remakes and derivatives distinct', () => {
    const input = ['黑暗骑士（原声版）', '黑暗骑士 英语版', '黑暗骑士 国语版', '黑暗骑士 配音版'].map((name) => hit(name, { year: '2008' }));
    input.push(hit('黑暗骑士（原声版）', { year: '2020', vodId: 'remake' }), hit('黑暗骑士（国语版）[电影解说]'), hit('黑暗骑士 预告片'), hit('黑暗骑士崛起'), hit('黑暗骑士 剧场版'));
    expect(selectSourceMatches({ title: '黑暗骑士', year: '2008' }, input, 8).map((result) => result.name)).toEqual(['黑暗骑士（原声版）', '黑暗骑士 英语版', '黑暗骑士 国语版', '黑暗骑士 配音版']);
  });

  it('returns at most three editions by default, removes duplicate IDs and honors a lower limit', () => {
    const bare = hit('Sintel', { vodId: 'same' });
    const input = [bare, hit('Sintel HD', { vodId: 'same' }), hit('Sintel 原声版'), hit('Sintel 英语版'), hit('Sintel 国语版')];
    expect(selectSourceMatches({ title: 'Sintel' }, input).map((result) => result.vodId)).toEqual(['same', 'Sintel 原声版', 'Sintel 英语版']);
    expect(selectSourceMatches({ title: 'Sintel' }, input, 1)).toEqual([bare]);
    expect(selectSourceMatches({ title: 'Sintel' }, input, 0)).toEqual([]);
    expect(selectSourceMatches({ title: 'Sintel' }, input, Infinity)).toEqual([]);
  });

  it('does not confuse equal numeric IDs belonging to independent sources', () => {
    const input = [hit('Sintel', { sourceKey: 'a', vodId: '1' }), hit('Sintel', { sourceKey: 'b', vodId: '1' })];
    expect(selectSourceMatches({ title: 'Sintel' }, input)).toHaveLength(2);
  });

  it('permits CSI same-season same-year series/variety catalog errors in either direction', () => {
    const csi = hit('犯罪现场调查第一季', { year: '2000', typeName: '欧美综艺' });
    expect(selectSourceMatches({ title: '犯罪现场调查第一季', year: '2000', typeName: '欧美剧' }, [csi])).toEqual([csi]);
    const series = hit('犯罪现场调查第一季', { year: '2000', typeName: '欧美剧' });
    expect(selectSourceMatch({ title: '犯罪现场调查第一季', year: '2000', typeName: '欧美综艺' }, [series])).toBe(series);
  });

  it('requires exact title including season and known equal years before allowing a type mislabel', () => {
    const current = { title: '犯罪现场调查第一季', year: '2000', typeName: '欧美剧' };
    expect(selectSourceMatches(current, [
      hit('犯罪现场调查第二季', { year: '2000', typeName: '欧美综艺' }),
      hit('犯罪现场调查第一季', { year: '2001', typeName: '欧美综艺' }),
      hit('犯罪现场调查第一季', { typeName: '欧美综艺' }),
      hit('犯罪现场调查第一季 HD', { year: '2000', typeName: '欧美综艺' }),
      hit('犯罪现场调查第一季[解说]', { year: '2000', typeName: '欧美综艺' }),
    ])).toEqual([]);
    expect(selectSourceMatches({ title: '犯罪现场调查', year: '2000', typeName: '欧美剧' }, [hit('犯罪现场调查', { year: '2000', typeName: '欧美综艺' })])).toEqual([]);
    expect(selectSourceMatches({ title: '犯罪现场调查第一季', typeName: '欧美剧' }, [hit('犯罪现场调查第一季', { year: '2000', typeName: '欧美综艺' })])).toEqual([]);
  });

  it('supports explicit English season labels but never relaxes movie-versus-series conflicts', () => {
    const english = hit('CSI Season 1', { year: '2000', typeName: '欧美综艺' });
    expect(selectSourceMatch({ title: 'CSI Season 1', year: '2000', typeName: '欧美剧' }, [english])).toBe(english);
    expect(selectSourceMatch({ title: 'CSI Season 1', year: '2000', typeName: '欧美剧' }, [hit('CSI Season 1', { year: '2000', typeName: '动作片' })])).toBeUndefined();
  });
});

describe('source search title', () => {
  it('removes an ending language edition without normalizing away an internal colon or spaces', () => {
    expect(sourceSearchTitle(' 蝙蝠侠：黑暗骑士 （原声版） ')).toBe('蝙蝠侠：黑暗骑士');
    expect(sourceSearchTitle('CSI: Crime Scene Investigation 第一季 [1080P 英语版]')).toBe('CSI: Crime Scene Investigation 第一季');
  });

  it('preserves parentheses that belong to the film title and terminal title punctuation', () => {
    expect(sourceSearchTitle('蝙蝠侠（黑暗骑士）（原声版）')).toBe('蝙蝠侠（黑暗骑士）');
    expect(sourceSearchTitle('Who? HD')).toBe('Who?');
  });

  it('keeps season, derivative and sequel identity instead of turning them into a bare film search', () => {
    expect(sourceSearchTitle('西游记 第二季')).toBe('西游记 第二季');
    expect(sourceSearchTitle('西游记之暗黑人参果')).toBe('西游记之暗黑人参果');
    expect(sourceSearchTitle('Sintel[电影解说]')).toBe('Sintel[电影解说]');
    expect(sourceSearchTitle('Sintel 2 4K')).toBe('Sintel 2');
    expect(sourceSearchTitle('HD')).toBe('HD');
  });
});

describe('episode mapping', () => {
  it('maps episode 162 by its label despite a differently ordered/partial target list', () => {
    expect(resolveEpisodeTarget({ currentIndex: 161, currentLabel: '第162集', currentEpisodeCount: 162, targetEpisodeCount: 3, targetLabels: ['EP160', 'EP162', 'EP161'] })).toEqual({ ok: true, index: 1, matchedBy: 'label' });
  });

  it('normalizes full-width digits and Chinese episode numerals', () => {
    expect(resolveEpisodeTarget({ currentIndex: 161, currentLabel: '第一百六十二集', targetEpisodeCount: 1, targetLabels: ['ＥＰ．１６２'] })).toEqual({ ok: true, index: 0, matchedBy: 'label' });
  });

  it('refuses a missing labelled episode even if the old position fits in the target', () => {
    const result = resolveEpisodeTarget({ currentIndex: 1, currentLabel: '第162集', targetEpisodeCount: 3, targetLabels: ['第1集', '第2集', '第3集'] });
    expect(result.ok).toBe(false);
  });

  it('does not silently fall back to episode 1 when index 162 is missing', () => {
    const result = resolveEpisodeTarget({ currentIndex: 161, targetEpisodeCount: 10 });
    expect(result).toEqual({ ok: false, reason: '该源没有第 162 集' });
  });

  it('refuses duplicate labels and keeps upper/lower parts distinct', () => {
    expect(resolveEpisodeTarget({ currentIndex: 0, currentLabel: '第2集', targetEpisodeCount: 2, targetLabels: ['EP2', '第2集'] }).ok).toBe(false);
    expect(resolveEpisodeTarget({ currentIndex: 0, currentLabel: '第2集上', targetEpisodeCount: 2, targetLabels: ['第2集下', '第2集上'] })).toEqual({ ok: true, index: 1, matchedBy: 'label' });
  });

  it('does not confuse fractional or range labels with a whole episode number', () => {
    expect(resolveEpisodeTarget({ currentIndex: 0, currentLabel: '第1.5集', targetEpisodeCount: 1, targetLabels: ['第15集'] }).ok).toBe(false);
    expect(resolveEpisodeTarget({ currentIndex: 0, currentLabel: '第1-2集', targetEpisodeCount: 1, targetLabels: ['第12集'] }).ok).toBe(false);
  });

  it('keeps positional mapping only when labels are unavailable and the position exists', () => {
    expect(resolveEpisodeTarget({ currentIndex: 2, currentLabel: '第3集', targetEpisodeCount: 4 })).toEqual({ ok: true, index: 2, matchedBy: 'position' });
    expect(resolveEpisodeTarget({ currentIndex: -1, targetEpisodeCount: 4 }).ok).toBe(false);
  });

  it('allows single-video movie editions with different presentation labels', () => {
    expect(resolveEpisodeTarget({ currentIndex: 0, currentEpisodeCount: 1, currentLabel: 'HD国语', targetEpisodeCount: 1, targetLabels: ['正片'], movieVersions: true })).toEqual({ ok: true, index: 0, matchedBy: 'movie' });
  });

  it('does not mistake single-entry series sources with different episode numbers for movie editions', () => {
    const current = { currentIndex: 0, currentEpisodeCount: 1, currentLabel: '第12集', targetEpisodeCount: 1 };
    expect(resolveEpisodeTarget({ ...current, targetLabels: ['第01集'], movieVersions: false }))
      .toEqual({ ok: false, reason: '该源没有对应的第12集' });
    expect(resolveEpisodeTarget({ ...current, targetLabels: ['第01集'] }).ok).toBe(false);
    expect(resolveEpisodeTarget({ ...current, targetLabels: ['EP12'] }))
      .toEqual({ ok: true, index: 0, matchedBy: 'label' });
  });

  it('maps a single movie to original audio among multiple language editions only when explicitly enabled', () => {
    const params = { currentIndex: 0, currentEpisodeCount: 1, currentLabel: '正片', targetEpisodeCount: 3, targetLabels: ['HD国语', 'HD中字', '原声版'] };
    expect(resolveEpisodeTarget(params).ok).toBe(false);
    expect(resolveEpisodeTarget({ ...params, movieVersions: true })).toEqual({ ok: true, index: 2, matchedBy: 'movie' });
  });

  it('maps a later language edition back to a single movie rather than treating it as a missing TV episode', () => {
    const params = { currentIndex: 2, currentEpisodeCount: 3, currentLabel: 'HD中字', targetEpisodeCount: 1, targetLabels: ['正片'] };
    expect(resolveEpisodeTarget(params).ok).toBe(false);
    expect(resolveEpisodeTarget({ ...params, movieVersions: true })).toEqual({ ok: true, index: 0, matchedBy: 'movie' });
  });

  it('preserves an exactly matching Mandarin edition before choosing an original-audio fallback', () => {
    expect(resolveEpisodeTarget({ currentIndex: 1, currentLabel: 'HD国语', currentEpisodeCount: 2, targetEpisodeCount: 3, targetLabels: ['原声版', 'HD中字', 'HD国语'], movieVersions: true })).toEqual({ ok: true, index: 2, matchedBy: 'label' });
  });

  it('avoids Mandarin/Cantonese dubbed candidates when choosing an English or subtitled movie fallback', () => {
    expect(resolveEpisodeTarget({ currentIndex: 0, currentLabel: '正片', targetEpisodeCount: 4, targetLabels: ['国语中字', '粤语原声版', '英语配音版', 'HD英语'], movieVersions: true })).toEqual({ ok: true, index: 3, matchedBy: 'movie' });
    expect(resolveEpisodeTarget({ currentIndex: 0, currentLabel: '正片', targetEpisodeCount: 2, targetLabels: ['国语中字', 'HD中字'], movieVersions: true })).toEqual({ ok: true, index: 1, matchedBy: 'movie' });
  });

  it('uses the first movie edition when no clear language preference is present, without changing strict series mapping', () => {
    expect(resolveEpisodeTarget({ currentIndex: 2, currentLabel: 'HD', targetEpisodeCount: 2, targetLabels: ['蓝光', '高清'], movieVersions: true })).toEqual({ ok: true, index: 0, matchedBy: 'movie' });
    expect(resolveEpisodeTarget({ currentIndex: 1, currentLabel: '第162集', targetEpisodeCount: 3, targetLabels: ['第1集', '第2集', '第3集'], movieVersions: false }).ok).toBe(false);
  });
});

describe('source quality ordering', () => {
  it('puts actual available media ahead of failed or unchecked higher resolution labels', () => {
    const list = rankSourceCandidates([
      { id: 'failed4k', available: false, width: 3840, height: 2160, interfaceMs: 1 },
      { id: 'unchecked', width: 3840, height: 2160, interfaceMs: 2 },
      { id: 'playable', available: true, width: 1280, height: 720, interfaceMs: 3000 },
    ]);
    expect(list.map((item) => item.id)).toEqual(['playable', 'unchecked', 'failed4k']);
  });

  it('prioritizes actual bitstream pixels, then encoded bitrate, with API milliseconds last', () => {
    const list = rankSourceCandidates([
      { id: 'fast720', available: true, width: 1280, height: 720, interfaceMs: 5 },
      { id: '1080low', available: true, width: 1920, height: 1080, mediaKbps: 800, interfaceMs: 30 },
      { id: '1080high', available: true, width: 1920, height: 1080, mediaKbps: 4000, interfaceMs: 2000 },
      { id: '4K unknown', available: true, remarks: '4K', interfaceMs: 1 },
    ]);
    expect(list.map((item) => item.id)).toEqual(['1080high', '1080low', 'fast720', '4K unknown']);
  });

  it('leaves equal unknown-quality candidates in their order and never mutates input', () => {
    const input = [{ id: 'a', available: undefined }, { id: 'b', available: undefined }];
    const result = rankSourceCandidates(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('pins the current source only when requested and ignores invalid measurements', () => {
    const current = { id: 'current', available: true, isCurrent: true, width: NaN, height: 2160, mediaKbps: -2 };
    const clear = { id: 'clear', available: true, width: 1920, height: 1080 };
    expect(rankSourceCandidates([current, clear])[0]).toBe(clear);
    expect(rankSourceCandidates([current, clear], { pinCurrent: true })[0]).toBe(current);
  });
});

describe('sample duplicate grouping', () => {
  it('groups actual matching hashes across hosts without deleting configured choices', () => {
    const input = [{ id: 'red', sampleHash: 'aBc', host: 'one.example' }, { id: 'tiger', sampleHash: 'ABC', host: 'two.example' }, { id: 'different', sampleHash: 'def', host: 'one.example' }];
    expect(groupIdenticalSamples(input).map((group) => group.map((item) => item.id))).toEqual([['red', 'tiger'], ['different']]);
  });

  it('does not infer identical videos from missing hashes or a shared CDN host', () => {
    const input = [{ id: 'a', host: 'same.example' }, { id: 'b', host: 'same.example', sampleHash: '' }];
    expect(groupIdenticalSamples(input).map((group) => group.map((item) => item.id))).toEqual([['a'], ['b']]);
  });
});
