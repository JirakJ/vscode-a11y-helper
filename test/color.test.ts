import { describe, expect, it } from 'vitest';
import {
  approxEquals, contrastRatio, cssFontSizeToPx, isLargeText, namedColors, parseColor, passesAA, passesAAA,
  passesNonText, relativeLuminance, rgba, round1, toHex,
} from '../src/core/color';

describe('parseColor', () => {
  it('parses 6-digit hex', () => {
    expect(parseColor('#FF0000')).toEqual(rgba(255, 0, 0));
    expect(parseColor('#123456')).toEqual(rgba(0x12, 0x34, 0x56));
  });

  it('parses 3-digit hex', () => {
    expect(parseColor('#fff')).toEqual(rgba(255, 255, 255));
    expect(parseColor('#ABC')).toEqual(rgba(0xaa, 0xbb, 0xcc));
  });

  it('parses 8-digit hex with alpha', () => {
    const c = parseColor('#112233AA')!;
    expect([c.r, c.g, c.b]).toEqual([0x11, 0x22, 0x33]);
    expect(c.a).toBeGreaterThanOrEqual(0.66);
    expect(c.a).toBeLessThanOrEqual(0.67);
  });

  it('parses 4-digit hex with alpha', () => {
    const c = parseColor('#fff8')!;
    expect([c.r, c.g, c.b]).toEqual([255, 255, 255]);
    expect(c.a).toBeGreaterThanOrEqual(0.53);
    expect(c.a).toBeLessThanOrEqual(0.54);
  });

  it('parses rgb functional integer and percentage', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual(rgba(10, 20, 30));
    expect(parseColor('rgb(100%, 0%, 50%)')).toEqual(rgba(255, 0, 128));
  });

  it('parses rgba with alpha and modern slash alpha', () => {
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual(rgba(255, 0, 0, 0.5));
    const c = parseColor('rgb(255 0 0 / 0.25)')!;
    expect(c.r).toBe(255);
    expect(c.a).toBeCloseTo(0.25, 3);
  });

  it('parses hsl functional', () => {
    expect(approxEquals(parseColor('hsl(0, 100%, 50%)')!, rgba(255, 0, 0))).toBe(true);
    expect(approxEquals(parseColor('hsl(240, 100%, 50%)')!, rgba(0, 0, 255))).toBe(true);
    expect(approxEquals(parseColor('hsl(0, 0%, 50%)')!, rgba(128, 128, 128))).toBe(true);
  });

  it('parses hsl with deg turn rad grad', () => {
    for (const s of ['hsl(360deg, 100%, 50%)', 'hsl(1turn, 100%, 50%)', 'hsl(400grad, 100%, 50%)', 'hsl(6.283185rad, 100%, 50%)']) {
      expect(approxEquals(parseColor(s)!, rgba(255, 0, 0))).toBe(true);
    }
  });

  it('parses hsla alpha', () => {
    expect(parseColor('hsla(0, 100%, 50%, 0.25)')!.a).toBeCloseTo(0.25, 3);
  });

  it('parses named colors case-insensitively', () => {
    expect(parseColor('white')).toEqual(rgba(255, 255, 255));
    expect(parseColor('BLACK')).toEqual(rgba(0, 0, 0));
    expect(parseColor('red')).toEqual(rgba(255, 0, 0));
    expect(parseColor('rebeccapurple')).toEqual(rgba(102, 51, 153));
  });

  it('parses transparent as alpha zero', () => {
    expect(parseColor('transparent')!.a).toBe(0);
  });

  it('parses compose color literals', () => {
    expect(parseColor('Color(0xFFFF0000)')).toEqual(rgba(255, 0, 0, 1));
    expect(parseColor('Color(0x00FF00)')).toEqual(rgba(0, 255, 0, 1));
  });

  it('parses swift UIColor', () => {
    expect(parseColor('UIColor(red: 1.0, green: 0.0, blue: 0.0, alpha: 1.0)')).toEqual(rgba(255, 0, 0, 1));
    expect(approxEquals(parseColor('UIColor(red: 0.5, green: 0.5, blue: 0.5)')!, rgba(128, 128, 128))).toBe(true);
  });

  it('returns null for unknown input', () => {
    for (const s of ['notacolor', '', '#ZZZ', 'rgb(foo, bar, baz)', 'hsl(0, 100, 50)', '#12345', 'Color(0xZZ)']) {
      expect(parseColor(s)).toBeNull();
    }
    expect(parseColor(null)).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });

  it('trims trailing semicolon and whitespace', () => {
    expect(parseColor('   #fff ;  ')).not.toBeNull();
  });

  it('clamps out-of-range alpha', () => {
    expect(parseColor('rgba(10,20,30,2.0)')!.a).toBe(1);
  });
});

describe('rgba / toHex / namedColors', () => {
  it('toHex serializes uppercase rrggbb', () => {
    expect(toHex(rgba(255, 0, 170))).toBe('#FF00AA');
  });

  it('named colors set is large', () => {
    expect(namedColors().size).toBeGreaterThan(140);
    expect(namedColors().has('tomato')).toBe(true);
  });

  it('rgba validates ranges', () => {
    expect(() => rgba(-1, 0, 0)).toThrow(RangeError);
    expect(() => rgba(0, 0, 0, 2)).toThrow(RangeError);
  });
});

describe('contrast math', () => {
  const black = rgba(0, 0, 0);
  const white = rgba(255, 255, 255);

  it('black on white is 21, white on white is 1', () => {
    expect(round1(contrastRatio(black, white))).toBeCloseTo(21, 2);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 3);
  });

  it('ratio is symmetric', () => {
    expect(contrastRatio(black, white)).toBeCloseTo(contrastRatio(white, black), 9);
  });

  it('known pair #777 on #fff is approx 4.48', () => {
    const r = contrastRatio(rgba(0x77, 0x77, 0x77), white);
    expect(r).toBeGreaterThan(4.4);
    expect(r).toBeLessThan(4.55);
  });

  it('passesAA thresholds', () => {
    expect(passesAA(4.5, false)).toBe(true);
    expect(passesAA(4.49, false)).toBe(false);
    expect(passesAA(3.0, true)).toBe(true);
    expect(passesAA(2.99, true)).toBe(false);
  });

  it('passesAAA thresholds', () => {
    expect(passesAAA(7.0, false)).toBe(true);
    expect(passesAAA(6.99, false)).toBe(false);
    expect(passesAAA(4.5, true)).toBe(true);
    expect(passesAAA(4.49, true)).toBe(false);
  });

  it('passesNonText threshold', () => {
    expect(passesNonText(3.0)).toBe(true);
    expect(passesNonText(2.99)).toBe(false);
  });

  it('isLargeText interprets px, pt and rem', () => {
    expect(isLargeText('24px', false)).toBe(true);
    expect(isLargeText('16px', false)).toBe(false);
    expect(isLargeText('19px', true)).toBe(true);
    expect(isLargeText('18pt', false)).toBe(true);
    expect(isLargeText('17pt', false)).toBe(false);
    expect(isLargeText('1.5rem', true)).toBe(true);
    expect(isLargeText(null, false)).toBe(false);
    expect(isLargeText('', false)).toBe(false);
    expect(isLargeText('junk', false)).toBe(false);
  });

  it('cssFontSizeToPx supports percent, em and pt', () => {
    expect(cssFontSizeToPx('100%')).toBeCloseTo(16, 2);
    expect(cssFontSizeToPx('2em')).toBeCloseTo(32, 2);
    expect(cssFontSizeToPx('18pt')).toBeCloseTo(24, 2);
    expect(cssFontSizeToPx('12')).toBe(12);
  });

  it('relativeLuminance boundaries', () => {
    expect(relativeLuminance(white)).toBeCloseTo(1, 9);
    expect(relativeLuminance(black)).toBeCloseTo(0, 9);
  });
});
