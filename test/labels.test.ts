import { describe, expect, it } from 'vitest';
import {
  aggregateLabelReports,
  auditLabels,
  NameResolution,
  resolveAccessibleName,
  scanInteractiveElements,
} from '../src/core/labels';

const scan = scanInteractiveElements;
const single = <T>(xs: readonly T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0]!;
};

describe('scanInteractiveElements', () => {
  it('detects each native interactive tag', () => {
    const src = [
      '<button>Go</button>',
      '<a href="/x">x</a>',
      '<input type="text"/>',
      '<textarea></textarea>',
      '<select></select>',
      '<summary>More</summary>',
      '<details></details>',
    ].join('\n');
    expect(scan(src).map((e) => e.tag.toLowerCase())).toEqual(['button', 'a', 'input', 'textarea', 'select', 'summary', 'details']);
  });

  it('anchor without href is not interactive', () => {
    expect(scan('<a>hi</a>')).toEqual([]);
  });

  it('anchor with href is interactive', () => {
    const res = scan('<a href="/foo">hi</a>');
    expect(res).toHaveLength(1);
    expect(res[0]!.attributes.get('href')).toBe('/foo');
  });

  it('input type hidden is skipped', () => {
    const res = scan('<input type="hidden" name="_t"/><input type="text"/>');
    expect(single(res).attributes.get('type')).toBe('text');
  });

  it('role-based detection picks up non-native interactive', () => {
    const res = scan('<div role="button">X</div><span role="switch">s</span>');
    expect(res.map((e) => e.role)).toEqual(['button', 'switch']);
  });

  it('aria-hidden true, hidden and presentation/none skip element', () => {
    expect(scan('<button aria-hidden="true">x</button>')).toEqual([]);
    expect(scan('<button hidden>x</button>')).toEqual([]);
    expect(scan('<a href="/x" hidden>x</a>')).toEqual([]);
    expect(scan('<button role="presentation">x</button>')).toEqual([]);
    expect(scan('<button role="none">x</button>')).toEqual([]);
  });

  it('aria-hidden=false does not skip element', () => {
    expect(scan('<button aria-hidden="false">x</button>')).toHaveLength(1);
  });

  it('JSX PascalCase component is not native interactive unless it has a role', () => {
    expect(scan('<Button onClick={handler}>x</Button><Link href="/x">x</Link>')).toEqual([]);
    const el = single(scan('<MyWidget role="button">Go</MyWidget>'));
    expect(el.tag).toBe('MyWidget');
    expect(el.role).toBe('button');
  });

  it('line and column are correct for multi-line LF', () => {
    const el = single(scan('\nhi\n<button>X</button>'));
    expect([el.line, el.column, el.startOffset, el.rawTag]).toEqual([3, 0, 4, '<button>']);
  });

  it('line and column are correct for CRLF', () => {
    const els = scan('\r\n<button/>\r\n<a href="#">hi</a>');
    expect(els.map((e) => [e.line, e.column])).toEqual([[2, 0], [3, 0]]);
  });

  it('column is 0-based and indentation-aware', () => {
    expect(single(scan('<button>a</button>')).column).toBe(0);
    expect(single(scan('    <button>a</button>')).column).toBe(4);
    const el = single(scan('abc\ndef\n  <button>X</button>'));
    expect([el.startOffset, el.line, el.column]).toEqual([10, 3, 2]);
  });

  it('nested interactive elements are reported in source order', () => {
    const src = '<div>\n  <button>A</button>\n  <details>\n    <summary>S</summary>\n    <a href="/">L</a>\n  </details>\n</div>';
    expect(scan(src).map((e) => e.tag.toLowerCase())).toEqual(['button', 'details', 'summary', 'a']);
  });

  it('rawTag, offsets and attributes are verbatim', () => {
    const el = single(scan('<button class="x" id="y" data-x="Hello World">X</button>'));
    expect(el.rawTag).toBe('<button class="x" id="y" data-x="Hello World">');
    expect(el.attributes.get('class')).toBe('x');
    expect(el.attributes.get('data-x')).toBe('Hello World');
    const b = single(scan('<button>X</button>'));
    expect([b.startOffset, b.endOffset]).toEqual([0, 8]);
  });

  it('self-closing tag is captured', () => {
    expect(single(scan('<input type="text" aria-label="Name"/>')).rawTag.endsWith('/>')).toBe(true);
  });

  it('script bodies and comments are ignored', () => {
    const src = '<script>\n  // <button>fake</button>\n  const x = \'<a href="#">nope</a>\';\n</script>\n<button>real</button>';
    expect(scan(src).map((e) => e.tag)).toEqual(['button']);
    expect(scan('<!-- <button>no</button> --><button>yes</button>').map((e) => e.tag)).toEqual(['button']);
  });

  it('unsupported role, role normalisation, null role, empty and unclosed input', () => {
    expect(scan('<div role="banner">x</div>')).toEqual([]);
    expect(single(scan('<a role="link">go</a>')).role).toBe('link');
    expect(single(scan('<div role="  BUTTON  ">x</div>')).role).toBe('button');
    expect(single(scan('<button>x</button>')).role).toBeNull();
    expect(scan('')).toEqual([]);
    expect(scan('<button')).toEqual([]);
  });
});

describe('resolveAccessibleName', () => {
  const resolve = (src: string): NameResolution => resolveAccessibleName(single(scan(src)), src);

  it('aria-labelledby wins over aria-label and title', () => {
    expect(resolve('<button aria-labelledby="h1" aria-label="label" title="t">x</button>'))
      .toEqual({ source: 'ARIA_LABELLEDBY', value: 'h1', isEmpty: false });
  });

  it('aria-label wins over title and text content', () => {
    expect(resolve('<button aria-label="Close dialog" title="Close">X</button>')).toMatchObject({ source: 'ARIA_LABEL', value: 'Close dialog' });
  });

  it('empty and whitespace aria-label fall through', () => {
    expect(resolve('<button aria-label="" title="Fallback">  </button>')).toMatchObject({ source: 'TITLE', value: 'Fallback' });
    expect(resolve('<button aria-label="   " title="Help">x</button>')).toMatchObject({ source: 'TEXT_CONTENT', value: 'x' });
    expect(resolve('<button aria-labelledby="" aria-label="Go">x</button>')).toMatchObject({ source: 'ARIA_LABEL', value: 'Go' });
  });

  it('input value / alt', () => {
    expect(resolve('<input type="submit" value="Send"/>')).toMatchObject({ source: 'VALUE_ATTR', value: 'Send' });
    expect(resolve('<input type="reset" value="Reset"/>').source).toBe('VALUE_ATTR');
    expect(resolve('<input type="image" alt="Search"/>')).toMatchObject({ source: 'ALT_ATTR', value: 'Search' });
  });

  it('img inside anchor provides alt', () => {
    expect(resolve('<a href="/h"><img src="logo.png" alt="Home"/></a>')).toMatchObject({ source: 'ALT_ATTR', value: 'Home' });
    expect(resolve('<a href="/h" title="Home"><img alt="" src="x.png"/></a>')).toMatchObject({ source: 'TITLE', value: 'Home' });
    expect(resolve('<a href="/h"><img src="x.png"/></a>').source).toBe('NONE');
  });

  it('text content strips nested tags and collapses whitespace', () => {
    expect(resolve('<button>  Save   <span>changes</span>  now </button>')).toMatchObject({ source: 'TEXT_CONTENT', value: 'Save changes now' });
    expect(resolve('<a href="/docs">Read the docs</a>')).toMatchObject({ source: 'TEXT_CONTENT', value: 'Read the docs' });
    expect(resolve('<summary>More info</summary>')).toMatchObject({ source: 'TEXT_CONTENT', value: 'More info' });
  });

  it('placeholder, title and none', () => {
    expect(resolve('<input type="text" placeholder="Your name"/>')).toEqual({ source: 'PLACEHOLDER_ATTR', value: 'Your name', isEmpty: false });
    expect(resolve('<input type="text" title="Phone"/>')).toMatchObject({ source: 'TITLE', value: 'Phone' });
    expect(resolve('<button></button>')).toEqual({ source: 'NONE', value: null, isEmpty: true });
    expect(resolve('<textarea></textarea>').source).toBe('NONE');
  });
});

describe('auditLabels', () => {
  it('empty file reports 100 percent coverage', () => {
    const r = auditLabels('', 'empty.html');
    expect([r.total, r.labeled, r.unlabeled, r.placeholderOnlyWarnings, r.coveragePercent]).toEqual([0, 0, 0, 0, 100]);
    expect(r.issues).toEqual([]);
  });

  it('file with only labeled elements reports 100 percent', () => {
    const r = auditLabels('<button aria-label="a">x</button>\n<a href="/h">Home</a>', 'f.html');
    expect([r.total, r.labeled, r.unlabeled, r.coveragePercent]).toEqual([2, 2, 0, 100]);
    expect(r.issues).toEqual([]);
  });

  it('mixed file computes coverage rounded to one decimal', () => {
    const src = [
      '<button aria-label="a">x</button>', '<a href="/h">Home</a>', '<summary>More</summary>',
      '<button></button>', '<a href="/x"></a>', '<input type="text" placeholder="Name"/>',
    ].join('\n');
    const r = auditLabels(src, 'f.html');
    expect([r.total, r.labeled, r.unlabeled, r.placeholderOnlyWarnings, r.coveragePercent]).toEqual([6, 3, 2, 1, 50]);
    const r2 = auditLabels('<button aria-label="a">x</button><button aria-label="b">x</button><button></button>', 'f.html');
    expect(r2.coveragePercent).toBe(66.7);
  });

  it('suggestions are specific', () => {
    const b = single(auditLabels('<button></button>', 'f.html').issues);
    expect(b.source).toBe('NONE');
    expect(b.suggestion).toContain('aria-label');
    expect(b.suggestion).toContain('<button>');
    expect(b.line).toBe(1);
    expect(b.tagName).toBe('button');
    expect(single(auditLabels('<input type="text"/>', 'f.html').issues).suggestion).toContain('<label for="id">');
    expect(single(auditLabels('<input type="image"/>', 'f.html').issues).suggestion).toContain('alt=');
    expect(single(auditLabels('<a href="/x"></a>', 'f.html').issues).suggestion).toContain('link text');
  });

  it('placeholder-only issue carries PLACEHOLDER_ATTR source', () => {
    const r = auditLabels('<input type="text" placeholder="Name"/>', 'f.html');
    const i = single(r.issues);
    expect(i.source).toBe('PLACEHOLDER_ATTR');
    expect(i.suggestion).toContain('label');
    expect(r.occurrences).toHaveLength(1);
  });

  it('issue order and occurrences', () => {
    const r = auditLabels('<button></button>\n<a href="/x"></a>\n<textarea></textarea>', 'f.html');
    expect(r.issues.map((i) => i.tagName)).toEqual(['button', 'a', 'textarea']);
    expect(r.issues.map((i) => i.line)).toEqual([1, 2, 3]);
    const o = auditLabels('<button aria-label="Close">X</button><a href="/">Home</a>', 'f.html').occurrences;
    expect(o.map((x) => x.source)).toEqual(['ARIA_LABEL', 'TEXT_CONTENT']);
  });

  it('aggregate micro-averages coverage', () => {
    const r1 = auditLabels('<button aria-label="a">x</button><button></button>', 'a.html');
    const r2 = auditLabels('<button aria-label="b">x</button>', 'b.html');
    const agg = aggregateLabelReports([r1, r2]);
    expect([agg.total, agg.labeled, agg.unlabeled, agg.coveragePercent]).toEqual([3, 2, 1, 66.7]);
    expect(aggregateLabelReports([])).toMatchObject({ total: 0, coveragePercent: 100 });
  });

  it('missingReason is specific to tag', () => {
    const r = auditLabels('<button></button>\n<input type="text"/>\n<summary></summary>\n<div role="switch"></div>', 'f.html');
    expect(r.issues).toHaveLength(4);
    expect(r.issues[0]!.missingReason).toContain('<button>');
    expect(r.issues[1]!.missingReason).toContain('<input');
    expect(r.issues[2]!.missingReason).toContain('<summary>');
    expect(r.issues[3]!.missingReason).toContain('role=');
  });

  it('label for and wrapping label provide a name', () => {
    const src = [
      '<label for="email">E-mail</label><input id="email" type="email">',
      '<label htmlFor="name">Name</label><input id="name" />',
      '<label>Phone <input type="tel"></label>',
      '<label>Notes <textarea></textarea></label>',
      '<input id="orphan">',
    ].join('\n');
    const r = auditLabels(src, 'form.html');
    expect([r.total, r.labeled, r.unlabeled]).toEqual([5, 4, 1]);
    expect(single(r.issues).element.attributes.get('id')).toBe('orphan');
    expect(r.occurrences.filter((o) => o.source === 'LABEL_ELEMENT')).toHaveLength(4);
  });

  it('elements in hidden subtrees are not audited', () => {
    const r = auditLabels('<div hidden><button></button></div><div aria-hidden="true"><input></div><p hidden={false}><button></button></p>', 'f.jsx');
    expect([r.total, r.unlabeled]).toEqual([1, 1]);
  });

  it('runtime-decided names are unknown, not missing', () => {
    const src = [
      '<button aria-label={label}></button>',
      '<button :aria-label="label"></button>',
      '<a href="/x"><img src="i.png" alt={alt} /></a>',
      '<button>{children}</button>',
      '<button {...props}></button>',
      '<input v-bind="attrs">',
      '<label :for="id">X</label><input :id="id">',
      '<button v-text="t"></button>',
      '<button></button>',
    ].join('\n');
    const r = auditLabels(src, 'f.vue');
    expect([r.total, r.unlabeled]).toEqual([1, 1]);
  });

  it('label precedence, validity and labelable targets', () => {
    let r = auditLabels('<button aria-label="Close" title={tooltip}></button><button></button>', 'f.jsx');
    expect([r.total, r.labeled, r.unlabeled]).toEqual([2, 1, 1]);
    r = auditLabels('<input value={value}>', 'f.jsx');
    expect([r.total, r.unlabeled]).toEqual([1, 1]);
    expect(auditLabels('<button><span aria-labelledby="x"></span>Save</button>', 'f.html').labeled).toBe(1);
    expect(auditLabels('<label for="e"></label><input id="e">', 'f.html').unlabeled).toBe(1);
    expect(auditLabels('<label>  <input id="e"></label>', 'f.html').unlabeled).toBe(1);
    expect(auditLabels('<label for="other">X</label><label for="other"><input id="e"></label>', 'f.html').unlabeled).toBe(1);
    expect(auditLabels('<label for="e">X</label><div role="button" id="e"></div>', 'f.html').unlabeled).toBe(1);
    expect(auditLabels('<label :for="target">Email</label><input id="e">', 'f.vue').total).toBe(0);
    expect(auditLabels('<label [htmlFor]="t">Email</label><input id="e">', 'f.html').total).toBe(0);
    expect(auditLabels("<label>{t('name')}<input id=\"e\"></label>", 'f.jsx').total).toBe(0);
    r = auditLabels('<input id={id}>', 'f.jsx');
    expect([r.total, r.unlabeled]).toEqual([1, 1]);
  });

  it('literal names survive, precedence and label variants are respected', () => {
    expect(auditLabels('<button aria-label="@mention"></button>', 'f.html').labeled).toBe(1);
    expect(auditLabels('<button>@mention</button>', 'f.html').labeled).toBe(1);
    expect(auditLabels('<button aria-label="Insert {placeholder}"></button>', 'f.html').labeled).toBe(1);
    expect(auditLabels('<button aria-label="@Model.Title"></button>', 'f.cshtml').total).toBe(0);
    expect(auditLabels('<button aria-label="@mention"></button>', 'f.cshtml').labeled).toBe(1);
    expect(auditLabels('<span id="x">Close</span><button aria-labelledby="x" aria-label={fallback}></button>', 'f.jsx').labeled).toBe(1);
    expect(auditLabels('<button><span aria-hidden="true">{debug}</span>Save</button>', 'f.jsx').labeled).toBe(1);
    expect(auditLabels('<button><img aria-labelledby={labelId} alt=""></button>', 'f.jsx').total).toBe(0);
    expect(auditLabels('<button><img :aria-labelledby="id" alt=""></button>', 'f.vue').total).toBe(0);
    expect(auditLabels('<label for="e" [innerText]="label"></label><input id="e">', 'f.ts').total).toBe(0);
    expect(auditLabels('<label for="e" v-html="html"></label><input id="e">', 'f.vue').total).toBe(0);
    expect(auditLabels('<label for="e" aria-label={l}></label><input id="e">', 'f.jsx').total).toBe(0);
    expect(auditLabels('<label for="e"></label><label for="e">Email</label><input id="e">', 'f.html').labeled).toBe(1);
    expect(auditLabels('<label for="e">Email</label><label for="e"></label><input id="e">', 'f.html').labeled).toBe(1);
  });

  it('quoted braces are literal outside Svelte and attribute scanning is linear', () => {
    for (const ext of ['jsx', 'tsx', 'vue']) {
      expect(auditLabels('<button aria-label="Insert {placeholder}"></button>', `f.${ext}`).labeled).toBe(1);
      expect(auditLabels('<button aria-label="@Model.Title"></button>', `f.${ext}`).labeled).toBe(1);
    }
    expect(auditLabels('<button aria-label="Insert {placeholder}"></button>', 'f.svelte').total).toBe(0);
    expect(auditLabels('<button aria-label="{label}"></button>', 'f.svelte').total).toBe(0);
    const hostile = '<button aria-label="' + '{a('.repeat(33_333) + '"></button>';
    const started = Date.now();
    auditLabels(hostile, 'f.svelte'); auditLabels(hostile, 'f.jsx'); auditLabels(hostile, 'f.cshtml');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('a static name written after a spread is definite', () => {
    expect(auditLabels('<button {...props} aria-label="Save"></button>', 'f.jsx').labeled).toBe(1);
    expect(auditLabels('<button aria-label="Save" {...props}></button>', 'f.jsx').total).toBe(0);
    expect(auditLabels('<button {...props} aria-label={l}></button>', 'f.jsx').total).toBe(0);
    expect(auditLabels('<input v-bind="attrs" aria-label="Search">', 'f.vue').labeled).toBe(1);
    expect(auditLabels('<button aria-label="Save" {disabled}></button>', 'f.svelte').labeled).toBe(1);
    expect(auditLabels('<button {disabled}></button>', 'f.svelte').unlabeled).toBe(1);
    expect(auditLabels('<button {...rest} aria-label="Save" {...rest}></button>', 'f.jsx').total).toBe(0);
    expect(auditLabels('<button aria-label="Old" {...rest} aria-label="Save"></button>', 'f.jsx').labeled).toBe(1);
  });

  it('deeply nested role buttons are audited in linear time', () => {
    const n = 20_000;
    const src = '<div role="button" aria-label="x">'.repeat(n) + '</div>'.repeat(n);
    let started = Date.now();
    expect(auditLabels(src, 'deep.html').labeled).toBe(n);
    expect(Date.now() - started).toBeLessThan(4_000);
    const wrapped = '<label>Name <input></label>'.repeat(30_000);
    started = Date.now();
    expect(auditLabels(wrapped, 'many.html').labeled).toBe(30_000);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('static labelled inputs count as labeled', () => {
    const r = auditLabels('<label for="q">Search</label><input id="q" placeholder="Type…">', 'f.html');
    expect([r.total, r.labeled, r.placeholderOnlyWarnings]).toEqual([1, 1, 0]);
    expect(r.issues).toEqual([]);
  });
});
