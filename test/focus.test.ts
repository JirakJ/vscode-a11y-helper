import { describe, expect, it } from 'vitest';
import { auditFocusCss, auditFocusMarkup, FocusRules } from '../src/core/focus';

const markupRules = (src: string): string[] => auditFocusMarkup(src, 't.html').issues.map((i) => i.rule.id);
const cssRules = (css: string): string[] => auditFocusCss(css, 't.css').issues.map((i) => i.rule.id);
const single = <T>(arr: readonly T[]): T => {
  expect(arr).toHaveLength(1);
  return arr[0]!;
};
const OUT = [FocusRules.OUTLINE_SUPPRESSED.id];
const NOT_FOCUSABLE = [FocusRules.CLICK_NOT_FOCUSABLE.id];

describe('KeyboardFocusAuditor — markup', () => {
  it('native button with click handler is fine', () => {
    const report = auditFocusMarkup('<button onclick="save()">Save</button>', 't.html');
    expect(report.issues).toEqual([]);
    expect(report.checked).toBe(1);
    expect(report.passed).toBe(1);
  });

  it('positive tabindex is a warning, zero and minus one pass', () => {
    const issue = single(auditFocusMarkup('<input tabindex="3">', 't.html').issues);
    expect(issue.rule.id).toBe(FocusRules.POSITIVE_TABINDEX.id);
    expect(issue.severity).toBe('WARNING');
    expect(markupRules('<div tabindex="0"></div><div tabindex="-1"></div>')).toEqual([]);
    expect(markupRules('<div tabIndex={5}></div>')).toEqual([FocusRules.POSITIVE_TABINDEX.id]);
    expect(markupRules('<div tabIndex={props.order}></div>')).toEqual([]);
  });

  it('click on div without tabindex is not focusable', () => {
    const issue = single(auditFocusMarkup('<p>x</p>\n<div onclick="open()">Open</div>', 't.html').issues);
    expect(issue.rule.id).toBe(FocusRules.CLICK_NOT_FOCUSABLE.id);
    expect(issue.severity).toBe('WARNING');
    expect(issue.line).toBe(2);
    expect(markupRules('<span onClick={open}>Open</span>')).toEqual(NOT_FOCUSABLE);
    expect(markupRules('<li @click="select">Item</li>')).toEqual(NOT_FOCUSABLE);
    expect(markupRules('<div on:click={open}>Open</div>')).toEqual(NOT_FOCUSABLE);
    expect(markupRules('<div (click)="open()">Open</div>')).toEqual(NOT_FOCUSABLE);
  });

  it('focusable clickable div without role is announced as text', () => {
    expect(markupRules('<div onclick="open()" tabindex="0">Open</div>')).toEqual([FocusRules.CLICK_NO_ROLE.id]);
  });

  it('complete custom button only gets an info until it handles keys', () => {
    const issue = single(auditFocusMarkup('<div role="button" tabindex="0" onclick="open()">Open</div>', 't.html').issues);
    expect(issue.rule.id).toBe(FocusRules.CLICK_NO_KEY_HANDLER.id);
    expect(issue.severity).toBe('INFO');
    expect(markupRules('<div role="button" tabindex="0" onclick="open()" onkeydown="k(event)">Open</div>')).toEqual([]);
    expect(markupRules('<div role="button" tabIndex={0} onClick={open} onKeyDown={onKey}>Open</div>')).toEqual([]);
  });

  it('composite widget items and presentational roles are exempt', () => {
    expect(markupRules('<li role="option" onclick="pick()">A</li>')).toEqual([]);
    expect(markupRules('<div role="tab" onclick="show()">Tab</div>')).toEqual([]);
    expect(markupRules('<div role="presentation" onclick="stop(event)"></div>')).toEqual([]);
  });

  it('autofocus is informational', () => {
    const report = auditFocusMarkup('<input autofocus name="q">', 't.html');
    expect(report.issues.map((i) => i.rule.id)).toEqual([FocusRules.AUTOFOCUS.id]);
    expect(single(report.issues).severity).toBe('INFO');
    expect(report.passed).toBe(1);
  });

  it('hidden elements and components are skipped', () => {
    const report = auditFocusMarkup('<div onclick="x()" aria-hidden="true"></div><Card onClick={x} />', 't.html');
    expect(report.checked).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it('negative tabindex does not make a clickable div reachable', () => {
    const issue = single(auditFocusMarkup('<div role="button" tabindex="-1" onclick="go()" onkeydown="k()">Go</div>', 't.html').issues);
    expect(issue.rule.id).toBe(FocusRules.CLICK_NOT_FOCUSABLE.id);
    expect(markupRules('<div role="button" tabindex={0} onClick={go} onKeyDown={k}>Go</div>')).toEqual([]);
    expect(markupRules('<div role="button" :tabindex="ti" @click="go" @keydown.enter="go">Go</div>')).toEqual([]);
    expect(markupRules('<div @onclick="Go">Go</div>')).toEqual(NOT_FOCUSABLE);
  });

  it('hidden false keeps the element in scope', () => {
    expect(markupRules('<div hidden={false} onClick={go}>Go</div>')).toEqual(NOT_FOCUSABLE);
  });

  it('styles inside HTML comments are ignored', () => {
    expect(auditFocusMarkup('<!-- <style>a:focus{outline:none}</style> -->\n<a href="/">x</a>', 't.html').issues).toEqual([]);
  });

  it('embedded style blocks are audited with document line numbers', () => {
    const html = '<html>\n<head>\n<style>\n  a { color: red }\n  a:focus { outline: none }\n</style>\n</head>\n<body><a href="/">x</a></body></html>';
    const report = auditFocusMarkup(html, 't.html');
    const issue = single(report.issues);
    expect(issue.rule.id).toBe(FocusRules.OUTLINE_SUPPRESSED.id);
    expect(issue.line).toBe(5);
    expect(report.checked).toBe(1);
    expect(report.passed).toBe(0);
  });

  it('inline style column is offset by the style tag', () => {
    const inline = single(auditFocusMarkup('<style>a:focus{outline:none}</style>', 't.html').issues);
    expect(inline.line).toBe(1);
    expect(inline.column).toBe(7);
  });

  it('deeply nested markup does not overflow', () => {
    const src = '<div>'.repeat(30_000) + '<div onclick="go()">x</div>' + '</div>'.repeat(30_000);
    expect(markupRules(src)).toEqual(NOT_FOCUSABLE);
  });

  it('event delegation containers, labels and runtime roles are not custom controls', () => {
    expect(markupRules('<div onclick="event.stopPropagation()"><button>Save</button></div>')).toEqual([]);
    expect(markupRules('<div onClick={track}><a href="/x">Pricing</a></div>')).toEqual([]);
    expect(markupRules('<label onclick="track()">Name <input name="n"></label>')).toEqual([]);
    expect(markupRules('<div :role="role" tabindex="0" @click="go" @keydown.enter="go">Go</div>')).toEqual([]);
    expect(markupRules('<div onclick="go()"><span>Go</span></div>')).toEqual(NOT_FOCUSABLE);
  });

  it('nested click containers are checked in near-linear time', () => {
    const src = '<div onClick={f}>'.repeat(8_000) + '<button>x</button>' + '</div>'.repeat(8_000);
    const started = Date.now();
    expect(auditFocusMarkup(src, 'deep.jsx').issues).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('KeyboardFocusAuditor — CSS', () => {
  it('outline none without replacement is a warning with the right line', () => {
    const css = 'body { margin: 0; }\n\na:focus {\n  outline: none;\n}';
    const report = auditFocusCss(css, 't.css');
    const issue = single(report.issues);
    expect(issue.rule.id).toBe(FocusRules.OUTLINE_SUPPRESSED.id);
    expect(issue.severity).toBe('WARNING');
    expect(issue.line).toBe(3);
    expect(report.checked).toBe(1);
    expect(report.passed).toBe(0);
  });

  it('outline zero and important variants are caught', () => {
    expect(cssRules('button:focus { outline: 0; }')).toEqual(OUT);
    expect(cssRules('*:focus { outline: none !important; }')).toEqual(OUT);
    expect(cssRules('.btn { outline: 0px }')).toEqual(OUT);
  });

  it('visible replacement in the same block is accepted', () => {
    expect(cssRules('a:focus { outline: none; box-shadow: 0 0 0 3px #005fcc; }')).toEqual([]);
    expect(cssRules('a:focus { outline: none; border-color: blue; }')).toEqual([]);
    expect(cssRules('input:focus { outline: none; background-color: #ffd; }')).toEqual([]);
    expect(cssRules('a:focus { outline: none; box-shadow: none; }')).toEqual(OUT);
  });

  it('focus-visible reset pattern is accepted and visible outlines pass', () => {
    expect(cssRules('a:focus:not(:focus-visible) { outline: none; }')).toEqual([]);
    expect(cssRules('button:focus-visible { outline: 2px solid #005fcc; }')).toEqual([]);
    const report = auditFocusCss('button:focus-visible { outline: 2px solid #005fcc; }', 't.css');
    expect(report.checked).toBe(1);
    expect(report.passed).toBe(1);
  });

  it('comments and at-rules do not confuse the parser', () => {
    const css = '/* a:focus { outline: none } */\n@media (min-width: 600px) {\n  a:focus { outline: none; }\n}';
    expect(single(auditFocusCss(css, 't.scss').issues).line).toBe(3);
  });

  it('non-visible declarations are not accepted as replacements', () => {
    expect(cssRules('a:focus { outline: none; outline-offset: 2px; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: none; box-shadow: 0 0 transparent; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: none; box-shadow: 0 0 0 0 #000; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: none; box-shadow: inset 0 0 0 2px currentColor; }')).toEqual([]);
    expect(cssRules('a:focus { outline: none; outline-style: solid; outline-width: 2px; }')).toEqual([]);
  });

  it('declaration order and importance decide the effective outline', () => {
    expect(cssRules('a:focus { outline: 2px solid blue; outline: none; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: none; outline: 2px solid blue; }')).toEqual([]);
    expect(cssRules('a:focus { outline: 2px solid blue !important; outline: none; }')).toEqual([]);
  });

  it('selector lists are evaluated per member', () => {
    const issue = single(auditFocusCss('a:focus:not(:focus-visible), button:focus { outline: none; }', 't.css').issues);
    expect(issue.rule.id).toBe(FocusRules.OUTLINE_SUPPRESSED.id);
    expect(issue.message).toContain('button:focus');
    expect(cssRules('a:focus:not(:focus-visible), button:focus:not(:focus-visible) { outline: none; }')).toEqual([]);
  });

  it('nested SCSS parent declarations are not lost', () => {
    const css = 'a:focus {\n  outline: none;\n  &:hover { color: red; }\n}';
    const report = auditFocusCss(css, 't.scss');
    expect(report.issues.map((i) => i.rule.id)).toEqual(OUT);
    expect(single(report.issues).line).toBe(1);
    expect(report.checked).toBe(1);
    expect(cssRules('.nav { a { &:focus { outline: 0 } } }')).toEqual(OUT);
  });

  it('focus-visible styling elsewhere downgrades the reset to informational', () => {
    const css = 'button { outline: none; }\nbutton:focus-visible { outline: 3px solid #005fcc; }';
    const report = auditFocusCss(css, 't.css');
    const issue = single(report.issues);
    expect(issue.rule.id).toBe(FocusRules.OUTLINE_SUPPRESSED.id);
    expect(issue.severity).toBe('INFO');
    expect(report.checked).toBe(2);
    expect(report.passed).toBe(2);
  });

  it('url() bodies are ignored', () => {
    expect(cssRules("a:focus { background: url('x;}{.png'); outline: 2px solid red; }")).toEqual([]);
    expect(auditFocusCss("a:focus { background: url('x;}{.png'); outline: 2px solid red; }", 't.css').checked).toBe(1);
  });

  it('large brace-free stylesheets are processed in linear time', () => {
    let css = '';
    for (let i = 0; i < 20_000; i++) css += `/* filler comment ${i} */\n`;
    const started = Date.now();
    expect(auditFocusCss(css + 'a:focus { outline: none }', 'big.css').issues).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('malformed and hostile stylesheets never throw', () => {
    for (const css of ['a:focus {', 'a:focus { outline: none', '}', '{', 'a { b { c {', 'a:focus { outline: none; ', '', '  ', '/* unterminated', 'a { background: url("x', "a { content: '"]) {
      expect(() => auditFocusCss(css, 't.css')).not.toThrow();
    }
    const deep = 'a{'.repeat(20_000) + 'outline:none' + '}'.repeat(20_000);
    expect(() => auditFocusCss(deep, 'deep.css')).not.toThrow();
  });

  it('double slash inside url() and strings is not a comment', () => {
    expect(cssRules('a{background:url("//cdn.example/a.png")}button:focus{outline:none}')).toEqual(OUT);
    expect(cssRules('a:focus { content: "//"; outline: 2px solid red; }')).toEqual([]);
  });

  it('effective replacement declarations and invisible outlines', () => {
    expect(cssRules('a:focus { outline: none; box-shadow: 0 0 0 2px red; box-shadow: none; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: none; outline-width: 2px; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: 0 solid red; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: none; outline-style: solid; outline-width: 0; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: none; box-shadow: none; box-shadow: 0 0 0 2px red; }')).toEqual([]);
  });

  it('nested selector lists combine every parent with every child', () => {
    expect(cssRules('a:focus, button:focus { &:not(:focus-visible) { outline: none } }')).toEqual([]);
    const issue = single(auditFocusCss('a:focus, button:focus { &:hover { outline: none } }', 't.scss').issues);
    expect(issue.message).toContain('a:focus:hover');
    expect(issue.message).toContain('button:focus:hover');
  });

  it('CR-only line endings are located', () => {
    expect(single(auditFocusCss('body{}\ra:focus{outline:none}', 't.css').issues).line).toBe(2);
  });

  it('nested selector lists cannot exhaust memory and diagnostics stay short', () => {
    const css = '.a,.b{'.repeat(23) + 'outline:none' + '}'.repeat(23);
    const issue = single(auditFocusCss(css, 't.scss').issues);
    expect(issue.message.length).toBeLessThan(400);
  });

  it('large stylesheets locate diagnostics in linear time', () => {
    let css = '';
    for (let i = 0; i < 30_000; i++) css += `.r${i}:focus { outline: none }\n`;
    const started = Date.now();
    const report = auditFocusCss(css, 'big.css');
    expect(report.issues).toHaveLength(30_000);
    expect(report.issues[report.issues.length - 1]!.line).toBe(30_000);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('colour functions are not widths and alpha-zero colours are transparent', () => {
    expect(cssRules('a:focus { outline: 2px solid rgb(0 0 0); }')).toEqual([]);
    expect(cssRules('a:focus { outline: 2px solid rgba(0,0,0,0); }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: none; box-shadow: 0 0 0 2px rgba(0, 0, 0, 0); }')).toEqual(OUT);
  });

  it('outline longhands and importance are resolved together', () => {
    expect(cssRules('a:focus { outline: none !important; outline-style: solid; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: 0; outline-style: solid; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline-width: 0; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline-style: none; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: 2px solid red; outline-style: none; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: 0; outline-style: solid; outline-width: 2px; }')).toEqual([]);
    expect(auditFocusCss('a:focus { outline-width: 0; }', 't.css').checked).toBe(1);
  });

  it('commas inside selector functions are not list separators', () => {
    expect(cssRules('a:is(:hover,:active):not(:focus-visible){outline:none}')).toEqual([]);
    expect(cssRules('a:is(:hover,:active){outline:none}')).toEqual(OUT);
  });

  it('repeated ampersands cannot expand selectors exponentially', () => {
    const css = '.a{' + '&&{'.repeat(27) + 'outline:none' + '}'.repeat(28);
    const issue = single(auditFocusCss(css, 't.scss').issues);
    expect(issue.message.length).toBeLessThan(400);
    expect(auditFocusMarkup('<style>' + css + '</style>', 't.jsx').issues).toHaveLength(1);
  });

  it('opaque comma rgb is not transparent and the outline cascade respects importance and order', () => {
    expect(cssRules('a:focus { outline: 2px solid rgb(0,0,0); }')).toEqual([]);
    expect(cssRules('a:focus { outline: 2px solid rgb(255, 0, 0); }')).toEqual([]);
    expect(cssRules('a:focus { outline: 2px solid rgba(255, 0, 0, 0); }')).toEqual(OUT);
    expect(cssRules('a:focus { outline: 2px solid blue !important; outline-style: none; }')).toEqual([]);
    expect(cssRules('a:focus { outline-width: 0; outline: 2px solid blue; }')).toEqual([]);
    expect(cssRules('a:focus { outline: 2px solid blue; outline-color: transparent; }')).toEqual(OUT);
    expect(cssRules('a:focus { outline-style: solid; outline-width: 0 !important; outline-width: 2px; }')).toEqual(OUT);
  });

  it('malformed selector lists take the bounded path too', () => {
    const css = ',{' + '&&{'.repeat(27) + 'outline:none' + '}'.repeat(28);
    const report = auditFocusMarkup(`<style>${css}</style>`, 't.jsx');
    expect(report.issues.length).toBeLessThanOrEqual(1);
    expect(report.issues.every((i) => i.message.length < 400)).toBe(true);
  });

  it('alpha detection is linear in whitespace', () => {
    const css = '.a{outline:2px solid rgb(' + ' '.repeat(3_000) + '0 0 0)}';
    const started = Date.now();
    expect(auditFocusCss(css, 't.css').issues).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cssRules('.a{outline:2px solid rgb(0 0 0 / 0)}')).toEqual(OUT);
    expect(cssRules('.a{outline:2px solid hsla(0, 0%, 0%, 0)}')).toEqual(OUT);
    expect(cssRules('.a{outline:2px solid hsl(0, 0%, 0%)}')).toEqual([]);
  });

  it('box-shadow length detection is linear', () => {
    const css = 'a:focus{outline:none;box-shadow:' + '1'.repeat(8_000) + 'vh 0 red}';
    const started = Date.now();
    expect(auditFocusCss(css, 't.css').issues).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
    expect(cssRules('a:focus{outline:none;box-shadow:0 0 0 .5rem red}')).toEqual([]);
    expect(cssRules('a:focus{outline:none;box-shadow:0 0 0 0vh red}')).toEqual(OUT);
  });

  it('stylesheets nested beyond the parser depth report incomplete analysis', () => {
    const css = 'a{'.repeat(300) + 'outline:none' + '}'.repeat(300);
    const report = auditFocusCss(css, 'deep.scss');
    expect(report.issues.map((i) => i.rule.id)).toEqual([FocusRules.ANALYSIS_INCOMPLETE.id]);
    expect(single(report.issues).severity).toBe('INFO');
    expect(report.checked).toBe(0);
  });

  it('huge parent selectors are cut before nested rules are combined', () => {
    const n = 1_000;
    let children = '';
    for (let i = 1; i <= n; i++) children += `.c${i}{outline:none}`;
    const css = '.' + 'x'.repeat(n * 1000) + '{' + children + '}';
    const started = Date.now();
    const report = auditFocusCss(css, 'big.scss');
    expect(report.issues).toHaveLength(n);
    expect(report.issues.every((i) => i.message.length < 5_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('nested sibling blocks under a long parent list stay linear', () => {
    const parent = Array.from({ length: 400 }, (_, i) => `.s${i}`).join(',');
    const css = parent + '{' + 'b{c{x:0}}'.repeat(200_000) + '}';
    const started = Date.now();
    expect(auditFocusCss(css, 'nested.scss').issues).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
