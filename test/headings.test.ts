import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARIA_HEADING_LEVEL,
  HEADING_RULES,
  MAX_HEADING_LENGTH,
  auditHeadings,
  headingReportToJson,
  headingReportToMarkdown,
  scanHeadings,
  type HeadingAuditReport,
} from '../src/core/headings';

const single = <T>(xs: readonly T[], pred: (x: T) => boolean = () => true): T => {
  const m = xs.filter(pred);
  expect(m).toHaveLength(1);
  return m[0]!;
};
const ids = (r: HeadingAuditReport): string[] => r.issues.map((i) => i.rule.id);

describe('scanHeadings', () => {
  it('empty source yields no headings and no full document', () => {
    const out = scanHeadings('');
    expect(out.headings).toHaveLength(0);
    expect(out.fullDocument).toBe(false);
  });

  it('detects native h1 to h6 with levels and text', () => {
    const src = '<h1>Title</h1>\n<h2>Section</h2>\n<h3>Sub</h3>\n<h4>a</h4>\n<h5>b</h5>\n<h6>c</h6>';
    const out = scanHeadings(src);
    expect(out.headings.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.headings[0]!.text).toBe('Title');
    expect(out.headings[1]!.text).toBe('Section');
    expect(out.headings.every((h) => h.native)).toBe(true);
  });

  it('tracks line and column of opening tag', () => {
    const h = single(scanHeadings('<div>\n  <h2>Hello</h2>\n</div>').headings);
    expect(h.line).toBe(2);
    expect(h.column).toBe(2);
  });

  it('crlf line endings are counted as single breaks', () => {
    expect(single(scanHeadings('<p>x</p>\r\n\r\n<h3>Y</h3>').headings).line).toBe(3);
  });

  it('detects role=heading with aria-level', () => {
    const h = single(scanHeadings('<div role="heading" aria-level="3">Custom</div>').headings);
    expect(h.level).toBe(3);
    expect(h.native).toBe(false);
    expect(h.declaredAriaLevel).toBe('3');
    expect(h.text).toBe('Custom');
  });

  it('role=heading without aria-level defaults to level 2', () => {
    const h = single(scanHeadings('<span role="heading">Implicit</span>').headings);
    expect(h.level).toBe(DEFAULT_ARIA_HEADING_LEVEL);
    expect(h.declaredAriaLevel).toBeNull();
  });

  it('invalid aria-level falls back to default but is preserved raw', () => {
    const h = single(scanHeadings('<div role="heading" aria-level="banana">X</div>').headings);
    expect(h.level).toBe(2);
    expect(h.declaredAriaLevel).toBe('banana');
  });

  it('aria-hidden and hidden headings are skipped', () => {
    const out = scanHeadings('<h1 aria-hidden="true">Hidden</h1>\n<h2 hidden>Also hidden</h2>\n<h3>Visible</h3>');
    expect(out.headings).toHaveLength(1);
    expect(out.headings[0]!.level).toBe(3);
  });

  it('nested markup is stripped from text and img alt contributes', () => {
    const h = single(scanHeadings('<h1><span class="brand"><img src="logo.png" alt="Acme"/></span> <em>Dashboard</em></h1>').headings);
    expect(h.text).toBe('Acme Dashboard');
  });

  it('empty heading has blank text', () => {
    expect(single(scanHeadings('<h2>   </h2>').headings).text).toBe('');
  });

  it('jsx expression content is flagged dynamic', () => {
    const h = single(scanHeadings('<h1>{props.title}</h1>').headings);
    expect(h.dynamicContent).toBe(true);
    expect(h.text).toBe('{props.title}');
  });

  it('static jsx heading is not dynamic', () => {
    expect(single(scanHeadings('<h1>Static title</h1>').headings).dynamicContent).toBe(false);
  });

  it('full document detection via html and body tags', () => {
    expect(scanHeadings('<html><body><h1>t</h1></body></html>').fullDocument).toBe(true);
    expect(scanHeadings('<body class="x"><h1>t</h1></body>').fullDocument).toBe(true);
    expect(scanHeadings('<section><h2>fragment</h2></section>').fullDocument).toBe(false);
  });

  it('headings inside comments, script and style are ignored', () => {
    const src = '<!-- <h1>Commented</h1> -->\n<script>const s = "<h1>js</h1>";</script>\n<style>h1 { color: red; }</style>\n<h2>Real</h2>';
    const out = scanHeadings(src);
    expect(out.headings).toHaveLength(1);
    expect(out.headings[0]!.text).toBe('Real');
  });

  it('uppercase jsx component H1 is not a native heading', () => {
    expect(scanHeadings('<Heading1>Custom component</Heading1>').headings).toHaveLength(0);
  });

  it('heading aria-label is captured', () => {
    expect(single(scanHeadings('<h2 aria-label="Quarterly results"></h2>').headings).ariaLabel).toBe('Quarterly results');
  });

  it('same-name nesting resolves to correct closing tag', () => {
    const out = scanHeadings('<h2>Outer <b>bold</b> end</h2><h2>Second</h2>');
    expect(out.headings).toHaveLength(2);
    expect(out.headings[0]!.text).toBe('Outer bold end');
    expect(out.headings[1]!.text).toBe('Second');
  });

  it('unclosed heading consumes rest of file without crashing', () => {
    expect(single(scanHeadings('<h1>Never closed').headings).text).toBe('Never closed');
  });
});

describe('auditHeadings', () => {
  it('clean document with proper outline has score 100 and no issues', () => {
    const src = '<html><body>\n<h1>Page</h1>\n<h2>Section A</h2>\n<h3>Detail</h3>\n<h2>Section B</h2>\n</body></html>';
    const r = auditHeadings(src, 'ok.html');
    expect(r.issues).toHaveLength(0);
    expect(r.score).toBe(100);
    expect(r.fullDocument).toBe(true);
    expect(r.headings).toHaveLength(4);
  });

  it('empty file produces no issues', () => {
    const r = auditHeadings('', 'empty.html');
    expect(r.issues).toHaveLength(0);
    expect(r.score).toBe(100);
  });

  it('fragment without headings produces no missing-h1 noise', () => {
    expect(auditHeadings('<button>Save</button>', 'Button.jsx').issues).toHaveLength(0);
  });

  it('full document without h1 is an error', () => {
    const r = auditHeadings('<html><body><h2>Intro</h2></body></html>', 'page.html');
    const i = single(r.issues, (x) => x.rule === HEADING_RULES.MISSING_H1);
    expect(i.severity).toBe('ERROR');
    expect(i.line).toBe(1);
    expect(i.column).toBe(0);
  });

  it('fragment with headings but no h1 is only a warning', () => {
    const r = auditHeadings('<section><h2>Widget</h2></section>', 'Widget.tsx');
    expect(single(r.issues, (x) => x.rule.id === 'heading-missing-h1').severity).toBe('WARNING');
  });

  it('multiple h1 is flagged once with the second h1 location', () => {
    const r = auditHeadings('<h1>One</h1>\n<h1>Two</h1>\n<h1>Three</h1>', 'f.html');
    const i = single(r.issues, (x) => x.rule.id === 'heading-multiple-h1');
    expect(i.severity).toBe('WARNING');
    expect(i.line).toBe(2);
    expect(i.message).toContain('3');
  });

  it('skipped level h2 to h4 is flagged', () => {
    const r = auditHeadings('<h1>T</h1><h2>S</h2><h4>Deep</h4>', 'f.html');
    const i = single(r.issues, (x) => x.rule.id === 'heading-skipped-level');
    expect(i.message).toBe('Heading level skips from h2 to h4.');
  });

  it('decreasing levels are never a skip', () => {
    expect(ids(auditHeadings('<h1>T</h1><h2>A</h2><h3>B</h3><h2>C</h2><h3>D</h3>', 'f.html'))).not.toContain('heading-skipped-level');
  });

  it('empty heading is an error', () => {
    const r = auditHeadings('<h1>Title</h1><h2></h2>', 'f.html');
    const i = single(r.issues, (x) => x.rule.id === 'heading-empty');
    expect(i.severity).toBe('ERROR');
    expect(i.message).toBe('<h2> has no text content.');
  });

  it('heading with aria-label, dynamic content or img alt is not empty', () => {
    expect(ids(auditHeadings('<h1>Title</h1><h2 aria-label="Results"></h2>', 'f.html'))).not.toContain('heading-empty');
    expect(ids(auditHeadings('<h1>{title}</h1>', 'Page.jsx'))).not.toContain('heading-empty');
    expect(ids(auditHeadings('<h1><img src="logo.svg" alt="Acme Corp"/></h1>', 'f.html'))).not.toContain('heading-empty');
  });

  it('overly long heading is info', () => {
    const r = auditHeadings(`<h1>${'x'.repeat(MAX_HEADING_LENGTH + 1)}</h1>`, 'f.html');
    expect(single(r.issues, (x) => x.rule.id === 'heading-too-long').severity).toBe('INFO');
  });

  it('role heading without aria-level is a warning', () => {
    const r = auditHeadings('<h1>T</h1><div role="heading">Custom</div>', 'f.html');
    expect(single(r.issues, (x) => x.rule.id === 'heading-role-without-aria-level').severity).toBe('WARNING');
  });

  it('invalid aria-level is an error', () => {
    const r = auditHeadings('<h1>T</h1><div role="heading" aria-level="0">Bad</div>', 'f.html');
    const i = single(r.issues, (x) => x.rule.id === 'heading-invalid-aria-level');
    expect(i.severity).toBe('ERROR');
    expect(i.rule.wcag).toBe('WAI-ARIA 1.2');
  });

  it('score deducts 15 per error 7 per warning 2 per info', () => {
    const r = auditHeadings('<html><body><h2></h2></body></html>', 'f.html');
    expect(r.errorCount).toBe(2);
    expect(r.score).toBe(70);
  });

  it('score never drops below zero', () => {
    expect(auditHeadings('<html><body>' + '<h2></h2>'.repeat(10) + '</body></html>', 'f.html').score).toBe(0);
  });

  it('markdown report contains outline and issue table', () => {
    const md = headingReportToMarkdown(auditHeadings('<h1>Top</h1><h3>Skipped</h3>', 'doc.html'));
    expect(md).toContain('# Heading Structure Audit');
    expect(md).toContain('**h1** Top');
    expect(md).toContain('heading-skipped-level');
    expect(md).toContain('| Severity | Rule | Location | Message | Suggestion |');
  });

  it('json report is stable and contains outline and issues', () => {
    const json = headingReportToJson(auditHeadings('<h1>Top</h1><h2></h2>', 'doc.html'));
    expect(json).toContain('"filePath": "doc.html"');
    expect(json).toContain('"outline"');
    expect(json).toContain('"heading-empty"');
    expect(json).toContain('"score"');
  });

  it('pipes in heading text are escaped in markdown tables', () => {
    const md = headingReportToMarkdown(auditHeadings('<h1>A | B</h1><h2></h2>', 'doc.html'));
    expect(md.split('\n').some((l) => l.startsWith('| ERROR') && (l.match(/\|/g) ?? []).length > 7)).toBe(false);
  });
});
