import { describe, expect, it } from 'vitest';
import {
  auditFile,
  auditFiles,
  extensionOf,
  isAuditablePath,
  isInSkippedDirectory,
  PARSE_FAILURE_RULE,
} from '../src/core/engine';
import { gradeFor, type AuditCategory } from '../src/core/types';

const NOW = '2026-06-09 12:00';
const audit = (files: Record<string, string>, categories?: AuditCategory[]) =>
  auditFiles(Object.entries(files), 'root', NOW, categories ? { categories: new Set(categories) } : {});

const cleanPage = `<html lang="en"><head><title>Welcome – Acme</title></head><body>
<header><nav aria-label="Main">menu</nav></header>
<main>
  <h1>Welcome</h1>
  <h2>Section</h2>
  <img src="hero.jpg" alt="Sunrise over the city skyline">
  <button aria-label="Search">🔍</button>
</main>
<footer>© 2026</footer>
</body></html>`;

describe('engine', () => {
  it('clean project scores 100 with grade A', () => {
    const r = audit({ 'index.html': cleanPage });
    expect(r.healthScore).toBe(100);
    expect(r.grade).toBe('A');
    expect(r.filesScanned).toBe(1);
    expect(r.findings).toEqual([]);
    expect(r.generatedAt).toBe(NOW);
  });

  it('aggregates findings from all categories with relative paths', () => {
    const r = audit({
      'src/page.html': '<html><body>\n<h2>No h1 here</h2>\n<img src="IMG_001.jpg" alt="IMG_001.jpg">\n<button></button>\n</body></html>',
      'styles/bad.css': '.low { color: #777777; background-color: #888888; }',
    });
    const cats = new Set(r.findings.map((f) => f.category));
    for (const c of ['HEADINGS', 'ALT_TEXT', 'LABELS', 'LANDMARKS', 'CONTRAST'] as const) expect(cats.has(c)).toBe(true);
    expect(r.findings.some((f) => f.filePath === 'src/page.html')).toBe(true);
    const contrast = r.findings.find((f) => f.filePath === 'styles/bad.css' && f.category === 'CONTRAST');
    expect(contrast?.ruleId).toBe('contrast-text');
    expect(contrast?.message).toMatch(/^Contrast ratio \d+\.\d\d:1 for `\.low` \(fg .+ on bg .+\) fails WCAG AA\.$/);
    expect(r.healthScore).toBeLessThan(100);
  });

  it('skips files in skipped directories', () => {
    const r = audit({ 'node_modules/x/index.html': '<img src="a.png">', 'dist/a.html': '<img src="a.png">', 'ok.html': cleanPage });
    expect(r.filesScanned).toBe(1);
    expect(r.findings).toEqual([]);
  });

  it('runs landmark analysis only on full documents', () => {
    const r = audit({ 'Component.jsx': '<section><h2>Fragment</h2><button aria-label="x">y</button></section>' });
    expect(r.findings.some((f) => f.category === 'LANDMARKS')).toBe(false);
    expect(r.findings.some((f) => f.category === 'HEADINGS' && f.severity === 'WARNING')).toBe(true);
  });

  it('tracks checked and passed counts per category', () => {
    const r = audit({
      'f.html': `<html><body>
<main><h1>T</h1>
<img src="a.png" alt="Good description here">
<img src="b.png">
<button aria-label="ok">x</button>
<button></button>
</main>
</body></html>`,
    });
    const alt = r.categoryStats.find((s) => s.category === 'ALT_TEXT')!;
    expect([alt.checked, alt.passed, alt.errors]).toEqual([2, 1, 1]);
    const labels = r.categoryStats.find((s) => s.category === 'LABELS')!;
    expect([labels.checked, labels.passed]).toEqual([2, 1]);
  });

  it('health score is the mean of active category pass rates', () => {
    const r = audit({ 'imgs.html': '<img src="a.png" alt="A nice description">\n<img src="b.png">' });
    expect(r.categoryStats.filter((s) => s.checked > 0).map((s) => s.category)).toEqual(['ALT_TEXT']);
    expect(r.healthScore).toBe(50);
    expect(r.grade).toBe('F');
  });

  it('empty input scores 100', () => {
    const r = audit({});
    expect(r.healthScore).toBe(100);
    expect(r.filesScanned).toBe(0);
  });

  it('audits in-memory content', () => {
    const { findings } = auditFile('<img src="x.png">', 'editor.html');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe('alt-missing');
    expect(findings[0]!.filePath).toBe('editor.html');
  });

  it('grade boundaries', () => {
    expect([90, 80, 70, 60, 59].map(gradeFor)).toEqual(['A', 'B', 'C', 'D', 'F']);
  });

  it('audits vue and svelte files', () => {
    const r = audit({ 'App.vue': '<template><img src="x.png"></template>', 'Page.svelte': '<button></button>' });
    expect(r.filesScanned).toBe(2);
    expect(r.findings.some((f) => f.filePath === 'App.vue' && f.ruleId === 'alt-missing')).toBe(true);
    expect(r.findings.some((f) => f.filePath === 'Page.svelte' && f.ruleId === 'label-missing')).toBe(true);
  });

  it('wires links, media, document and focus categories', () => {
    const r = audit({
      'page.html': `<!doctype html>
<html>
<head><title></title><meta name="viewport" content="width=device-width, user-scalable=no"></head>
<body>
<main>
<h1>Title</h1>
<a href="/x">Click here</a>
<video src="a.mp4" controls></video>
<iframe src="https://x"></iframe>
<div onclick="go()">Go</div>
<div id="dup"></div><div id="dup"></div>
</main>
</body>
</html>`,
      'focus.css': 'a:focus { outline: none; }',
    });
    const one = (id: string) => {
      const list = r.findings.filter((f) => f.ruleId === id);
      expect(list, id).toHaveLength(1);
      return list[0]!;
    };
    expect(one('link-generic-text').category).toBe('LINKS');
    expect(one('link-generic-text').severity).toBe('INFO');
    expect(one('media-video-no-captions').category).toBe('MEDIA');
    expect(one('media-iframe-no-title').category).toBe('MEDIA');
    expect(one('doc-missing-lang').category).toBe('DOCUMENT');
    expect(one('doc-empty-title').category).toBe('DOCUMENT');
    expect(one('doc-viewport-zoom-blocked').category).toBe('DOCUMENT');
    expect(one('doc-duplicate-id').category).toBe('DOCUMENT');
    expect(one('focus-click-not-focusable').category).toBe('FOCUS');
    expect(one('focus-outline-suppressed').filePath).toBe('focus.css');
    const newer = r.findings.filter((f) => ['LINKS', 'MEDIA', 'DOCUMENT', 'FOCUS'].includes(f.category));
    expect(newer.every((f) => f.helpUri && f.ruleName.includes('WCAG') && f.suggestion !== undefined)).toBe(true);
    const focus = r.categoryStats.find((s) => s.category === 'FOCUS')!;
    expect([focus.checked, focus.passed]).toEqual([2, 0]);
    const links = r.categoryStats.find((s) => s.category === 'LINKS')!;
    expect([links.checked, links.passed]).toEqual([1, 1]);
  });

  it('runs tokenizer-based auditors on unsaved JSX', () => {
    const { findings } = auditFile('<a href="/x"></a><div tabindex="4"></div>', 'editor.jsx');
    expect(findings.some((f) => f.ruleId === 'link-empty' && f.category === 'LINKS')).toBe(true);
    expect(findings.some((f) => f.ruleId === 'focus-positive-tabindex' && f.category === 'FOCUS')).toBe(true);
  });

  it('never throws on malformed content', () => {
    const inputs = ['', '<', '<a href="x', '<style>a:focus {</style>', '<a href="/x">&#x110000;</a>',
      '<div data-x={/{/.test(x)}></div>', '{/* <a></a>', '<video controls><track', '<div>'.repeat(30_000)];
    for (const src of inputs) expect(() => auditFile(src, 'weird.html')).not.toThrow();
  });

  it('reports deep pathological input instead of silently passing', () => {
    const deep = '<div title={' + '`${'.repeat(60_000) + '1' + '}`'.repeat(60_000) + '}></div><iframe src="x"></iframe>';
    const { findings } = auditFile(deep, 'deep.jsx');
    expect(findings.some((f) => f.ruleId === 'media-iframe-no-title' || f.ruleId === PARSE_FAILURE_RULE)).toBe(true);
  });

  it('respects disabled categories', () => {
    const src = '<html><body><img src="a.png"><button></button></body></html>';
    const { findings, counters } = auditFile(src, 'a.html', { categories: new Set(['LABELS']) });
    expect(new Set(findings.map((f) => f.category))).toEqual(new Set(['LABELS']));
    expect(counters.ALT_TEXT.checked).toBe(0);
  });

  it('ignores unknown file types', () => {
    expect(auditFile('<img src="a.png">', 'notes.txt').findings).toEqual([]);
  });

  it('path helpers', () => {
    expect(extensionOf('a/b/C.TSX')).toBe('tsx');
    expect(extensionOf('Makefile')).toBe('');
    expect(isAuditablePath('x/y.cshtml')).toBe(true);
    expect(isAuditablePath('x/y.ts')).toBe(false);
    expect(isInSkippedDirectory('a/node_modules/b.html')).toBe(true);
    expect(isInSkippedDirectory('build.html')).toBe(false);
  });
});
