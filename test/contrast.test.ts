import { describe, expect, it } from 'vitest';
import {
  CSS_EXTENSIONS, HTML_EXTENSIONS, extractColorFromShorthand, extractCssRules, scanContrast, scanCss, scanHtmlInline,
} from '../src/core/contrast';

describe('extractCssRules', () => {
  it('extracts simple ruleset', () => {
    const rules = extractCssRules('.button {\n  color: #fff;\n  background-color: #333;\n}');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector).toBe('.button');
    expect(rules[0]!.declarations).toHaveLength(2);
    expect(rules[0]!.declarations[0]).toEqual({ property: 'color', value: '#fff', line: 2 });
  });

  it('ignores block comments but preserves lines', () => {
    const r = extractCssRules('/* multi\n   line */\n.x { color: red; }');
    expect(r).toHaveLength(1);
    expect(r[0]!.selector).toBe('.x');
    expect(r[0]!.line).toBe(3);
  });

  it('ignores scss line comments', () => {
    expect(extractCssRules('// hidden\n.y { color: red; }')).toHaveLength(1);
  });

  it('unwraps media queries', () => {
    const r = extractCssRules('@media (max-width: 600px) {\n  .m { color: #000; background: #fff; }\n}');
    expect(r.map((x) => x.selector)).toEqual(['.m']);
    expect(r[0]!.line).toBe(2);
  });

  it('skips keyframes and font-face', () => {
    const css = '@keyframes spin { from { color: red; } to { color: blue; } }\n@font-face { font-family: x; src: url(x); }\n.real { color: #000; background: #fff; }';
    expect(extractCssRules(css).map((x) => x.selector)).toEqual(['.real']);
  });

  it('handles nested scss', () => {
    const css = '.parent {\n  color: white;\n  .child { color: black; background: white; }\n  &:hover { color: red; background: black; }\n}';
    const selectors = extractCssRules(css).map((x) => x.selector);
    expect(selectors.length).toBeGreaterThanOrEqual(2);
    expect(selectors.some((s) => s.includes('.parent .child'))).toBe(true);
    expect(selectors.some((s) => s.includes('.parent:hover'))).toBe(true);
  });

  it('nested selector lists expand per member', () => {
    const selectors = extractCssRules('.a, .b { .c { color: red; } }').map((x) => x.selector);
    expect(selectors).toEqual(['.a .c, .b .c']);
  });

  it('parent selector containing $ is substituted literally', () => {
    const selectors = extractCssRules('.$x { &:hover { color: red; } }').map((x) => x.selector);
    expect(selectors).toEqual(['.$x:hover']);
  });

  it('handles comma separated selectors', () => {
    const rules = extractCssRules('a, b { color: red; background: white; }');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector).toContain(',');
  });

  it('gracefully handles unclosed brace', () => {
    expect(() => extractCssRules('.broken { color: red; ')).not.toThrow();
  });

  it('captures declaration line numbers', () => {
    const r = extractCssRules('.x {\n  color: red;\n  background: white;\n}')[0]!;
    expect(r.declarations[0]!.property).toBe('color');
    expect(r.declarations[0]!.line).toBe(2);
    expect(r.declarations[1]!.line).toBe(3);
  });

  it('tolerates semicolon-terminated import', () => {
    expect(extractCssRules('@import "base.css";\n.x { color: red; background: white; }')).toHaveLength(1);
  });

  it('braces inside strings do not end the block', () => {
    const r = extractCssRules('.q { content: "}"; color: #000; background: #fff; }');
    expect(r).toHaveLength(1);
    expect(r[0]!.declarations.map((d) => d.property)).toContain('background');
  });

  it('pathological nesting does not overflow the stack', () => {
    const deep = '.a{'.repeat(5000) + 'color:red;' + '}'.repeat(5000);
    expect(() => extractCssRules(deep)).not.toThrow();
  });
});

describe('scanCss', () => {
  it('detects failing pair in css', () => {
    const f = scanCss('.bad { color: #888; background-color: #fff; }', 'test.css');
    expect(f).toHaveLength(1);
    expect(f[0]!.foreground).toBe('#888888');
    expect(f[0]!.background).toBe('#FFFFFF');
    expect(f[0]!.wcagLevel).toBe('FAIL');
    expect(f[0]!.passesAA).toBe(false);
    expect(f[0]!.largeText).toBe(false);
    expect(f[0]!.issueType).toBe('TEXT_CONTRAST');
  });

  it('detects passing AAA pair', () => {
    const f = scanCss('.ok { color: #000; background-color: #fff; }')[0]!;
    expect(f.wcagLevel).toBe('AAA');
    expect(f.passesAA).toBe(true);
    expect(f.ratio).toBeCloseTo(21, 2);
  });

  it('skips ruleset without both colors', () => {
    expect(scanCss('.onlyColor { color: #fff; } .onlyBg { background-color: #000; }')).toHaveLength(0);
  });

  it('uses background shorthand color', () => {
    expect(scanCss('.s { color: #fff; background: #222 url(x.png) no-repeat; }')[0]!.background).toBe('#222222');
  });

  it('last declaration wins', () => {
    expect(scanCss('.s { color: #fff; color: #000; background: #fff; }')[0]!.foreground).toBe('#000000');
  });

  it('detects large text via font-size', () => {
    expect(scanCss('.big { color: #888; background: #fff; font-size: 24px; }')[0]!.largeText).toBe(true);
  });

  it('bold 700 triggers large-text at 18.66 px', () => {
    expect(scanCss('.bbb { color: #777; background:#fff; font-size: 19px; font-weight: 700; }')[0]!.largeText).toBe(true);
  });

  it('reports the line of the color declaration', () => {
    expect(scanCss('\n.x {\n  background: #fff;\n  color: #999;\n}')[0]!.line).toBe(4);
  });

  it('does not crash on invalid color values - ignores ruleset', () => {
    expect(scanCss('.x { color: notacolor; background: alsonot; }')).toHaveLength(0);
  });
});

describe('scanHtmlInline', () => {
  it('inline html style is scanned', () => {
    const f = scanHtmlInline('<p style="color:#000;background:#fff">hi</p>', 'p.html');
    expect(f).toHaveLength(1);
    expect(f[0]!.selector).toBe('<p>');
    expect(f[0]!.wcagLevel).toBe('AAA');
  });

  it('reports the line of the element', () => {
    expect(scanHtmlInline('<div>\n\n<p style="color:#fff;background:#fff">x</p>')[0]!.line).toBe(3);
  });
});

describe('scanContrast', () => {
  it('embedded style tag in html is scanned', () => {
    const html = [
      '<html><head>',
      '  <style>',
      '    .x { color: #000; background-color: #fff; }',
      '  </style>',
      '</head><body><span style="color:#fff;background:#fff">low</span></body></html>',
    ].join('\n');
    const f = scanContrast(html, 'page.html');
    expect(f).toHaveLength(2);
    expect(f.some((x) => x.selector === '.x' && x.wcagLevel === 'AAA' && x.line === 3)).toBe(true);
    expect(f.some((x) => x.selector === '<span>' && x.wcagLevel === 'FAIL')).toBe(true);
  });

  it('supports scss extension', () => {
    const f = scanContrast('.a { color: #fff; background:#000; }', 'src/main.scss');
    expect(f).toHaveLength(1);
    expect(f[0]!.filePath.endsWith('main.scss')).toBe(true);
  });

  it('supports cshtml razor view with inline styles', () => {
    const src = [
      '@model IndexViewModel',
      '<html><head>',
      '  <style>',
      '    .ok { color: #000; background-color: #fff; }',
      '  </style>',
      '</head><body>',
      '  <h1 style="color:#888;background:#fff">@Model.Title</h1>',
      '  <span style="color:#fff;background:#fff">@Model.Subtitle</span>',
      '</body></html>',
    ].join('\n');
    const f = scanContrast(src, 'Views/Index.cshtml');
    expect(f).toHaveLength(3);
    expect(f.some((x) => x.selector === '.ok' && x.wcagLevel === 'AAA')).toBe(true);
    expect(f.some((x) => x.selector === '<h1>' && x.wcagLevel === 'FAIL')).toBe(true);
    expect(f.some((x) => x.selector === '<span>' && x.wcagLevel === 'FAIL')).toBe(true);
    expect(f.every((x) => x.filePath.endsWith('Index.cshtml'))).toBe(true);
  });

  it('supports blazor razor component with inline styles', () => {
    const src = [
      '@page "/counter"',
      '<style>',
      '  .warn { color: #888; background-color: #fff; }',
      '</style>',
      '<p style="color:#fff;background:#000">@currentCount</p>',
      '@code {',
      '    private int currentCount = 0;',
      '}',
    ].join('\n');
    const f = scanContrast(src, 'Counter.razor');
    expect(f).toHaveLength(2);
    expect(f.some((x) => x.selector === '.warn' && x.wcagLevel === 'FAIL')).toBe(true);
    expect(f.some((x) => x.selector === '<p>' && x.wcagLevel === 'AAA')).toBe(true);
  });

  it('extension sets advertise razor, cshtml and less', () => {
    expect(HTML_EXTENSIONS.has('razor')).toBe(true);
    expect(HTML_EXTENSIONS.has('cshtml')).toBe(true);
    expect(CSS_EXTENSIONS.has('less')).toBe(true);
  });

  it('returns empty for unsupported extension (including jsx)', () => {
    expect(scanContrast('class A', 'x.kt')).toEqual([]);
    expect(scanContrast('<p style="color:#fff;background:#fff">x</p>', 'App.tsx')).toEqual([]);
    expect(scanContrast('.a{color:#fff;background:#fff}', 'README')).toEqual([]);
  });
});

describe('extractColorFromShorthand', () => {
  it('picks first color token', () => {
    const picked = extractColorFromShorthand({ property: 'background', value: 'url(x.png) #abc no-repeat', line: 3 });
    expect(picked?.value).toBe('#abc');
    expect(picked?.line).toBe(3);
  });

  it('returns null without a color token', () => {
    expect(extractColorFromShorthand({ property: 'background', value: 'url(x.png)', line: 1 })).toBeNull();
  });
});
