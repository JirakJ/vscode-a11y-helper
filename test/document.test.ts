import { describe, expect, it } from 'vitest';
import { auditDocumentSource as audit, DocumentRules } from '../src/core/document';

const rules = (src: string): string[] => audit(src, 't.html').issues.map((i) => i.rule.id);
const LIMIT = 8_000;

function page(htmlAttrs = 'lang="en"', head = '<title>Home – Acme</title>', body = ''): string {
  return `<!doctype html>\n<html ${htmlAttrs}>\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>`;
}

describe('DocumentMetadataAuditor', () => {
  it('well-formed page passes with two document checks', () => {
    const r = audit(page(), 't.html');
    expect(r.issues).toEqual([]);
    expect(r.checked).toBe(2);
    expect(r.passed).toBe(2);
  });

  it('missing lang is an error located on the html tag', () => {
    const issues = audit(page(''), 't.html').issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule.id).toBe(DocumentRules.MISSING_LANG.id);
    expect(issues[0]!.severity).toBe('ERROR');
    expect(issues[0]!.line).toBe(2);
  });

  it('lang validation accepts BCP 47 and rejects garbage or empty', () => {
    expect(rules(page('lang="pt-BR"'))).toEqual([]);
    expect(rules(page('lang="zh-Hant-TW"'))).toEqual([]);
    expect(rules(page('lang="english"'))).toEqual([DocumentRules.INVALID_LANG.id]);
    expect(rules(page('lang=""'))).toEqual([DocumentRules.MISSING_LANG.id]);
    expect(rules(page('lang={locale}'))).toEqual([]);
    expect(rules(page(':lang="locale"'))).toEqual([]);
  });

  it('title must exist and have text', () => {
    expect(rules(page(undefined, '<meta charset="utf-8">'))).toEqual([DocumentRules.MISSING_TITLE.id]);
    const empty = audit(page(undefined, '<title>   </title>'), 't.html').issues;
    expect(empty).toHaveLength(1);
    expect(empty[0]!.rule.id).toBe(DocumentRules.EMPTY_TITLE.id);
    expect(empty[0]!.line).toBe(4);
    expect(rules(page(undefined, '<title>{pageTitle}</title>'))).toEqual([]);
    expect(rules(page(undefined, '<title>@ViewData["Title"]</title>'))).toEqual([]);
  });

  it('viewport that blocks zoom is an error', () => {
    const Z = [DocumentRules.VIEWPORT_ZOOM_BLOCKED.id];
    expect(rules(page(undefined, '<title>T</title><meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">'))).toEqual(Z);
    expect(rules(page(undefined, '<title>T</title><meta name="viewport" content="width=device-width, maximum-scale=1.0">'))).toEqual(Z);
    expect(rules(page(undefined, '<title>T</title><meta name="viewport" content="width=device-width, initial-scale=1">'))).toEqual([]);
    expect(rules(page(undefined, '<title>T</title><meta name="viewport" content="width=device-width, maximum-scale=5">'))).toEqual([]);
  });

  it('meta refresh is a warning, immediate redirect only informational', () => {
    const timed = audit(page(undefined, '<title>T</title><meta http-equiv="refresh" content="30">'), 't.html').issues;
    expect(timed).toHaveLength(1);
    expect(timed[0]!.rule.id).toBe(DocumentRules.META_REFRESH.id);
    expect(timed[0]!.severity).toBe('WARNING');
    const redirect = audit(page(undefined, '<title>T</title><meta http-equiv="refresh" content="0; url=/new">'), 't.html').issues;
    expect(redirect).toHaveLength(1);
    expect(redirect[0]!.severity).toBe('INFO');
  });

  it('document checks are skipped for fragments', () => {
    const r = audit('<div><h2>Widget</h2></div>', 'w.jsx');
    expect(r.issues).toEqual([]);
    expect(r.checked).toBe(0);
  });

  it('duplicate ids are warnings, errors when referenced', () => {
    const src = [
      '<label for="email">E-mail</label>',
      '<input id="email">',
      '<input id="email">',
      '<div id="card"></div>',
      '<div id="card"></div>',
    ].join('\n');
    const r = audit(src, 'f.html');
    const ids = r.issues.filter((i) => i.rule.id === DocumentRules.DUPLICATE_ID.id);
    expect(ids).toHaveLength(2);
    expect(ids.find((i) => i.line === 3)!.severity).toBe('ERROR');
    expect(ids.find((i) => i.line === 5)!.severity).toBe('WARNING');
    expect(r.checked).toBe(2);
    expect(r.passed).toBe(0);
  });

  it('templated and dynamic ids are not compared', () => {
    const src = [
      '<li id={item.id}></li>',
      '<li id={item.id}></li>',
      '<li id="row-{{ index }}"></li>',
      '<li id="row-{{ index }}"></li>',
      '<li id="@item.Id"></li>',
      '<li id="@item.Id"></li>',
      '<li :id="rowId"></li>',
      '<li :id="rowId"></li>',
    ].join('\n');
    const r = audit(src, 'f.vue');
    expect(r.issues).toEqual([]);
    expect(r.checked).toBe(0);
  });

  it('duplicate accesskeys are warnings', () => {
    const r = audit('<a href="/s" accesskey="s">Search</a><button accesskey="S">Save</button><button accesskey="h">Help</button>', 'f.html');
    expect(r.issues.map((i) => i.rule.id)).toEqual([DocumentRules.DUPLICATE_ACCESSKEY.id]);
    expect(r.checked).toBe(2);
    expect(r.passed).toBe(1);
  });

  it('issues are sorted by position', () => {
    const lines = audit(page('', '<title></title>', '<div id="a"></div><div id="a"></div>'), 't.html').issues.map((i) => i.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it('every failing viewport counts as its own unit', () => {
    const head = '<title>T</title><meta name="viewport" content="user-scalable=no"><meta name="viewport" content="maximum-scale=1">';
    const r = audit(page(undefined, head), 't.html');
    expect(r.issues.filter((i) => i.rule.id === DocumentRules.VIEWPORT_ZOOM_BLOCKED.id)).toHaveLength(2);
    expect(r.checked).toBe(4);
    expect(r.passed).toBe(2);
  });

  it('viewport and refresh are checked in fragments too', () => {
    const r = audit('<Head><meta name="viewport" content="width=device-width, user-scalable=no" /></Head>', 'layout.tsx');
    expect(r.issues.map((i) => i.rule.id)).toEqual([DocumentRules.VIEWPORT_ZOOM_BLOCKED.id]);
    expect(r.checked).toBe(1);
    expect(audit('<meta name="viewport" content={viewport} />', 'l.tsx').issues).toEqual([]);
  });

  it('svg title is not a page title and uppercase TITLE is', () => {
    expect(rules(page(undefined, '<svg><title>Icon</title></svg>'))).toEqual([DocumentRules.MISSING_TITLE.id]);
    expect(rules(page(undefined, '<TITLE>Home</TITLE>'))).toEqual([]);
  });

  it('svelte interpolation and htmlFor are understood', () => {
    expect(audit('<li id="row-{index}"></li><li id="row-{index}"></li>', 'l.svelte').checked).toBe(0);
    const issues = audit('<label htmlFor="email">E-mail</label><input id="email" /><input id="email" />', 'f.jsx').issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule.id).toBe(DocumentRules.DUPLICATE_ID.id);
    expect(issues[0]!.severity).toBe('ERROR');
  });

  it('React httpEquiv spelling is recognised', () => {
    const r = audit('<meta httpEquiv="refresh" content="30" />', 'l.tsx');
    expect(r.issues.map((i) => i.rule.id)).toEqual([DocumentRules.META_REFRESH.id]);
    expect(r.checked).toBe(1);
  });

  it('ids in mutually exclusive template branches are not duplicates', () => {
    expect(audit('<label for="e">E</label><input id="e" v-if="a"><input id="e" v-else>', 'f.vue').issues).toEqual([]);
    expect(audit('<label htmlFor="e">E</label>{a ? (<input id="e" />) : (<input id="e" disabled />)}', 'f.jsx').issues).toEqual([]);
    expect(audit('<label for="e">E</label>{#if a}<input id="e">{:else}<input id="e" disabled>{/if}', 'f.svelte').issues).toEqual([]);
    expect(audit('<label for="e">E</label><input id="e"><input id="e">', 'f.html').issues).toHaveLength(1);
  });

  it('many duplicates of one id are handled in linear time', { timeout: 60_000 }, () => {
    const t = performance.now();
    expect(audit('<div id="x"></div>'.repeat(8_000), 'many.html').issues).toHaveLength(7_999);
    expect(performance.now() - t).toBeLessThan(LIMIT);
  });

  it('conditional wrappers count, but an unconditional id before a Svelte if block is a duplicate', () => {
    expect(audit('<div v-if="a"><input id="e"></div><div v-else><input id="e"></div>', 'f.vue').issues).toEqual([]);
    expect(audit('<input id="e">{#if a}<input id="e">{/if}', 'f.svelte').issues).toHaveLength(1);
  });

  it('nested duplicate ids are linear and Vue conditionals are precise', { timeout: 60_000 }, () => {
    const src = '<div id="x">'.repeat(8_000) + '</div>'.repeat(8_000);
    const t = performance.now();
    expect(audit(src, 'nested.html').issues).toHaveLength(7_999);
    expect(performance.now() - t).toBeLessThan(LIMIT);
    expect(audit('<input id="e"><input id="e" v-if="a">', 'f.vue').issues).toHaveLength(1);
    expect(audit('<div v-if="a"><input id="e"><input id="e"></div>', 'f.vue').issues).toHaveLength(1);
    expect(audit('<input id="e" v-if="a"><input id="e" v-else-if="b"><input id="e" v-else>', 'f.vue').issues).toEqual([]);
  });

  it('svg title ancestry is memoised and absurd lang values do not overflow', { timeout: 60_000 }, () => {
    const body = '<svg>' + '<g><title>n</title>'.repeat(16_000) + '</g>'.repeat(16_000) + '</svg>';
    const t = performance.now();
    const r = audit(page(undefined, '', body), 't.html');
    expect(r.issues.some((i) => i.rule.id === DocumentRules.MISSING_TITLE.id)).toBe(true);
    expect(performance.now() - t).toBeLessThan(LIMIT);
    const lang = 'en-x-' + 'a-'.repeat(10_000) + 'a';
    expect(rules(page(`lang="${lang}"`))).toEqual([DocumentRules.INVALID_LANG.id]);
  });

  it('ternary detection is linear in whitespace', { timeout: 60_000 }, () => {
    const src = ("<i id='dup'></i>) :" + ' '.repeat(4000) + 'x').repeat(497);
    const t = performance.now();
    expect(audit(src, 't.jsx').issues).toHaveLength(496);
    expect(performance.now() - t).toBeLessThan(LIMIT);
    expect(audit('{a ? (<input id="e" />) :   (  <input id="e" />)}', 'f.jsx').issues).toEqual([]);
  });
});
