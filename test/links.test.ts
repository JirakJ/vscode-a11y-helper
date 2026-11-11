import { describe, expect, it } from 'vitest';
import { auditLinksSource as audit, LinkRules } from '../src/core/links';

const rules = (src: string): string[] => audit(src, 't.html').issues.map((i) => i.rule.id);
const EMPTY = [LinkRules.EMPTY.id];
const ms = (start: number): number => performance.now() - start;
const LIMIT = 8_000;

function nested(n: number, inner: string): string {
  let s = '';
  for (let i = 0; i < n; i++) s += `<span id="l${i}">`;
  s += inner;
  s += '</span>'.repeat(n);
  for (let i = 0; i < n; i++) s += `<a href="/x" aria-labelledby="l${i}"></a>`;
  return s;
}

describe('LinkPurposeAuditor', () => {
  it('descriptive link passes', () => {
    const r = audit('<a href="/pricing">See the pricing guide</a>', 't.html');
    expect(r.issues).toEqual([]);
    expect(r.checked).toBe(1);
    expect(r.passed).toBe(1);
  });

  it('empty link is an error with position', () => {
    const r = audit('<p>x</p>\n  <a href="/x"></a>', 't.html');
    expect(r.issues).toHaveLength(1);
    const issue = r.issues[0]!;
    expect(issue.rule.id).toBe(LinkRules.EMPTY.id);
    expect(issue.severity).toBe('ERROR');
    expect(issue.line).toBe(2);
    expect(issue.column).toBe(2);
    expect(r.passed).toBe(0);
  });

  it('icon link named by aria-label or nested img alt passes', () => {
    expect(rules('<a href="/x" aria-label="Open settings"><i class="icon"></i></a>')).toEqual([]);
    expect(rules('<a href="/x"><img src="l.png" alt="Home"></a>')).toEqual([]);
    expect(rules('<a href="/x" aria-labelledby="lbl"></a>')).toEqual([]);
  });

  it('link with only an alt-less image is empty', () => {
    expect(rules('<a href="/x"><img src="l.png" alt=""></a>')).toEqual(EMPTY);
  });

  it('dynamic JSX content is not judged', () => {
    expect(rules("<a href=\"/x\">{t('nav.home')}</a>")).toEqual([]);
    expect(rules('<a href="/x" aria-label={label}></a>')).toEqual([]);
  });

  it('generic link text is advisory regardless of punctuation and case', () => {
    for (const text of ['Click here', 'click here!', 'Read more…', 'here', 'MORE »', 'Learn more →', 'Read&nbsp;more']) {
      const r = audit(`<a href="/x">${text}</a>`, 't.html');
      expect(r.issues.map((i) => i.rule.id), text).toEqual([LinkRules.GENERIC_TEXT.id]);
      expect(r.issues[0]!.severity).toBe('INFO');
      expect(r.passed).toBe(1);
    }
  });

  it('generic visible text rescued by descriptive aria-label', () => {
    expect(rules('<a href="/x" aria-label="Read more about pricing">Read more</a>')).toEqual([]);
  });

  it('raw URL as text is informational', () => {
    const issues = audit('<a href="https://example.com/docs">https://example.com/docs</a>', 't.html').issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule.id).toBe(LinkRules.URL_AS_TEXT.id);
    expect(issues[0]!.severity).toBe('INFO');
  });

  it('placeholder hrefs are flagged unless role button', () => {
    expect(rules('<a href="#" onclick="go()">Save draft</a>')).toEqual([LinkRules.PLACEHOLDER_HREF.id]);
    expect(rules('<a href="javascript:void(0)">Save draft</a>')).toEqual([LinkRules.PLACEHOLDER_HREF.id]);
    expect(rules('<a href="#" role="button">Save draft</a>')).toEqual([]);
    expect(rules('<a href="#main">Skip to content</a>')).toEqual([]);
  });

  it('clickable anchor without href is a keyboard trap', () => {
    const NO = [LinkRules.NO_HREF_CLICKABLE.id];
    expect(rules('<a onclick="open()">Open menu</a>')).toEqual(NO);
    expect(rules('<a onClick={open}>Open menu</a>')).toEqual(NO);
    expect(rules('<a @click="open">Open menu</a>')).toEqual(NO);
    expect(rules('<a onclick="open()" role="button" tabindex="0">Open menu</a>')).toEqual([]);
    expect(rules('<a :href="url">Open menu</a>')).toEqual([]);
    expect(rules('<a name="anchor">Legacy anchor</a>')).toEqual([]);
    expect(rules('<a role="button" onclick="save()">Save</a>')).toEqual(NO);
    expect(rules('<a onclick="save()" tabindex="-1">Save</a>')).toEqual(NO);
    expect(rules('<a @onclick="Save">Save</a>')).toEqual(NO);
  });

  it('new window without warning is informational and can be announced', () => {
    const issues = audit('<a href="https://x.org" target="_blank">Docs</a>', 't.html').issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule.id).toBe(LinkRules.NEW_WINDOW.id);
    expect(issues[0]!.severity).toBe('INFO');
    expect(rules('<a href="https://x.org" target="_blank">Docs (opens in new tab)</a>')).toEqual([]);
    expect(rules('<a href="https://x.org" target="_blank" aria-label="Docs, new window">Docs</a>')).toEqual([]);
    expect(rules('<a href="https://x.org" target="_blank" title="Opens in a new window">Docs</a>')).toEqual([]);
  });

  it('same text pointing to different targets is ambiguous', () => {
    const src = [
      '<a href="/a">Details</a>',
      '<a href="/report-2024">Annual report</a>',
      '<a href="/report-2025">Annual report</a>',
      '<a href="/report-2025">Annual report</a>',
    ].join('\n');
    const dup = audit(src, 't.html').issues.filter((i) => i.rule.id === LinkRules.AMBIGUOUS_DUPLICATE.id);
    expect(dup).toHaveLength(1);
    expect(dup[0]!.line).toBe(3);
    expect(dup[0]!.severity).toBe('INFO');
    expect(dup[0]!.message).toContain('/report-2024');
  });

  it('hidden links and components are ignored', () => {
    expect(rules('<a href="/x" aria-hidden="true"></a><a href="/y" hidden></a><Link to="/z"></Link>')).toEqual([]);
    expect(audit('<Link to="/z">x</Link>', 't.html').checked).toBe(0);
  });

  it('checked and passed count links not issues', () => {
    const src = '<a href="/x">Click here</a>\n<a href="/y" target="_blank">Good link text</a>\n<a href="/z">Another good text</a>';
    const r = audit(src, 't.html');
    expect(r.checked).toBe(3);
    expect(r.passed).toBe(3);
    expect(r.issues.filter((i) => i.severity === 'WARNING')).toHaveLength(0);
    expect(r.issues.filter((i) => i.severity === 'INFO')).toHaveLength(2);
  });

  it('bare named anchors are not links and are not counted', () => {
    const r = audit('<a name="main"></a><a id="top"></a><p>text</p>', 't.html');
    expect(r.issues).toEqual([]);
    expect(r.checked).toBe(0);
  });

  it('aria-labelledby is resolved within the file', () => {
    expect(rules('<h2 id="t">Pricing guide</h2><a href="/x" aria-labelledby="t">Read more</a>')).toEqual([]);
    expect(rules('<a href="/x" aria-labelledby="elsewhere"></a>')).toEqual([]);
    expect(rules('<span id="e"></span><a href="/x" aria-labelledby="e"></a>')).toEqual(EMPTY);
  });

  it('hidden descendants entities and hidden ancestors are handled', () => {
    expect(rules('<a href="/x"><span aria-hidden="true">icon</span></a>')).toEqual(EMPTY);
    expect(rules('<a href="/x">&nbsp;</a>')).toEqual(EMPTY);
    expect(rules('<a href="/x"><span aria-hidden="true">icon</span><span class="sr-only">Settings</span></a>')).toEqual([]);
    const hidden = audit('<div hidden><a href="/x"></a></div><div hidden={false}><a href="/y">Ok link</a></div>', 't.jsx');
    expect(hidden.issues).toEqual([]);
    expect(hidden.checked).toBe(1);
  });

  it('JSX and Razor comments and quoted braces do not produce findings', () => {
    expect(rules('{/* <a href="/x"></a> */}<a href="/y">Fine</a>')).toEqual([]);
    expect(rules('@* <a href="/x"></a> *@<a href="/y">Fine</a>')).toEqual([]);
    expect(rules('<div data-x={"{"}></div><a href="/x"></a>')).toEqual(EMPTY);
    expect(rules('<Btn {...(a > b ? x : y)} /><a href="/x"></a>')).toEqual(EMPTY);
  });

  it('legacy uppercase HTML and unquoted attribute values are parsed', () => {
    expect(rules('<A HREF="/x"></A>')).toEqual(EMPTY);
    expect(rules('<a href=/pricing>Pricing overview</a>')).toEqual([]);
    expect(rules('<a href=\n"#" onclick="go()">Save draft</a>')).toEqual([LinkRules.PLACEHOLDER_HREF.id]);
  });

  it('dynamic name sources are unknown rather than empty', () => {
    expect(rules('<a href="/x" v-text="label"></a>')).toEqual([]);
    expect(rules('<a href="/x" :title="t"></a>')).toEqual([]);
    expect(rules('<a href="/x"><Icon /></a>')).toEqual([]);
  });

  it('regex literals and nested templates inside JSX expressions do not swallow the file', () => {
    expect(rules('<div data-x={/{/.test(x)}></div><a href="/x"></a>')).toEqual(EMPTY);
    expect(rules("<div title={`${a ? `{` : ''}`}></div><a href=\"/x\"></a>")).toEqual(EMPTY);
    expect(rules('<div title={a / b}></div><a href="/x"></a>')).toEqual(EMPTY);
    expect(rules('<div x={"unterminated}></div><a href="/x"></a>')).toEqual(EMPTY);
  });

  it('invalid numeric entities do not abort the audit', () => {
    rules('<a href="/x">&#x110000;</a>');
    expect(rules('<a href="/x">&#1114112;&#xD800; ok</a>')).toEqual([]);
    expect(rules('<a href="/x">&#xA0;&#8203;</a>')).toEqual(EMPTY);
  });

  it('comments are not accessible names', () => {
    expect(rules('<a href="/x"><!-- TODO label --></a>')).toEqual(EMPTY);
    expect(rules('<a href="/x">{/* TODO label */}</a>')).toEqual(EMPTY);
  });

  it('unclosed and implicitly closed elements keep their boundaries', () => {
    expect(rules('<div><a href="/x"></div><p>Unrelated text</p>')).toEqual(EMPTY);
    expect(rules('<p hidden><div><a href="/x"></a></div>')).toEqual(EMPTY);
    expect(rules('<p hidden><a href="/x"></a><div><a href="/y">Visible</a></div>')).toEqual([]);
    expect(rules('<table><tr><td>a<tr aria-hidden="true"><td><a href="/x"></a></table><a href="/y">Ok</a>')).toEqual([]);
  });

  it('framework name sources are unknown, framework navigation is a link', () => {
    expect(rules('<a href="/x"><img src="i.png" alt={label} /></a>')).toEqual([]);
    expect(rules('<a href="/x"><img src="i.png" :alt="label"></a>')).toEqual([]);
    expect(rules('<a href="/x" :aria-labelledby="id"></a>')).toEqual([]);
    expect(rules('<a href="/x" v-bind="attrs"></a>')).toEqual([]);
    expect(rules('<div aria-hidden={true}><a href="/x"></a></div>')).toEqual([]);
    expect(rules('<a asp-controller="Home" asp-action="Index"></a>')).toEqual(EMPTY);
    expect(rules('<a routerLink="/x"></a>')).toEqual(EMPTY);
  });

  it('JSX string with escaped newline keeps line numbers', () => {
    const src = '<div title={"a\\\nb"}></div>\n\n<a href="/x"></a>';
    const issues = audit(src, 't.jsx').issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(4);
  });

  it('hidden void children do not erase sibling text', () => {
    expect(rules('<a href="/x"><img src="i.svg" aria-hidden="true"><span>Save</span></a>')).toEqual([]);
    expect(rules('<a href="/x"><svg aria-hidden="true" /><span>Save</span></a>')).toEqual([]);
    expect(rules('<a href="/x"><svg aria-hidden="true"><path d="M0"/></svg>Save</a>')).toEqual([]);
  });

  it('deep template substitutions and repeated broken expressions stay bounded', { timeout: 60_000 }, () => {
    const deep = '<div title={' + '`${'.repeat(5_000) + '1' + '}`'.repeat(5_000) + '}></div><iframe src="x"></iframe><a href="/x"></a>';
    audit(deep, 'deep.jsx');
    const broken = '<div x={/*}></div>\n'.repeat(20_000) + '<a href="/x"></a>';
    let t = performance.now();
    audit(broken, 'broken.jsx');
    expect(ms(t)).toBeLessThan(LIMIT);
    const stray = '<div>'.repeat(20_000) + '</span>'.repeat(20_000) + '<a href="/x"></a>';
    t = performance.now();
    expect(rules(stray)).toEqual(EMPTY);
    expect(ms(t)).toBeLessThan(LIMIT);
  });

  it('many aria-labelledby lookups are linear', { timeout: 60_000 }, () => {
    let src = '';
    for (let i = 0; i < 20_000; i++) src += `<span id="l${i}">Label ${i}</span><a href="/x" aria-labelledby="l${i}"></a>\n`;
    const t = performance.now();
    expect(audit(src, 'many.html').issues).toEqual([]);
    expect(ms(t)).toBeLessThan(LIMIT);
  });

  it('Razor comments and textarea content are not link text', () => {
    expect(rules('<a href="/x">@* label *@</a>')).toEqual(EMPTY);
    expect(rules('<textarea><a href="/x"></a></textarea>')).toEqual([]);
  });

  it('thousands of references to one huge label stay cheap', { timeout: 60_000 }, () => {
    const src = '<span id="l">' + 'a'.repeat(100_000) + '</span>' + '<a href="/x" aria-labelledby="l"></a>'.repeat(6_000);
    const t = performance.now();
    const r = audit(src, 'big.html');
    expect(r.issues).toEqual([]);
    expect(r.checked).toBe(6_000);
    expect(ms(t)).toBeLessThan(LIMIT);
  });

  it('unknown labels are cached and truncated names are never compared', { timeout: 60_000 }, () => {
    const src = '<span id="l">' + '<span></span>'.repeat(4_000) + '<span aria-label={label}></span></span>' + '<a href="/x" aria-labelledby="l"></a>'.repeat(4_000);
    const t = performance.now();
    expect(audit(src, 't.jsx').issues).toEqual([]);
    expect(ms(t)).toBeLessThan(LIMIT);
    const long1 = 'x'.repeat(2_500) + 'one';
    const long2 = 'x'.repeat(2_500) + 'two';
    expect(rules(`<a href="/1">${long1}</a><a href="/2">${long2}</a>`)).toEqual([]);
  });

  it('distinct overlapping labels resolve in linear time', { timeout: 60_000 }, () => {
    const n = 8_000;
    const src = nested(n, 'text');
    const t = performance.now();
    const r = audit(src, 't.html');
    expect(r.issues).toEqual([]);
    expect(r.checked).toBe(n);
    expect(ms(t)).toBeLessThan(LIMIT);
  });

  it('huge referenced text is not copied per reference', { timeout: 60_000 }, () => {
    const n = 1_000;
    const t = performance.now();
    expect(audit(nested(n, 'x'.repeat(n * 1000)), 't.html').issues).toEqual([]);
    expect(ms(t)).toBeLessThan(LIMIT);
  });

  it('huge attribute names are not copied per referencing ancestor', { timeout: 60_000 }, () => {
    const n = 1_000;
    for (const inner of ['<img src="i.png" alt="' + 'x'.repeat(n * 1000) + '">', '<span aria-label="' + 'x'.repeat(n * 1000) + '"></span>']) {
      const t = performance.now();
      expect(audit(nested(n, inner), 't.html').issues).toEqual([]);
      expect(ms(t)).toBeLessThan(LIMIT);
    }
  });

  it('diagnostics never quote megabyte destinations and padded attributes stay cheap', { timeout: 60_000 }, () => {
    const dataUrl = 'data:image/png;base64,' + 'A'.repeat(1_000_000);
    let src = `<a href="${dataUrl}">Report</a>`;
    for (let i = 1; i <= 1_000; i++) src += `<a href="/r${i}">Report</a>`;
    let t = performance.now();
    const r = audit(src, 't.html');
    expect(r.issues.every((i) => i.message.length < 600)).toBe(true);
    expect(ms(t)).toBeLessThan(LIMIT);
    const n = 1_000;
    t = performance.now();
    expect(audit(nested(n, '<img src="i.png" alt=" ' + 'x'.repeat(n * 1000) + '">'), 't.html').issues).toEqual([]);
    expect(ms(t)).toBeLessThan(LIMIT);
  });

  it('whitespace-heavy and long boolean attributes inside labels stay linear', { timeout: 60_000 }, () => {
    const n = 1_000;
    let t = performance.now();
    expect(audit(nested(n, '<img src="i.png" alt="' + ' '.repeat(n * 1000) + 'x">'), 't.html').issues).toEqual([]);
    expect(ms(t)).toBeLessThan(LIMIT);
    t = performance.now();
    expect(audit(nested(n, '<span hidden={flag && "' + 'X'.repeat(n * 1000) + '"}>Visible</span>'), 't.jsx').issues).toEqual([]);
    expect(ms(t)).toBeLessThan(LIMIT);
  });

  it('long tag names and huge attribute lists inside labels stay cheap', { timeout: 60_000 }, () => {
    const n = 1_000;
    let t = performance.now();
    audit(nested(n, '<X-' + 'X'.repeat(n * 1000) + '/>'), 't.jsx');
    expect(ms(t)).toBeLessThan(LIMIT);
    const attrs: string[] = [];
    for (let i = 1; i <= n * 70; i++) attrs.push(`data-x${i}="v"`);
    t = performance.now();
    audit(nested(n, '<span ' + attrs.join(' ') + '></span>'), 't.html');
    expect(ms(t)).toBeLessThan(LIMIT);
  });

  it('a descendant named by static aria-labelledby names the link', () => {
    expect(rules('<span id="x">Save</span><a href="/"><img aria-labelledby="x" alt=""></a>')).toEqual([]);
    expect(rules('<a href="/"><img aria-labelledby="elsewhere" alt=""></a>')).toEqual([]);
    expect(rules('<span id="e"></span><a href="/"><img aria-labelledby="e" alt=""></a>')).toEqual(EMPTY);
  });

  it('a static aria-label after a spread makes the link definite', () => {
    const r = audit('<a href="/x" {...rest} aria-label="Docs"></a><a href="/y" aria-label="Docs" {...rest}></a>', 't.jsx');
    expect(r.checked).toBe(1);
    expect(r.issues).toEqual([]);
    expect(rules('<a href="#" {...rest} aria-label="Docs"></a>')).toEqual([]);
    expect(rules('<a href="/x" target="_blank" {...rest} aria-label="Docs"></a>')).toEqual([]);
    expect(rules('<a {...rest} href="#" aria-label="Docs"></a>')).toEqual([LinkRules.PLACEHOLDER_HREF.id]);
    expect(rules('<a href="/x" {disabled}></a>')).toEqual(EMPTY);
    expect(rules('<a {...rest} href="#" {...rest} aria-label="Docs"></a>')).toEqual([]);
    expect(rules('<a {...rest} target="_blank" {...rest} aria-label="Docs" href="/x"></a>')).toEqual([]);
    expect(audit('<a href="/x" aria-label="Docs" {...rest}></a>', 't.jsx').checked).toBe(0);
    expect(rules('<a href="/x" {...rest} href="#" aria-label="Docs"></a>')).toEqual([LinkRules.PLACEHOLDER_HREF.id]);
  });
});
