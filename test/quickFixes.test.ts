import { describe, expect, it } from 'vitest';
import { auditFile } from '../src/core/engine';
import { offsetAt, type QuickFix, quickFixesFor, tagRangeAt } from '../src/core/quickFixes';

function apply(source: string, fix: QuickFix): string {
  return source.substring(0, fix.edit.start) + fix.edit.text + source.substring(fix.edit.end);
}

/** Runs the audit, applies the first fix for `ruleId` and returns the new source. */
function fixFirst(source: string, file: string, ruleId: string): string {
  const finding = auditFile(source, file).findings.find((f) => f.ruleId === ruleId);
  expect(finding, `finding ${ruleId}`).toBeDefined();
  const fixes = quickFixesFor(ruleId, source, finding!.line, finding!.column);
  expect(fixes.length, `fix for ${ruleId}`).toBeGreaterThan(0);
  return apply(source, fixes[0]!);
}

describe('quick fixes', () => {
  it('adds alt="" to an image without alt', () => {
    const out = fixFirst('<p>x</p>\n  <img src="a.png">', 'a.html', 'alt-missing');
    expect(out).toBe('<p>x</p>\n  <img alt="" src="a.png">');
    expect(auditFile(out, 'a.html').findings.some((f) => f.ruleId === 'alt-missing')).toBe(false);
  });

  it('adds aria-label to an unnamed button', () => {
    expect(fixFirst('<button></button>', 'a.html', 'label-missing')).toBe('<button aria-label=""></button>');
  });

  it('adds title to an iframe', () => {
    expect(fixFirst('<iframe src="x"></iframe>', 'a.html', 'media-iframe-no-title')).toBe('<iframe title="" src="x"></iframe>');
  });

  it('adds lang to the html element', () => {
    const src = '<!doctype html>\n<html>\n<head><title>T</title></head><body></body></html>';
    expect(fixFirst(src, 'a.html', 'doc-missing-lang')).toContain('<html lang="en">');
  });

  it('replaces a positive tabindex with 0 in HTML and JSX', () => {
    expect(fixFirst('<div tabindex="3">x</div>', 'a.html', 'focus-positive-tabindex')).toBe('<div tabindex="0">x</div>');
    expect(fixFirst('<div tabIndex={3}>x</div>', 'a.jsx', 'focus-positive-tabindex')).toBe('<div tabIndex={0}>x</div>');
  });

  it('removes autofocus', () => {
    expect(fixFirst('<input aria-label="q" autofocus>', 'a.html', 'focus-autofocus')).toBe('<input aria-label="q">');
  });

  it('offers nothing when the attribute already exists or the rule is unknown', () => {
    expect(quickFixesFor('alt-missing', '<img alt="x">', 1, 0)).toEqual([]);
    expect(quickFixesFor('unknown-rule', '<img>', 1, 0)).toEqual([]);
    expect(quickFixesFor('alt-missing', 'plain text', 1, 0)).toEqual([]);
  });

  it('offset helpers handle CRLF and ranges', () => {
    const src = 'a\r\n  <img src="x" />\r\nz';
    const off = offsetAt(src, 2, 2);
    expect(src.substring(off, off + 4)).toBe('<img');
    expect(tagRangeAt(src, off)).toEqual([off, off + '<img src="x" />'.length]);
    expect(offsetAt(src, 9, 0)).toBe(-1);
    const [s, e] = tagRangeAt('hello world', 0);
    expect([s, e]).toEqual([0, 11]);
  });
});
