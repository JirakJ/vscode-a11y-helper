/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Color parsing and the WCAG 2.x contrast-ratio formula.
 * https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
 * https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
 */

/** Immutable RGBA color. Channels are 0..255 integers; alpha is 0..1. */
export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Creates a validated {@link RgbaColor}; throws `RangeError` on out-of-range input. */
export function rgba(r: number, g: number, b: number, a = 1.0): RgbaColor {
  const channelOk = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= 255;
  if (!channelOk(r)) throw new RangeError(`r out of range: ${r}`);
  if (!channelOk(g)) throw new RangeError(`g out of range: ${g}`);
  if (!channelOk(b)) throw new RangeError(`b out of range: ${b}`);
  if (!(a >= 0 && a <= 1)) throw new RangeError(`a out of range: ${a}`);
  return Object.freeze({ r, g, b, a });
}

/** `#RRGGBB` representation (uppercase, alpha discarded). */
export function toHex(c: RgbaColor): string {
  const h = (v: number): string => v.toString(16).toUpperCase().padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

const NAMED_RAW: [string, number][] = [
  ['aliceblue', 0xf0f8ff], ['antiquewhite', 0xfaebd7], ['aqua', 0x00ffff],
  ['aquamarine', 0x7fffd4], ['azure', 0xf0ffff], ['beige', 0xf5f5dc],
  ['bisque', 0xffe4c4], ['black', 0x000000], ['blanchedalmond', 0xffebcd],
  ['blue', 0x0000ff], ['blueviolet', 0x8a2be2], ['brown', 0xa52a2a],
  ['burlywood', 0xdeb887], ['cadetblue', 0x5f9ea0], ['chartreuse', 0x7fff00],
  ['chocolate', 0xd2691e], ['coral', 0xff7f50], ['cornflowerblue', 0x6495ed],
  ['cornsilk', 0xfff8dc], ['crimson', 0xdc143c], ['cyan', 0x00ffff],
  ['darkblue', 0x00008b], ['darkcyan', 0x008b8b], ['darkgoldenrod', 0xb8860b],
  ['darkgray', 0xa9a9a9], ['darkgrey', 0xa9a9a9], ['darkgreen', 0x006400],
  ['darkkhaki', 0xbdb76b], ['darkmagenta', 0x8b008b], ['darkolivegreen', 0x556b2f],
  ['darkorange', 0xff8c00], ['darkorchid', 0x9932cc], ['darkred', 0x8b0000],
  ['darksalmon', 0xe9967a], ['darkseagreen', 0x8fbc8f], ['darkslateblue', 0x483d8b],
  ['darkslategray', 0x2f4f4f], ['darkslategrey', 0x2f4f4f], ['darkturquoise', 0x00ced1],
  ['darkviolet', 0x9400d3], ['deeppink', 0xff1493], ['deepskyblue', 0x00bfff],
  ['dimgray', 0x696969], ['dimgrey', 0x696969], ['dodgerblue', 0x1e90ff],
  ['firebrick', 0xb22222], ['floralwhite', 0xfffaf0], ['forestgreen', 0x228b22],
  ['fuchsia', 0xff00ff], ['gainsboro', 0xdcdcdc], ['ghostwhite', 0xf8f8ff],
  ['gold', 0xffd700], ['goldenrod', 0xdaa520], ['gray', 0x808080],
  ['grey', 0x808080], ['green', 0x008000], ['greenyellow', 0xadff2f],
  ['honeydew', 0xf0fff0], ['hotpink', 0xff69b4], ['indianred', 0xcd5c5c],
  ['indigo', 0x4b0082], ['ivory', 0xfffff0], ['khaki', 0xf0e68c],
  ['lavender', 0xe6e6fa], ['lavenderblush', 0xfff0f5], ['lawngreen', 0x7cfc00],
  ['lemonchiffon', 0xfffacd], ['lightblue', 0xadd8e6], ['lightcoral', 0xf08080],
  ['lightcyan', 0xe0ffff], ['lightgoldenrodyellow', 0xfafad2], ['lightgray', 0xd3d3d3],
  ['lightgrey', 0xd3d3d3], ['lightgreen', 0x90ee90], ['lightpink', 0xffb6c1],
  ['lightsalmon', 0xffa07a], ['lightseagreen', 0x20b2aa], ['lightskyblue', 0x87cefa],
  ['lightslategray', 0x778899], ['lightslategrey', 0x778899], ['lightsteelblue', 0xb0c4de],
  ['lightyellow', 0xffffe0], ['lime', 0x00ff00], ['limegreen', 0x32cd32],
  ['linen', 0xfaf0e6], ['magenta', 0xff00ff], ['maroon', 0x800000],
  ['mediumaquamarine', 0x66cdaa], ['mediumblue', 0x0000cd], ['mediumorchid', 0xba55d3],
  ['mediumpurple', 0x9370db], ['mediumseagreen', 0x3cb371], ['mediumslateblue', 0x7b68ee],
  ['mediumspringgreen', 0x00fa9a], ['mediumturquoise', 0x48d1cc], ['mediumvioletred', 0xc71585],
  ['midnightblue', 0x191970], ['mintcream', 0xf5fffa], ['mistyrose', 0xffe4e1],
  ['moccasin', 0xffe4b5], ['navajowhite', 0xffdead], ['navy', 0x000080],
  ['oldlace', 0xfdf5e6], ['olive', 0x808000], ['olivedrab', 0x6b8e23],
  ['orange', 0xffa500], ['orangered', 0xff4500], ['orchid', 0xda70d6],
  ['palegoldenrod', 0xeee8aa], ['palegreen', 0x98fb98], ['paleturquoise', 0xafeeee],
  ['palevioletred', 0xdb7093], ['papayawhip', 0xffefd5], ['peachpuff', 0xffdab9],
  ['peru', 0xcd853f], ['pink', 0xffc0cb], ['plum', 0xdda0dd],
  ['powderblue', 0xb0e0e6], ['purple', 0x800080], ['rebeccapurple', 0x663399],
  ['red', 0xff0000], ['rosybrown', 0xbc8f8f], ['royalblue', 0x4169e1],
  ['saddlebrown', 0x8b4513], ['salmon', 0xfa8072], ['sandybrown', 0xf4a460],
  ['seagreen', 0x2e8b57], ['seashell', 0xfff5ee], ['sienna', 0xa0522d],
  ['silver', 0xc0c0c0], ['skyblue', 0x87ceeb], ['slateblue', 0x6a5acd],
  ['slategray', 0x708090], ['slategrey', 0x708090], ['snow', 0xfffafa],
  ['springgreen', 0x00ff7f], ['steelblue', 0x4682b4], ['tan', 0xd2b48c],
  ['teal', 0x008080], ['thistle', 0xd8bfd8], ['tomato', 0xff6347],
  ['turquoise', 0x40e0d0], ['violet', 0xee82ee], ['wheat', 0xf5deb3],
  ['white', 0xffffff], ['whitesmoke', 0xf5f5f5], ['yellow', 0xffff00],
  ['yellowgreen', 0x9acd32],
];

const NAMED_COLORS = new Map<string, RgbaColor>(
  NAMED_RAW.map(([name, v]) => [name, rgba((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)]),
);
NAMED_COLORS.set('transparent', rgba(0, 0, 0, 0));

/** Supported CSS named colors (lowercase). */
export function namedColors(): ReadonlySet<string> {
  return new Set(NAMED_COLORS.keys());
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** Strict decimal parse (mirrors Kotlin `toDouble()`); `null` when not a number. */
function toNumber(s: string): number | null {
  const t = s.trim();
  return NUMBER.test(t) ? Number(t) : null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const hex2 = (s: string): number => parseInt(s, 16);

function parseHex(s: string): RgbaColor | null {
  if (!s.startsWith('#')) return null;
  const hex = s.substring(1);
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  const d = (k: number): string => hex[k]! + hex[k]!;
  switch (hex.length) {
    case 3: return rgba(hex2(d(0)), hex2(d(1)), hex2(d(2)));
    case 4: return rgba(hex2(d(0)), hex2(d(1)), hex2(d(2)), hex2(d(3)) / 255);
    case 6: return rgba(hex2(hex.substring(0, 2)), hex2(hex.substring(2, 4)), hex2(hex.substring(4, 6)));
    case 8: return rgba(hex2(hex.substring(0, 2)), hex2(hex.substring(2, 4)), hex2(hex.substring(4, 6)), hex2(hex.substring(6, 8)) / 255);
    default: return null;
  }
}

const RGB_FN = /^rgba?\(\s*([^,\s/)]+)[\s,]+([^,\s/)]+)[\s,]+([^,\s/)]+)(?:\s*[,/]\s*([^)\s]+))?\s*\)$/i;
const HSL_FN = /^hsla?\(\s*([^,\s/)]+)[\s,]+([^,\s/)]+)[\s,]+([^,\s/)]+)(?:\s*[,/]\s*([^)\s]+))?\s*\)$/i;

function parseChannel(v: string): number | null {
  const t = v.trim();
  if (t.endsWith('%')) {
    const p = toNumber(t.slice(0, -1));
    return p === null ? null : clamp(Math.round((p / 100) * 255), 0, 255);
  }
  const n = toNumber(t);
  return n === null ? null : clamp(Math.round(n), 0, 255);
}

function parseAlpha(v: string): number | null {
  const t = v.trim();
  if (t.endsWith('%')) {
    const p = toNumber(t.slice(0, -1));
    return p === null ? null : clamp(p / 100, 0, 1);
  }
  const n = toNumber(t);
  return n === null ? null : clamp(n, 0, 1);
}

function parseRgbFunctional(s: string): RgbaColor | null {
  const m = RGB_FN.exec(s);
  if (!m) return null;
  const r = parseChannel(m[1]!);
  const g = parseChannel(m[2]!);
  const b = parseChannel(m[3]!);
  if (r === null || g === null || b === null) return null;
  const alpha = m[4] ? parseAlpha(m[4]) ?? 1 : 1;
  return rgba(r, g, b, alpha);
}

function parseHue(v: string): number | null {
  const t = v.trim().toLowerCase();
  let deg: number | null;
  if (t.endsWith('grad')) deg = mul(toNumber(t.slice(0, -4)), 0.9);
  else if (t.endsWith('turn')) deg = mul(toNumber(t.slice(0, -4)), 360);
  else if (t.endsWith('deg')) deg = toNumber(t.slice(0, -3));
  else if (t.endsWith('rad')) deg = mul(toNumber(t.slice(0, -3)), 180 / Math.PI);
  else deg = toNumber(t);
  if (deg === null) return null;
  return ((deg % 360) + 360) % 360;
}

function mul(v: number | null, k: number): number | null {
  return v === null ? null : v * k;
}

function hslToRgb(hDeg: number, s: number, l: number): [number, number, number] {
  const h = hDeg / 360;
  if (s === 0) {
    const v = clamp(Math.round(l * 255), 0, 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    clamp(Math.round(hue2rgb(h + 1 / 3) * 255), 0, 255),
    clamp(Math.round(hue2rgb(h) * 255), 0, 255),
    clamp(Math.round(hue2rgb(h - 1 / 3) * 255), 0, 255),
  ];
}

function parseHslFunctional(s: string): RgbaColor | null {
  const m = HSL_FN.exec(s);
  if (!m) return null;
  const hue = parseHue(m[1]!);
  if (hue === null) return null;
  const sRaw = m[2]!.trim();
  const lRaw = m[3]!.trim();
  if (!sRaw.endsWith('%') || !lRaw.endsWith('%')) return null;
  const sat = toNumber(sRaw.slice(0, -1));
  const lit = toNumber(lRaw.slice(0, -1));
  if (sat === null || lit === null) return null;
  const alpha = m[4] ? parseAlpha(m[4]) ?? 1 : 1;
  const [r, g, b] = hslToRgb(hue, clamp(sat / 100, 0, 1), clamp(lit / 100, 0, 1));
  return rgba(r, g, b, alpha);
}

const COMPOSE_FN = /^Color\(\s*0x([0-9A-Fa-f]{6,8})\s*\)$/;

function parseCompose(s: string): RgbaColor | null {
  const m = COMPOSE_FN.exec(s);
  if (!m) return null;
  const hex = m[1]!;
  if (hex.length === 6) return rgba(hex2(hex.substring(0, 2)), hex2(hex.substring(2, 4)), hex2(hex.substring(4, 6)));
  if (hex.length === 8) {
    return rgba(hex2(hex.substring(2, 4)), hex2(hex.substring(4, 6)), hex2(hex.substring(6, 8)), hex2(hex.substring(0, 2)) / 255);
  }
  return null;
}

const SWIFT_FN = /^UIColor\(\s*red:\s*([0-9.]+)\s*,\s*green:\s*([0-9.]+)\s*,\s*blue:\s*([0-9.]+)\s*(?:,\s*alpha:\s*([0-9.]+)\s*)?\)$/;

function parseSwift(s: string): RgbaColor | null {
  const m = SWIFT_FN.exec(s);
  if (!m) return null;
  const r = toNumber(m[1]!);
  const g = toNumber(m[2]!);
  const b = toNumber(m[3]!);
  if (r === null || g === null || b === null) return null;
  const a = m[4] ? toNumber(m[4]) ?? 1 : 1;
  const norm = (v: number): number => clamp(Math.round(clamp(v, 0, 1) * 255), 0, 255);
  return rgba(norm(r), norm(g), norm(b), clamp(a, 0, 1));
}

/**
 * Parses one color literal: hex (3/4/6/8 digits), `rgb()/rgba()`,
 * `hsl()/hsla()`, CSS keywords, Compose `Color(0xAARRGGBB)` and Swift
 * `UIColor(red:…, green:…, blue:…, alpha:…)`. Unknown input returns `null`.
 */
export function parseColor(input: string | null | undefined): RgbaColor | null {
  if (input === null || input === undefined) return null;
  let s = input.trim();
  if (s.endsWith(';')) s = s.slice(0, -1);
  s = s.trim();
  if (s.length === 0) return null;
  return parseHex(s)
    ?? parseRgbFunctional(s)
    ?? parseHslFunctional(s)
    ?? parseCompose(s)
    ?? parseSwift(s)
    ?? NAMED_COLORS.get(s.toLowerCase())
    ?? null;
}

/** Approximate color equality tolerating rounding (channels ± `tolerance`, alpha < 0.01). */
export function approxEquals(a: RgbaColor, b: RgbaColor, tolerance = 1): boolean {
  return Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance
    && Math.abs(a.b - b.b) <= tolerance && Math.abs(a.a - b.a) < 0.01;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance (0..1) per the WCAG 2.x sRGB definition. Alpha is ignored. */
export function relativeLuminance(c: RgbaColor): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** Contrast ratio (1..21) between two colors. Order-independent. */
export function contrastRatio(fg: RgbaColor, bg: RgbaColor): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Rounds to one decimal place. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** WCAG 1.4.3 (AA): 4.5:1 normal, 3:1 large text. */
export function passesAA(ratio: number, largeText: boolean): boolean {
  return ratio + 1e-9 >= (largeText ? 3.0 : 4.5);
}

/** WCAG 1.4.6 (AAA): 7:1 normal, 4.5:1 large text. */
export function passesAAA(ratio: number, largeText: boolean): boolean {
  return ratio + 1e-9 >= (largeText ? 4.5 : 7.0);
}

/** WCAG 1.4.11 Non-text Contrast: 3:1. */
export function passesNonText(ratio: number): boolean {
  return ratio + 1e-9 >= 3.0;
}

/** Converts a CSS font size (`16px`, `1.25rem`, `18pt`, `120%`) to px assuming a 16px root; `null` when unparseable. */
export function cssFontSizeToPx(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  const m = /^(-?[0-9]*\.?[0-9]+)\s*([a-z%]*)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (Number.isNaN(n)) return null;
  const unit = m[2] || 'px';
  if (unit.startsWith('px')) return n;
  if (unit.startsWith('pt')) return n * (96 / 72);
  if (unit.startsWith('rem')) return n * 16;
  if (unit.startsWith('em')) return n * 16;
  if (unit.startsWith('%')) return (n / 100) * 16;
  return n;
}

/** WCAG "large text": ≥ 18pt (24px) regular or ≥ 14pt (≈18.66px) bold. */
export function isLargeText(fontSizeCss: string | null | undefined, bold: boolean): boolean {
  if (fontSizeCss === null || fontSizeCss === undefined || fontSizeCss.trim().length === 0) return false;
  const px = cssFontSizeToPx(fontSizeCss);
  if (px === null) return false;
  return bold ? px >= 18.66 : px >= 24.0;
}
