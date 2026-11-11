import { describe, expect, it } from 'vitest';
import { containsJsxExpression, isFullDocument, parseMarkup, tokenize, visibleTextOf } from '../src/core/markup';

const single = <T>(arr: readonly T[]): T => {
  expect(arr).toHaveLength(1);
  return arr[0]!;
};

describe('MarkupTokenizer', () => {
  it('empty source yields no tags', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('tracks line and column across CRLF and LF', () => {
    const tags = tokenize('<p>a</p>\r\n<div>\n  <a href="x">y</a>');
    const a = tags.find((t) => t.lowerName === 'a' && !t.isClose)!;
    expect(a.line).toBe(3);
    expect(a.column).toBe(2);
    expect(a.attr('href')).toBe('x');
  });

  it('attribute names are lower-cased and JSX braces preserved', () => {
    const tag = single(tokenize("<div onClick={handle} tabIndex={0} data-X='y' hidden>"));
    expect(tag.attributes.get('onclick')).toBe('{handle}');
    expect(tag.attributes.get('tabindex')).toBe('{0}');
    expect(tag.attributes.get('data-x')).toBe('y');
    expect(tag.hidden).toBe(true);
    expect(tag.isDynamic('onclick')).toBe(true);
    expect(tag.isDynamic('data-x')).toBe(false);
  });

  it('skips comments doctype cdata and script or style bodies', () => {
    const src = [
      '<!doctype html>',
      '<!-- <a href="#">commented</a> -->',
      '<script>const s = "<a href=\'#\'>in script</a>";</script>',
      '<style>a { color: red } </style>',
      '<![CDATA[ <a>cdata</a> ]]>',
      '<a href="/real">real</a>',
    ].join('\n');
    const anchors = tokenize(src).filter((t) => t.lowerName === 'a' && !t.isClose);
    expect(single(anchors).attr('href')).toBe('/real');
  });

  it('innerContent is nesting-aware and void elements have none', () => {
    const doc = parseMarkup('<div><div>inner</div>tail</div><img src=x>');
    expect(doc.innerContent(0)).toBe('<div>inner</div>tail');
    const img = doc.tags.findIndex((t) => t.lowerName === 'img');
    expect(doc.innerContent(img)).toBe('');
    expect(doc.closeIndex[img]).toBe(-1);
  });

  it('visibleText strips markup and includes alt and aria-label of nested elements', () => {
    expect(visibleTextOf('  <span>Hello</span>\n <img alt="Logo"> <i aria-label="star"></i>  ')).toBe('Hello Logo star');
    expect(visibleTextOf('<span aria-hidden="true">⚙</span> Settings&nbsp;')).toBe('Settings');
    expect(visibleTextOf('&nbsp;&#160;&#xA0;')).toBe('');
    expect(visibleTextOf('A &amp; B')).toBe('A & B');
  });

  it('containsJsxExpression ignores braces inside tags', () => {
    expect(containsJsxExpression('<span>{label}</span>')).toBe(true);
    expect(containsJsxExpression("<span style={{color: 'red'}}>x</span>")).toBe(false);
  });

  it('isFullDocument detects html or body', () => {
    expect(isFullDocument('<html lang="en"><body></body></html>')).toBe(true);
    expect(isFullDocument('<body>\n</body>')).toBe(true);
    expect(isFullDocument('<div>fragment</div>')).toBe(false);
  });

  it('component detection and bindings', () => {
    const tags = tokenize('<Link to="/x">a</Link><a :href="url" v-bind:title="t">b</a>');
    expect(tags[0]!.isComponent).toBe(true);
    expect(single(tokenize('<Card.Header/>')).isComponent).toBe(true);
    expect(tokenize("<A HREF='/x'></A>")[0]!.isComponent).toBe(false);
    expect(tokenize('<TITLE>x</TITLE>')[0]!.isComponent).toBe(false);
    const a = tags.find((t) => t.lowerName === 'a' && !t.isClose)!;
    expect(a.isComponent).toBe(false);
    expect(a.hasBinding('href')).toBe(true);
    expect(a.hasBinding('title')).toBe(true);
    expect(a.hasBinding('aria-label')).toBe(false);
  });

  it('brace expressions are string and comment aware', () => {
    const tags = tokenize('<div data-x={"{"} data-y={\'}\'} data-z={`{${a}`}></div><a href="/x"></a>');
    expect(tags.map((t) => t.lowerName)).toEqual(['div', 'div', 'a', 'a']);
    expect(tokenize('<div title={/* } */ t}></div><span></span>')).toHaveLength(4);
  });

  it('spread attributes with arrows and comparisons do not end the tag', () => {
    const tag = single(tokenize('<Btn {...(a > b ? x : y)} onClick={(e) => go(e)} />'));
    expect(tag.hasSpread).toBe(true);
    expect(tag.selfClosing).toBe(true);
    expect(tag.attributes.get('onclick')).toBe('{(e) => go(e)}');
  });

  it('whitespace around equals and unquoted values', () => {
    expect(tokenize('<a href=\n  "#">x</a>')[0]!.attr('href')).toBe('#');
    expect(tokenize('<a href=/pricing>x</a>')[0]!.attr('href')).toBe('/pricing');
    const img = single(tokenize('<img src=/x/>'));
    expect(img.attr('src')).toBe('/x');
    expect(img.selfClosing).toBe(true);
    expect(tokenize('<a href=https://x.org/a>x</a>')[0]!.attr('href')).toBe('https://x.org/a');
  });

  it('JSX and Razor comments are skipped', () => {
    expect(tokenize('{/* <a href="/x"></a> */}')).toEqual([]);
    expect(tokenize('@* <a href="/x"></a> *@')).toEqual([]);
    expect(tokenize('{/* <a></a> */}<b></b>')).toHaveLength(2);
  });

  it('boolAttr is three-valued', () => {
    const t = single(tokenize('<video muted autoplay="false" controls={c} loop={true} hidden={false} :preload="p">'));
    expect(t.boolAttr('muted')).toBe(true);
    expect(t.boolAttr('autoplay')).toBe(false);
    expect(t.boolAttr('controls')).toBeNull();
    expect(t.boolAttr('loop')).toBe(true);
    expect(t.boolAttr('hidden')).toBe(false);
    expect(t.hidden).toBe(false);
    expect(t.boolAttr('preload')).toBeNull();
    expect(t.boolAttr('playsinline')).toBe(false);
  });

  it('document structure - close index, parents, hidden subtrees', () => {
    const doc = parseMarkup('<ul><li>one<li>two</ul><div hidden><a href="/x">h</a></div><p aria-hidden="true"><b>x</b></p>');
    const ul = 0;
    expect(doc.tags[ul]!.lowerName).toBe('ul');
    const close = doc.closeIndex[ul]!;
    expect(close).toBeGreaterThan(ul);
    expect(doc.tags[close]!.isClose).toBe(true);
    const lis = doc.tags.map((t, i) => (t.lowerName === 'li' ? i : -1)).filter((i) => i >= 0);
    expect(doc.parentIndex[lis[1]!]).toBe(ul);
    expect(doc.isHidden(doc.tags.findIndex((t) => t.lowerName === 'a'))).toBe(true);
    expect(doc.isHidden(doc.tags.findIndex((t) => t.lowerName === 'b'))).toBe(true);
    expect(doc.isHidden(ul)).toBe(false);
  });

  it('document visibleText and textByIds', () => {
    const doc = parseMarkup('<h2 id="t">Pricing <span aria-hidden="true">›</span> guide</h2><a href="/x" aria-labelledby="t missing"></a>');
    expect(doc.visibleText(0)).toBe('Pricing guide');
    expect(doc.textByIds('t')).toBe('Pricing guide');
    expect(doc.textByIds('t missing')).toBeNull();
  });

  it('style blocks are recorded with their line and comments are ignored', () => {
    const block = single(parseMarkup('<!-- <style>a{}</style> -->\n<style>\n a:focus { outline: none }\n</style>').styleBlocks());
    expect(block.line).toBe(2);
    expect(block.css).toContain('a:focus');
  });

  it('unterminated input does not crash', () => {
    for (const src of ['<a href="x', '<div', '<', '<!--', '{/*', '<style>', '<a href={x', '</', '<a b=']) {
      expect(() => parseMarkup(src)).not.toThrow();
    }
  });

  it('binding detection and boolean attributes with long values', () => {
    const t = single(tokenize('<div :title="t" v-bind:alt="a" [attr.role]="r" bind:hidden={h} hidden={flag && "' + 'x'.repeat(80) + '"}>'));
    expect(t.hasBinding('title') && t.hasBinding('alt') && t.hasBinding('role') && t.hasBinding('hidden')).toBe(true);
    expect(t.hasBinding('id')).toBe(false);
    expect(t.boolAttr('hidden')).toBeNull();
    expect(single(tokenize('<span hidden="' + 'y'.repeat(500) + '">')).hidden).toBe(true);
    const dyn = single(tokenize('<span hidden={cond && "' + 'y'.repeat(500) + '"}>'));
    expect(dyn.hidden).toBe(false);
    expect(dyn.boolAttr('hidden')).toBeNull();
  });
});
