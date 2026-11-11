/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Color Contrast scanner (WCAG 1.4.3 / 1.4.6 / 1.4.11) for CSS / SCSS / LESS
 * rulesets, `<style>` blocks and inline `style="…"` attributes.
 *
 * Intentionally conservative: no cascade / inheritance resolution — a
 * ruleset that sets only a foreground or only a background is skipped.
 */

import {
  contrastRatio, isLargeText, parseColor, passesAA, passesAAA, round1, toHex, type RgbaColor,
} from './color';

/** A CSS declaration tagged with the line on which it starts (1-based). */
export interface CssDeclaration {
  readonly property: string;
  readonly value: string;
  readonly line: number;
}

/** A ruleset: selector + parsed declarations; `line` is where the selector appeared. */
export interface CssRuleset {
  readonly selector: string;
  readonly declarations: readonly CssDeclaration[];
  readonly line: number;
}

const MAX_NESTING = 128;
const MAX_RETAINED_SELECTOR = 256;
const MAX_SELECTOR_MEMBERS = 64;
const MAX_SELECTOR_CHARS = 4096;
const TRAVERSED_AT_RULES = new Set(['media', 'supports', 'document', 'layer']);

function stripCommentsPreservingLines(input: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === '/' && i + 1 < input.length && input[i + 1] === '*') {
      let j = i + 2;
      while (j + 1 < input.length && !(input[j] === '*' && input[j + 1] === '/')) {
        if (input[j] === '\n') out.push('\n');
        j++;
      }
      i = Math.min(j + 2, input.length);
      continue;
    }
    if (c === '/' && i + 1 < input.length && input[i + 1] === '/') {
      let j = i + 2;
      while (j < input.length && input[j] !== '\n') j++;
      i = j;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

function splitBounded(selector: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start <= selector.length && out.length < MAX_SELECTOR_MEMBERS) {
    let comma = selector.indexOf(',', start);
    if (comma < 0) comma = selector.length;
    const member = selector.substring(start, Math.min(comma, start + MAX_RETAINED_SELECTOR)).trim();
    if (member.length > 0) out.push(member);
    start = comma + 1;
  }
  return out;
}

function combineSelectors(parent: string, child: string): string {
  if (parent.trim().length === 0) return child.slice(0, MAX_SELECTOR_CHARS);
  const childParts = splitBounded(child);
  const parentParts = splitBounded(parent);
  const combos: string[] = [];
  let total = 0;
  outer: for (const p of parentParts) {
    for (const ch of childParts) {
      if (combos.length >= MAX_SELECTOR_MEMBERS || total > MAX_SELECTOR_CHARS) break outer;
      const member = (ch.includes('&') ? ch.replace('&', () => p) : `${p} ${ch}`).slice(0, MAX_SELECTOR_CHARS);
      combos.push(member);
      total += member.length;
    }
  }
  if (combos.length === 0) {
    return (child.includes('&') ? child.replace('&', () => parent) : `${parent} ${child}`).slice(0, MAX_SELECTOR_CHARS);
  }
  return combos.join(', ');
}

/**
 * Extracts rulesets (top-level and nested SCSS/LESS) from CSS-like source.
 * `@media` / `@supports` / `@document` / `@layer` wrappers are unwrapped;
 * other at-rules (`@keyframes`, `@font-face` …) are skipped. Survives braces
 * inside strings and comments; never throws on malformed input.
 */
export function extractCssRules(source: string): CssRuleset[] {
  const src = stripCommentsPreservingLines(source);
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    const clipped = Math.min(Math.max(index, 0), src.length);
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid]! <= clipped) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const findMatchingBrace = (openIdx: number, limit: number): number => {
    let depth = 0;
    let inString: string | null = null;
    for (let i = openIdx; i < limit; i++) {
      const c = src[i];
      if (inString !== null) {
        if (c === inString && src[i - 1] !== '\\') inString = null;
        continue;
      }
      if (c === '"' || c === "'") inString = c;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return limit - 1;
  };

  const parseDeclarations = (from: number, to: number): CssDeclaration[] => {
    const out: CssDeclaration[] = [];
    let i = from;
    let buf = '';
    let bufHasContent = false;
    let declStartLine = lineOf(from);
    const push = (raw: string): void => {
      const colon = raw.indexOf(':');
      if (raw.length > 0 && colon >= 0) {
        out.push({ property: raw.substring(0, colon).trim().toLowerCase(), value: raw.substring(colon + 1).trim(), line: declStartLine });
      }
    };
    while (i < to) {
      const c = src[i]!;
      if (c === '{') {
        let depth = 1;
        i++;
        while (i < to && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          i++;
        }
        buf = ''; bufHasContent = false;
        declStartLine = lineOf(i);
      } else if (c === ';') {
        push(buf.trim());
        buf = ''; bufHasContent = false;
        i++;
        declStartLine = lineOf(i);
      } else {
        if (!bufHasContent && !/\s/.test(c)) { declStartLine = lineOf(i); bufHasContent = true; }
        buf += c;
        i++;
      }
    }
    push(buf.trim());
    return out;
  };

  const result: CssRuleset[] = [];

  // Recursion depth is bounded by MAX_NESTING.
  const parseBlock = (from: number, to: number, parentSelector: string, depth: number): void => {
    if (depth > MAX_NESTING) return;
    let i = from;
    let buf = '';
    while (i < to) {
      const c = src[i];
      if (c === '{') {
        const selector = buf.trim();
        buf = '';
        const closeIdx = findMatchingBrace(i, to);
        if (selector.startsWith('@')) {
          const afterAt = selector.substring(selector.indexOf('@') + 1);
          const sp = afterAt.indexOf(' ');
          const keyword = (sp < 0 ? afterAt : afterAt.substring(0, sp)).toLowerCase();
          if (TRAVERSED_AT_RULES.has(keyword)) {
            parseBlock(i + 1, closeIdx, parentSelector, depth + 1);
          }
        } else {
          const combined = combineSelectors(parentSelector, selector);
          const newlines = selector.split('\n').length - 1;
          const startLine = Math.max(1, lineOf(i) - newlines);
          const decls = parseDeclarations(i + 1, closeIdx);
          const retained = combined.length > MAX_RETAINED_SELECTOR ? combined.slice(0, MAX_RETAINED_SELECTOR) : combined;
          if (decls.length > 0) result.push({ selector: retained, declarations: decls, line: startLine });
          parseBlock(i + 1, closeIdx, combined, depth + 1);
        }
        i = closeIdx + 1;
      } else if (c === '}') {
        i++;
      } else if (c === ';') {
        buf = '';
        i++;
      } else {
        buf += c;
        i++;
      }
    }
  };

  parseBlock(0, src.length, '', 0);
  return result;
}

/** WCAG compliance level assigned to a finding. */
export type ContrastLevel = 'AAA' | 'AA' | 'FAIL';
/** Nature of the contrast issue. */
export type ContrastIssueType = 'TEXT_CONTRAST' | 'NON_TEXT_CONTRAST';

/** A contrast observation; passing pairs are reported too (for pass-rate statistics). */
export interface ContrastFinding {
  readonly filePath: string;
  readonly line: number;
  readonly selector: string;
  /** `#RRGGBB`. */
  readonly foreground: string;
  /** `#RRGGBB`. */
  readonly background: string;
  /** Ratio rounded to one decimal. */
  readonly ratio: number;
  readonly wcagLevel: ContrastLevel;
  readonly largeText: boolean;
  readonly issueType: ContrastIssueType;
  readonly passesAA: boolean;
  readonly passesAAA: boolean;
}

/** File extensions recognised as CSS-like. */
export const CSS_EXTENSIONS: ReadonlySet<string> = new Set(['css', 'scss', 'sass', 'less']);
/** File extensions recognised as HTML-like (inline `style=` and `<style>` blocks). */
export const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml', 'vue', 'svelte', 'razor', 'cshtml']);

function findDeclaration(decls: readonly CssDeclaration[], prop: string): CssDeclaration | undefined {
  for (let i = decls.length - 1; i >= 0; i--) if (decls[i]!.property === prop) return decls[i];
  return undefined;
}

function isBold(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  if (v === 'bold' || v === 'bolder') return true;
  if (!/^[+-]?\d+$/.test(v)) return false;
  return parseInt(v, 10) >= 700;
}

const SHORTHAND_TOKEN = /#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-zA-Z]+/g;

/** First valid color token of a `background` shorthand (`#fff url(x.png) no-repeat` → `#fff`). */
export function extractColorFromShorthand(decl: CssDeclaration): CssDeclaration | null {
  for (const m of decl.value.matchAll(SHORTHAND_TOKEN)) {
    if (parseColor(m[0]) !== null) return { ...decl, value: m[0] };
  }
  return null;
}

function backgroundOf(decls: readonly CssDeclaration[]): CssDeclaration | null {
  const bg = findDeclaration(decls, 'background-color');
  if (bg) return bg;
  const shorthand = findDeclaration(decls, 'background');
  return shorthand ? extractColorFromShorthand(shorthand) : null;
}

function buildFinding(
  filePath: string, line: number, selector: string,
  fg: RgbaColor, bg: RgbaColor, large: boolean, issueType: ContrastIssueType,
): ContrastFinding {
  const raw = contrastRatio(fg, bg);
  const wcagLevel: ContrastLevel = passesAAA(raw, large) ? 'AAA' : passesAA(raw, large) ? 'AA' : 'FAIL';
  return {
    filePath,
    line: Math.max(1, line),
    selector,
    foreground: toHex(fg),
    background: toHex(bg),
    ratio: round1(raw),
    wcagLevel,
    largeText: large,
    issueType,
    passesAA: wcagLevel !== 'FAIL',
    passesAAA: wcagLevel === 'AAA',
  };
}

/** Scans CSS / SCSS / LESS source. */
export function scanCss(source: string, fileLabel = '<memory>'): ContrastFinding[] {
  const findings: ContrastFinding[] = [];
  for (const r of extractCssRules(source)) {
    const color = findDeclaration(r.declarations, 'color');
    const bg = backgroundOf(r.declarations);
    if (!color || !bg) continue;
    const fg = parseColor(color.value);
    const bgColor = parseColor(bg.value);
    if (!fg || !bgColor) continue;
    const large = isLargeText(findDeclaration(r.declarations, 'font-size')?.value, isBold(findDeclaration(r.declarations, 'font-weight')?.value));
    findings.push(buildFinding(fileLabel, color.line, r.selector, fg, bgColor, large, 'TEXT_CONTRAST'));
  }
  return findings;
}

const INLINE_STYLE = /<([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*?\bstyle\s*=\s*"([^"]*)"[^>]*>/g;

function countNewlines(s: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** Scans HTML-ish content for inline `style="color:…; background:…"` pairs. */
export function scanHtmlInline(source: string, fileLabel = '<memory>'): ContrastFinding[] {
  const findings: ContrastFinding[] = [];
  for (const m of source.matchAll(INLINE_STYLE)) {
    const tag = m[1]!;
    const declarations: CssDeclaration[] = [];
    for (const part of m[2]!.split(';')) {
      const t = part.trim();
      const idx = t.indexOf(':');
      if (t.length === 0 || idx < 0) continue;
      declarations.push({ property: t.substring(0, idx).trim().toLowerCase(), value: t.substring(idx + 1).trim(), line: 0 });
    }
    const color = findDeclaration(declarations, 'color');
    const bg = backgroundOf(declarations);
    if (!color || !bg) continue;
    const fg = parseColor(color.value);
    const bgColor = parseColor(bg.value);
    if (!fg || !bgColor) continue;
    const line = countNewlines(source, m.index ?? 0) + 1;
    const large = isLargeText(findDeclaration(declarations, 'font-size')?.value, isBold(findDeclaration(declarations, 'font-weight')?.value));
    findings.push(buildFinding(fileLabel, line, `<${tag}>`, fg, bgColor, large, 'TEXT_CONTRAST'));
  }
  return findings;
}

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

function scanEmbeddedStyles(source: string, fileLabel: string): ContrastFinding[] {
  const findings: ContrastFinding[] = [];
  for (const m of source.matchAll(STYLE_BLOCK)) {
    const offsetLine = countNewlines(source, m.index ?? 0);
    for (const f of scanCss(m[1]!, fileLabel)) findings.push({ ...f, line: f.line + offsetLine });
  }
  return findings;
}

function extensionOf(fileName: string): string {
  const base = fileName.substring(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.substring(dot + 1).toLowerCase();
}

/**
 * Scans one file's content. The extension of `fileName` decides the mode:
 * CSS-like files are parsed as stylesheets; HTML-like files contribute inline
 * styles plus `<style>` blocks; anything else yields no findings.
 */
export function scanContrast(content: string, fileName: string): ContrastFinding[] {
  const ext = extensionOf(fileName);
  if (CSS_EXTENSIONS.has(ext)) return scanCss(content, fileName);
  if (HTML_EXTENSIONS.has(ext)) return [...scanHtmlInline(content, fileName), ...scanEmbeddedStyles(content, fileName)];
  return [];
}
