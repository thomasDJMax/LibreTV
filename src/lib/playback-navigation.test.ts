import { describe, expect, it } from 'vitest';
import { isMovieType, isMovieVersionList, playbackEntryLabel } from './playback-navigation';

describe('movie edition navigation', () => {
  it('recognizes explicit movie categories, including single-video movies', () => {
    for (const type of ['电影', '剧情片', '动作片', '科幻片', '动画电影', '纪录片']) expect(isMovieType(type)).toBe(true);
    for (const type of [undefined, '', '欧美剧', '国产动漫', '综艺', '电视剧', '剧情']) expect(isMovieType(type)).toBe(false);
  });

  it('keeps 暴风盗梦空间 HD国语 and HD中字 as movie versions, not consecutive episodes', () => {
    expect(isMovieVersionList('剧情片', ['HD国语', 'HD中字'])).toBe(true);
    expect(isMovieVersionList('动作片', ['BD1080P 国语中字', '蓝光原声版'])).toBe(true);
    expect(isMovieVersionList('电影', ['正片', '英语中英双字'])).toBe(true);
    expect(isMovieVersionList('剧情片', ['HD中字'])).toBe(true);
    expect(isMovieVersionList('剧情片', ['盗梦空间(原声版)'])).toBe(true);
  });

  it('does not automatically advance unlabelled entries in an explicitly categorized movie', () => {
    expect(isMovieVersionList('剧情片')).toBe(true);
    expect(isMovieVersionList('电影', [])).toBe(true);
    expect(isMovieVersionList('爱情片', ['', ' '])).toBe(true);
  });

  it('keeps true or merged numbered episodes sequential despite mistaken movie metadata', () => {
    for (const labels of [['第01集', '第02集'], ['第01-02集', '第03集'], ['EP01', 'EP02'], ['S01E01', 'S01E02'], ['1', '2'], ['01-02', '03']]) {
      expect(isMovieVersionList('剧情片', labels)).toBe(false);
    }
    expect(isMovieVersionList('欧美剧', ['HD中字', 'HD中字'])).toBe(false);
    expect(isMovieVersionList('国产动漫', ['正片', '正片'])).toBe(false);
    expect(isMovieVersionList('剧情片', ['第01-02集'])).toBe(false);
  });

  it('does not guess unknown types or movie parts to be alternative complete editions', () => {
    expect(isMovieVersionList(undefined, ['HD国语', 'HD中字'])).toBe(false);
    expect(isMovieVersionList('剧情片', ['正片上', '正片下'])).toBe(false);
    expect(isMovieVersionList('电影', ['HD中字1', 'HD中字2'])).toBe(false);
  });
});

describe('playback entry labels', () => {
  it('preserves actual source labels and merged episode identities', () => {
    expect(playbackEntryLabel(['HD国语', 'HD中字'], 1, true)).toBe('HD中字');
    expect(playbackEntryLabel(['第01-02集', '第03集'], 0)).toBe('第01-02集');
    expect(playbackEntryLabel(['第01集'], 0)).toBe('第01集');
  });

  it('uses appropriate fallbacks only when the source label is missing', () => {
    expect(playbackEntryLabel(undefined, 0, true)).toBe('版本 1');
    expect(playbackEntryLabel([' '], 0)).toBe('第 1 集');
  });
});
