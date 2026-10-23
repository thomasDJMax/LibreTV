import { describe, expect, it } from 'vitest';
import { aggregateResults, resolveSearchQuery } from './search-results';
import type { SearchResultItem } from './types';

const item = (name: string, vodId: string, patch: Partial<SearchResultItem> = {}): SearchResultItem => ({ name, vodId, sourceKey: 'a', sourceName: 'A', year: '1994', typeName: '欧美剧', ...patch });

describe('series and movie source results', () => {
  it('uses the catalogued CSI title without confusing the Vegas reboot or Miami spinoff', () => {
    expect(resolveSearchQuery('拉斯维加斯犯罪现场调查')).toBe('犯罪现场调查');
    expect(resolveSearchQuery('犯罪现场调查：维加斯')).toBe('犯罪现场调查：维加斯');
    expect(resolveSearchQuery('犯罪现场调查迈阿密第一季')).toBe('犯罪现场调查迈阿密第一季');
  });
  it('groups typography differences while preserving every source', () => {
    const result = aggregateResults([item('老友记 第一季', '1'), item('老友记第一季', '2', { sourceKey: 'b' })], '老友记');
    expect(result).toHaveLength(1);
    expect(result[0].items).toHaveLength(2);
  });
  it('puts the requested series in season order ahead of related shows and commentary', () => {
    const names = ['古宅老友记第一季', '老友记第十季', '老友记第一季[电影解说]', '老友记第二季', '老友记第一季'];
    const result = aggregateResults(names.map((name, i) => item(name, String(i))), '老友记');
    expect(result.slice(0, 3).map((group) => group.name)).toEqual(['老友记第一季', '老友记第二季', '老友记第十季']);
  });
  it('keeps remakes, seasons, languages and same-title commentary distinct', () => {
    const result = aggregateResults([
      item('电影', '1', { year: '1994', typeName: '剧情片' }),
      item('电影', '2', { year: '2020', typeName: '剧情片' }),
      item('电影（原声版）', '3'), item('电影（国语版）', '4'),
      item('电影', '5', { year: '1994', typeName: '电影解说' }),
      item('剧第一季', '6'), item('剧第二季', '7'),
    ]);
    expect(result).toHaveLength(7);
  });
  it('keeps group identity stable as sources arrive and removes repeated source IDs', () => {
    const a = item('老友记 第一季', '1');
    const first = aggregateResults([a])[0];
    const complete = aggregateResults([a, a, item('老友记第一季', '2', { sourceKey: 'b' })])[0];
    expect(complete.key).toBe(first.key);
    expect(complete.items).toHaveLength(2);
  });
});
