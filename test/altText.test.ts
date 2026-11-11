import { describe, expect, it } from 'vitest';
import { AltTextRule, MAX_ALT_LENGTH, auditAltText, scanAltTextElements, type AltTextAuditReport } from '../src/core/altText';

describe('scanAltTextElements', () => {
  it('empty source yields no elements', () => {
    expect(scanAltTextElements('')).toEqual([]);
  });

  it('finds img with attributes and position', () => {
    const els = scanAltTextElements('<p>x</p>\n<img src="a.png" alt="A cat">');
    expect(els).toHaveLength(1);
    const el = els[0]!;
    expect(el.tag).toBe('img');
    expect(el.alt).toBe('A cat');
    expect(el.attributes.get('src')).toBe('a.png');
    expect(el.line).toBe(2);
    expect(el.column).toBe(0);
  });

  it('img without alt reports null alt', () => {
    expect(scanAltTextElements('<img src="x.png">')[0]!.alt).toBeNull();
  });

  it('img with empty alt reports empty string', () => {
    expect(scanAltTextElements('<img src="x.png" alt="">')[0]!.alt).toBe('');
  });

  it('finds area and input type=image but not text inputs', () => {
    const src = '<area shape="rect" href="/x" alt="Zone">\n<input type="image" src="btn.png" alt="Search">\n<input type="text" name="q">';
    expect(scanAltTextElements(src).map((e) => e.tag)).toEqual(['area', 'input']);
  });

  it('finds inline svg and detects title child', () => {
    const src = '<svg viewBox="0 0 10 10"><title>Pie chart</title><circle r="4"/></svg>\n<svg viewBox="0 0 10 10"><circle r="4"/></svg>';
    const els = scanAltTextElements(src);
    expect(els).toHaveLength(2);
    expect(els[0]!.svgHasTitleChild).toBe(true);
    expect(els[1]!.svgHasTitleChild).toBe(false);
  });

  it('empty svg title does not count as a name', () => {
    expect(scanAltTextElements('<svg><title>   </title></svg>')[0]!.svgHasTitleChild).toBe(false);
  });

  it('nested svg close tags resolve correctly', () => {
    const els = scanAltTextElements('<svg><g><svg><circle/></svg></g><title>Outer</title></svg>');
    expect(els).toHaveLength(2);
    expect(els[0]!.svgHasTitleChild).toBe(true);
    expect(els[1]!.svgHasTitleChild).toBe(false);
  });

  it('jsx expression alt is preserved and detected dynamic', () => {
    const el = scanAltTextElements('<img src={src} alt={imageAlt} />')[0]!;
    expect(el.isDynamic('alt')).toBe(true);
    expect(el.alt).toBe('{imageAlt}');
  });

  it('uppercase jsx Image component is ignored', () => {
    expect(scanAltTextElements('<Image src="x" />')).toEqual([]);
  });

  it('images in comments scripts and styles are ignored', () => {
    const src = [
      '<!-- <img src="c.png"> -->',
      '<script>document.write(\'<img src="s.png">\');</script>',
      '<style>.x { background: url("b.png"); }</style>',
      '<img src="real.png" alt="Real">',
    ].join('\n');
    const els = scanAltTextElements(src);
    expect(els).toHaveLength(1);
    expect(els[0]!.alt).toBe('Real');
  });

  it('aria attributes are exposed via helpers', () => {
    expect(scanAltTextElements('<img src="x.png" aria-hidden="true">')[0]!.ariaHidden).toBe(true);
    expect(scanAltTextElements('<img src="x.png" role="presentation">')[0]!.presentational).toBe(true);
    expect(scanAltTextElements('<img src="x.png" aria-label="Chart">')[0]!.ariaLabel).toBe('Chart');
    expect(scanAltTextElements('<img src="x.png" aria-labelledby="cap">')[0]!.hasAriaLabelledby).toBe(true);
  });

  it('single-quoted attribute values are parsed', () => {
    expect(scanAltTextElements("<img src='x.png' alt='Single'>")[0]!.alt).toBe('Single');
  });

  it('crlf input keeps line numbers correct', () => {
    expect(scanAltTextElements('<p>a</p>\r\n<p>b</p>\r\n<img src="x.png">')[0]!.line).toBe(3);
  });
});

describe('auditAltText', () => {
  const ruleIds = (r: AltTextAuditReport): string[] => r.issues.map((i) => i.rule.id);

  it('empty file is clean with score 100', () => {
    const r = auditAltText('', 'empty.html');
    expect(r.total).toBe(0);
    expect(r.issues).toEqual([]);
    expect(r.score).toBe(100);
  });

  it('good alt text passes and counts accessible', () => {
    const r = auditAltText('<img src="team.jpg" alt="Team standing in front of the office">', 'f.html');
    expect(r.issues).toEqual([]);
    expect(r.accessible).toBe(1);
    expect(r.decorative).toBe(0);
  });

  it('missing alt on img is an error', () => {
    const r = auditAltText('<img src="x.png">', 'f.html');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.rule).toBe(AltTextRule.MISSING_ALT);
    expect(r.issues[0]!.severity).toBe('ERROR');
    expect(r.issues[0]!.message).toBe('<img> has no alt attribute.');
  });

  it('empty alt is valid decorative marker', () => {
    const r = auditAltText('<img src="border.png" alt="">', 'f.html');
    expect(r.issues).toEqual([]);
    expect(r.decorative).toBe(1);
  });

  it('aria-hidden img without alt is decorative and clean', () => {
    const r = auditAltText('<img src="bg.png" aria-hidden="true">', 'f.html');
    expect(r.issues).toEqual([]);
    expect(r.decorative).toBe(1);
  });

  it('img with aria-label and no alt is accessible', () => {
    const r = auditAltText('<img src="x.png" aria-label="Sales chart">', 'f.html');
    expect(r.issues).toEqual([]);
    expect(r.accessible).toBe(1);
  });

  it('filename as alt is an error', () => {
    expect(ruleIds(auditAltText('<img src="photos/IMG_1234.jpg" alt="IMG_1234.jpg">', 'f.html'))).toContain('alt-filename');
  });

  it('camera-style name without extension is an error', () => {
    expect(ruleIds(auditAltText('<img src="x.jpg" alt="DSC0042">', 'f.html'))).toContain('alt-filename');
  });

  it('alt equal to src basename is flagged as filename', () => {
    expect(ruleIds(auditAltText('<img src="assets/hero-banner.webp" alt="hero-banner">', 'f.html'))).toContain('alt-filename');
  });

  it('a real phrase containing a camera word is not a filename', () => {
    expect(ruleIds(auditAltText('<img src="x.jpg" alt="Photo 2 of the bridge">', 'f.html'))).not.toContain('alt-filename');
  });

  it('placeholder word alt is a warning', () => {
    const r = auditAltText('<img src="x.png" alt="image">', 'f.html');
    const issue = r.issues.find((i) => i.rule === AltTextRule.PLACEHOLDER_ALT);
    expect(issue?.severity).toBe('WARNING');
  });

  it('redundant phrase prefix is a warning with concrete suggestion', () => {
    const r = auditAltText('<img src="x.png" alt="Picture of a sunset over mountains">', 'f.html');
    const issue = r.issues.find((i) => i.rule === AltTextRule.REDUNDANT_PHRASE);
    expect(issue?.suggestion).toContain('A sunset over mountains');
  });

  it('long alt is info', () => {
    const long = 'a'.repeat(MAX_ALT_LENGTH + 1);
    const r = auditAltText(`<img src="x.png" alt="${long}">`, 'f.html');
    expect(r.issues.find((i) => i.rule === AltTextRule.ALT_TOO_LONG)?.severity).toBe('INFO');
  });

  it('whitespace-only alt is a warning', () => {
    expect(ruleIds(auditAltText('<img src="x.png" alt="  ">', 'f.html'))).toContain('alt-whitespace-only');
  });

  it('non-empty alt with aria-hidden is a conflict warning', () => {
    expect(ruleIds(auditAltText('<img src="x.png" alt="Chart" aria-hidden="true">', 'f.html'))).toContain('alt-decorative-conflict');
  });

  it('title duplicating alt is info', () => {
    expect(ruleIds(auditAltText('<img src="x.png" alt="Logo of Acme" title="Logo of Acme">', 'f.html'))).toContain('alt-title-duplicate');
  });

  it('area without alt but with href is an error', () => {
    expect(ruleIds(auditAltText('<area shape="rect" href="/zone">', 'map.html'))).toContain('alt-missing');
  });

  it('area without href does not require alt', () => {
    expect(auditAltText('<area shape="rect">', 'map.html').issues).toEqual([]);
  });

  it('input type=image without alt is an error', () => {
    const r = auditAltText('<input type="image" src="go.png">', 'f.html');
    expect(ruleIds(r)).toContain('alt-missing');
    expect(r.issues[0]!.message).toBe('<input type="image"> has no alt attribute.');
  });

  it('svg role=img without name is an error', () => {
    expect(ruleIds(auditAltText('<svg role="img" viewBox="0 0 1 1"></svg>', 'f.html'))).toContain('svg-img-missing-name');
  });

  it('svg role=img with title child passes', () => {
    const r = auditAltText('<svg role="img"><title>Donut chart</title></svg>', 'f.html');
    expect(r.issues).toEqual([]);
    expect(r.accessible).toBe(1);
  });

  it('unmarked svg is advisory info', () => {
    const r = auditAltText('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>', 'f.html');
    expect(r.issues.find((i) => i.rule === AltTextRule.SVG_UNMARKED)?.severity).toBe('INFO');
  });

  it('aria-hidden svg is clean', () => {
    expect(auditAltText('<svg aria-hidden="true"><path d="M0 0"/></svg>', 'f.html').issues).toEqual([]);
  });

  it('dynamic jsx alt is skipped from quality judgement', () => {
    const r = auditAltText('<img src={url} alt={altText} />', 'Card.tsx');
    expect(r.issues).toEqual([]);
    expect(r.accessible).toBe(1);
  });

  it('score deducts by severity and floors at zero', () => {
    const src = '<img src="a.png">\n<img src="b.png">\n<img src="c.png" alt="icon">';
    expect(auditAltText(src, 'f.html').score).toBe(63);
    const many = Array.from({ length: 10 }, (_, i) => `<img src="${i + 1}.png">`).join('\n');
    expect(auditAltText(many, 'f.html').score).toBe(0);
  });

  it('issues of one element share the element identity and carry its position', () => {
    const r = auditAltText('\n  <img src="x.png" alt="Chart" aria-hidden="true" title="Chart">', 'f.html');
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
    expect(r.issues[0]!.element).toBe(r.issues[1]!.element);
    expect(r.issues[0]!.line).toBe(2);
    expect(r.issues[0]!.column).toBe(2);
  });

  it('multiple images aggregate counts correctly', () => {
    const src = '<img src="a.png" alt="Good description of content">\n<img src="b.png" alt="">\n<img src="c.png">';
    const r = auditAltText(src, 'f.html');
    expect(r.total).toBe(3);
    expect(r.accessible).toBe(1);
    expect(r.decorative).toBe(1);
    expect(r.issues.filter((i) => i.severity === 'ERROR')).toHaveLength(1);
  });
});
