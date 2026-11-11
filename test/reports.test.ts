import { describe, expect, it } from 'vitest';
import { auditFiles } from '../src/core/engine';
import { normalizeSarifUri, renderHtml, renderJson, renderMarkdown, renderSarif, sarifLevel } from '../src/core/reports';

const result = auditFiles(
  [
    ['src/page.html', '<html><body>\n<h2>No h1 | here</h2>\n<img src="IMG_001.jpg" alt="IMG_001.jpg">\n<button></button>\n<a href="/x">Click here</a>\n</body></html>'],
    ['ok.css', 'a { color: #000; background: #fff; }'],
  ],
  'my-project',
  '2026-06-09 12:00',
);

describe('reports', () => {
  it('markdown contains score, categories and escaped findings', () => {
    const md = renderMarkdown(result);
    expect(md).toContain('# Accessibility Project Audit');
    expect(md).toContain(`## Health score: ${result.healthScore}/100 (grade ${result.grade})`);
    expect(md).toContain('| Screen Reader Labels |');
    expect(md).toContain('| ERROR |');
    // errors are listed before warnings and info
    expect(md.indexOf('| ERROR |')).toBeLessThan(md.indexOf('| INFO |'));
  });

  it('markdown reports a clean project', () => {
    const clean = auditFiles([], 'x', 'now');
    expect(renderMarkdown(clean)).toContain('_No findings — congratulations!_');
  });

  it('json is stable and parseable', () => {
    const json = JSON.parse(renderJson(result));
    expect(json.root).toBe('my-project');
    expect(json.healthScore).toBe(result.healthScore);
    expect(json.categories).toHaveLength(9);
    expect(json.findings.length).toBe(result.findings.length);
    expect(json.findings[0]).toHaveProperty('ruleId');
  });

  it('html is self-contained and escapes content', () => {
    const html = renderHtml({ ...result, rootLabel: '<script>x</script>' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<script/);
    expect(html).not.toMatch(/https?:\/\/[^"]*\.(css|js)/);
  });

  it('webview html adds a CSP and nonce script with clickable locations', () => {
    const html = renderHtml(result, { webview: { nonce: 'abc123', cspSource: 'vscode-resource:' } });
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).toContain('<script nonce="abc123">');
    expect(html).toContain('data-file="src/page.html"');
  });

  it('sarif 2.1.0 log maps rules, levels and 1-based columns', () => {
    const log = JSON.parse(renderSarif(result.findings, '1.0.0'));
    expect(log.version).toBe('2.1.0');
    const run = log.runs[0];
    expect(run.tool.driver.name).toBe('Accessibility Compliance Helper');
    const ids = run.tool.driver.rules.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const res of run.results) {
      expect(ids[res.ruleIndex]).toBe(res.ruleId);
      expect(res.locations[0].physicalLocation.region.startColumn).toBeGreaterThanOrEqual(1);
      expect(res.locations[0].physicalLocation.region.startLine).toBeGreaterThanOrEqual(1);
    }
    expect(['error', 'warning', 'note']).toContain(run.results[0].level);
  });

  it('sarif helpers', () => {
    expect(sarifLevel('ERROR')).toBe('error');
    expect(sarifLevel('WARNING')).toBe('warning');
    expect(sarifLevel('INFO')).toBe('note');
    expect(normalizeSarifUri('C:\\repo\\src\\a.html', 'C:\\repo')).toBe('src/a.html');
    expect(normalizeSarifUri('/abs/x.html')).toBe('abs/x.html');
  });
});
