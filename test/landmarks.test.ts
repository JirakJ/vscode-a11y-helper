import { describe, expect, it } from 'vitest';
import { analyzeLandmarks, landmarkKindFromRoleName, landmarkReportToMarkdown } from '../src/core/landmarks';

const analyze = analyzeLandmarks;

describe('analyzeLandmarks — empty / malformed', () => {
  it('empty content yields an empty report with score zero', () => {
    const r = analyze('', 'empty.html');
    expect(r.totalLandmarkCount).toBe(0);
    expect(r.score).toBe(0);
    expect(r.missingRequired).toHaveLength(4);
    expect(r.duplicateTopLevel).toHaveLength(0);
    expect(r.issues.every((i) => i.severity === 'ERROR')).toBe(true);
  });

  it('blank content behaves like empty', () => {
    expect(analyze('   \n\t   ', 'blank.html').totalLandmarkCount).toBe(0);
  });

  it('unterminated tag does not crash', () => {
    const r = analyze('<main><nav', 'bad.html');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.kind).toBe('main');
  });

  it('unterminated quoted attribute terminates tokenisation cleanly', () => {
    expect(analyze('<main aria-label="oops', 'bad.html').totalLandmarkCount).toBe(0);
  });

  it('content with only comments and doctype has no landmarks', () => {
    expect(analyze('<!DOCTYPE html><!-- <main> --><?xml ?>', 'doc.html').totalLandmarkCount).toBe(0);
  });

  it('text in script body is ignored', () => {
    const r = analyze("<script>var html = '<main></main>';</script><nav></nav>", 'p.html');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.kind).toBe('navigation');
  });

  it('text in style body is ignored', () => {
    expect(analyze('<style>main { color: red }</style><main></main>', 'p.html').totalLandmarkCount).toBe(1);
  });

  it('cdata section is skipped', () => {
    const r = analyze('<![CDATA[ <main></main> ]]><nav></nav>', 'p.xml');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.kind).toBe('navigation');
  });
});

describe('HTML5 semantic tags', () => {
  it('main nav header footer aside are detected as landmarks', () => {
    const src = '<header></header>\n<nav></nav>\n<main></main>\n<aside></aside>\n<footer></footer>';
    const r = analyze(src, 'p.html');
    expect(r.totalLandmarkCount).toBe(5);
    expect(new Set(r.occurrences.map((o) => o.kind))).toEqual(
      new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo']),
    );
    expect(r.missingRequired).toHaveLength(0);
  });

  it('self closing html5 elements are detected', () => {
    expect(analyze('<main/><nav/>', 'p.html').totalLandmarkCount).toBe(2);
  });

  it('uppercase HTML tags are not treated as landmarks', () => {
    expect(analyze('<Main></Main><Nav></Nav>', 'p.tsx').totalLandmarkCount).toBe(0);
  });

  it('role presentation / none suppresses implicit role', () => {
    expect(analyze('<main role="presentation"></main>', 'p.html').totalLandmarkCount).toBe(0);
    expect(analyze('<main role="none"></main>', 'p.html').totalLandmarkCount).toBe(0);
  });
});

describe('header/footer nesting rule', () => {
  it('header nested in main does not produce banner', () => {
    const r = analyze('<main><header></header></main>', 'p.html');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.kind).toBe('main');
  });

  it('footer nested in article does not produce contentinfo', () => {
    expect(analyze('<article><footer></footer></article>', 'p.html').totalLandmarkCount).toBe(0);
  });

  it('header nested inside section is suppressed', () => {
    const r = analyze('<section aria-label="s"><header></header></section>', 'p.html');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.kind).toBe('region');
  });

  it('top level header AFTER nested article still emits banner', () => {
    const r = analyze('<article></article><header></header>', 'p.html');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.kind).toBe('banner');
  });

  it('top level footer emits contentinfo', () => {
    const r = analyze('<footer></footer>', 'p.html');
    expect(r.occurrences[0]!.kind).toBe('contentinfo');
  });
});

describe('section and form naming rule', () => {
  it('section without name is not a landmark', () => {
    expect(analyze('<section></section>', 'p.html').totalLandmarkCount).toBe(0);
  });

  it('section with aria-label becomes region', () => {
    const r = analyze('<section aria-label="News"></section>', 'p.html');
    expect(r.occurrences[0]!.kind).toBe('region');
    expect(r.occurrences[0]!.accessibleName).toBe('News');
  });

  it('section with aria-labelledby becomes region', () => {
    expect(analyze('<section aria-labelledby="h1"></section>', 'p.html').occurrences[0]!.kind).toBe('region');
  });

  it('form without name is not a landmark', () => {
    expect(analyze('<form></form>', 'p.html').totalLandmarkCount).toBe(0);
  });

  it('form with aria-label becomes form landmark', () => {
    const r = analyze('<form aria-label="Login"></form>', 'p.html');
    expect(r.occurrences[0]!.kind).toBe('form');
    expect(r.occurrences[0]!.accessibleName).toBe('Login');
  });

  it('title attribute counts as accessible name fallback', () => {
    const r = analyze('<section title="T"></section>', 'p.html');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.accessibleName).toBe('T');
  });

  it('empty aria-label does not name the section', () => {
    expect(analyze('<section aria-label="   "></section>', 'p.html').totalLandmarkCount).toBe(0);
  });
});

describe('explicit ARIA roles', () => {
  it('div with role=main becomes main landmark', () => {
    const o = analyze('<div role="main"></div>', 'p.html').occurrences[0]!;
    expect(o.kind).toBe('main');
    expect(o.source).toBe('EXPLICIT_ROLE');
  });

  it('role search / form / region are detected', () => {
    expect(analyze('<div role="search"></div>', 'p.html').occurrences[0]!.kind).toBe('search');
    expect(analyze('<div role="form"></div>', 'p.html').occurrences[0]!.kind).toBe('form');
    expect(analyze('<div role="region" aria-label="Widgets"></div>', 'p.html').occurrences[0]!.kind).toBe('region');
  });

  it('JSX component with explicit role is recognised', () => {
    const r = analyze('<MyNav role="navigation"/>', 'p.tsx');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.kind).toBe('navigation');
    expect(r.occurrences[0]!.source).toBe('EXPLICIT_ROLE');
  });

  it('JSX component without role is not a landmark', () => {
    expect(analyze('<Nav></Nav><Footer></Footer>', 'p.tsx').totalLandmarkCount).toBe(0);
  });

  it('role banner with mixed case is normalised', () => {
    expect(analyze('<div role="BaNnEr"></div>', 'p.html').occurrences[0]!.kind).toBe('banner');
  });

  it('unknown role is ignored', () => {
    expect(analyze('<div role="frobnicator"></div>', 'p.html').totalLandmarkCount).toBe(0);
  });

  it('explicit role overrides implicit role', () => {
    const r = analyze('<nav role="search"></nav>', 'p.html');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.kind).toBe('search');
    expect(r.occurrences[0]!.source).toBe('EXPLICIT_ROLE');
  });
});

describe('JSX / positions', () => {
  it('JSX expression in attribute is skipped safely', () => {
    const r = analyze('<main className={styles.root} aria-label="Primary"></main>', 'p.tsx');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.accessibleName).toBe('Primary');
  });

  it('jsx with multiline attributes preserves line number of opening tag', () => {
    const r = analyze('<main\n    id="m"\n    aria-label="x">\n</main>\n<nav></nav>', 'p.tsx');
    expect(r.totalLandmarkCount).toBe(2);
    expect(r.occurrences[0]!.line).toBe(1);
    expect(r.occurrences[1]!.line).toBe(5);
  });

  it('reports accurate line and column', () => {
    const r = analyze('line 1\n  <main></main>\n<nav></nav>', 'p.html');
    expect(r.occurrences[0]!.line).toBe(2);
    expect(r.occurrences[0]!.column).toBe(3);
    expect(r.occurrences[1]!.line).toBe(3);
    expect(r.occurrences[1]!.column).toBe(1);
  });
});

describe('required / duplicates / score', () => {
  it('all four required landmarks present yields score at least 80', () => {
    const r = analyze('<header></header><nav></nav><main></main><footer></footer>', 'p.html');
    expect(r.missingRequired).toHaveLength(0);
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  it('missing required landmarks appear in report', () => {
    const r = analyze('<main></main>', 'p.html');
    expect(r.missingRequired).toEqual(expect.arrayContaining(['navigation', 'banner', 'contentinfo']));
    expect(r.missingRequired).not.toContain('main');
    expect(r.issues.find((i) => i.roleName === 'navigation')!.message).toBe('Required landmark `navigation` is missing.');
  });

  it('duplicate unnamed main is reported as duplicate', () => {
    const r = analyze('<main></main><main></main>', 'p.html');
    expect(r.duplicateTopLevel).toContain('main');
    const w = r.issues.find((i) => i.severity === 'WARNING' && i.kind === 'main');
    expect(w?.message).toBe('Multiple `main` landmarks without unique accessible names (at 1:1, 1:14).');
  });

  it('two mains with distinct names are not flagged', () => {
    expect(analyze('<main aria-label="A"></main><main aria-label="B"></main>', 'p.html').duplicateTopLevel).not.toContain('main');
  });

  it('complementary and search give bonus score', () => {
    const src = '<header></header><nav></nav><main></main><footer></footer>\n<aside></aside><div role="search"></div>';
    expect(analyze(src, 'p.html').score).toBeGreaterThan(90);
  });

  it('score is clamped to 100', () => {
    const src = '<header></header><nav></nav><main></main><footer></footer>\n<aside></aside><div role="search"></div>\n<section aria-label="A"></section><form aria-label="F"></form>';
    const r = analyze(src, 'p.html');
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(95);
  });
});

describe('markdown rendering', () => {
  it('renders score, file and occurrences', () => {
    const md = landmarkReportToMarkdown(analyze('<main></main><nav></nav>', 'page.html'));
    expect(md).toContain('# ARIA Landmark Coverage Report');
    expect(md).toContain('page.html');
    expect(md).toContain('main');
    expect(md).toContain('navigation');
  });

  it('empty report is still valid', () => {
    const md = landmarkReportToMarkdown(analyze('', 'x.html'));
    expect(md).toContain('_No landmarks detected._');
    expect(md).toContain('_None._');
  });
});

describe('landmarkKindFromRoleName', () => {
  it('null and blank return null', () => {
    expect(landmarkKindFromRoleName(null)).toBeNull();
    expect(landmarkKindFromRoleName('')).toBeNull();
    expect(landmarkKindFromRoleName('   ')).toBeNull();
  });

  it('case insensitive match', () => {
    expect(landmarkKindFromRoleName('Main')).toBe('main');
    expect(landmarkKindFromRoleName('  NAVIGATION ')).toBe('navigation');
  });

  it('unknown returns null', () => {
    expect(landmarkKindFromRoleName('button')).toBeNull();
  });
});

describe('miscellaneous', () => {
  it('mixed case tag names with attributes are parsed', () => {
    expect(analyze('<Main role="main" DATA-X="1"/>', 'p.tsx').totalLandmarkCount).toBe(1);
  });

  it('multiline document with many landmarks keeps order', () => {
    const src = '<header></header>\n<nav></nav>\n<main>\n  <section aria-label="inner"></section>\n</main>\n<aside></aside>\n<footer></footer>\n';
    expect(analyze(src, 'p.html').occurrences.map((o) => o.kind)).toEqual(
      ['banner', 'navigation', 'main', 'region', 'complementary', 'contentinfo'],
    );
  });

  it('attribute without value is tolerated', () => {
    expect(analyze('<main hidden></main>', 'p.html').totalLandmarkCount).toBe(1);
  });

  it('single quoted and unquoted attribute values are parsed', () => {
    expect(analyze("<section aria-label='Hello'></section>", 'p.html').occurrences[0]!.accessibleName).toBe('Hello');
    expect(analyze('<div role=main></div>', 'p.html').occurrences[0]!.kind).toBe('main');
  });

  it('void element does not push onto ancestor stack', () => {
    const r = analyze('<img src=x><header></header>', 'p.html');
    expect(r.totalLandmarkCount).toBe(1);
    expect(r.occurrences[0]!.kind).toBe('banner');
  });

  it('counts map excludes zero entries', () => {
    const r = analyze('<main></main>', 'p.html');
    expect(r.countsByKind.get('main')).toBe(1);
    expect(r.countsByKind.has('search')).toBe(false);
  });

  it('report fields are populated consistently', () => {
    const r = analyze('<main></main>', 'file.html');
    expect(r.fileName).toBe('file.html');
    expect(r.occurrences.length).toBe(r.totalLandmarkCount);
  });
});
