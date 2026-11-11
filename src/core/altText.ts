/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Alt Text Quality auditor (WCAG 1.1.1). Locates image-bearing elements
 * (`<img>`, `<area>`, `<input type="image">`, inline `<svg>`) and judges the
 * quality of their text alternatives — not just presence.
 */

import type { IssueSeverity } from './markupAudit';

/** An image-bearing element discovered by {@link scanAltTextElements}. */
export class AltTextElement {
  constructor(
    /** Lower-cased tag name (`img`, `area`, `input`, `svg`). */
    readonly tag: string,
    /** Attribute map with lower-cased keys; JSX values keep their braces. */
    readonly attributes: ReadonlyMap<string, string>,
    /** For `<svg>` only: whether a non-empty `<title>` child exists. */
    readonly svgHasTitleChild: boolean,
    /** 1-based line of the `<`. */
    readonly line: number,
    /** 0-based column of the `<`. */
    readonly column: number,
    readonly startOffset: number,
    readonly endOffset: number,
  ) {}

  /** Raw `alt` value, or `null` when the attribute is absent. */
  get alt(): string | null {
    return this.attributes.get('alt') ?? null;
  }

  /** `true` when the attribute value is a JSX expression (`alt={…}`). */
  isDynamic(attribute: string): boolean {
    return this.attributes.get(attribute)?.trimStart().startsWith('{') === true;
  }

  get ariaLabel(): string | null {
    const v = this.attributes.get('aria-label')?.trim();
    return v ? v : null;
  }

  get hasAriaLabelledby(): boolean {
    const v = this.attributes.get('aria-labelledby');
    return v !== undefined && v.trim().length > 0;
  }

  get role(): string | null {
    const v = this.attributes.get('role')?.trim().toLowerCase();
    return v ? v : null;
  }

  get ariaHidden(): boolean {
    return this.attributes.get('aria-hidden')?.trim().toLowerCase() === 'true';
  }

  get presentational(): boolean {
    const r = this.role;
    return r === 'presentation' || r === 'none';
  }
}

interface RawTag {
  name: string;
  attributes: Map<string, string>;
  isClose: boolean;
  selfClosing: boolean;
  line: number;
  column: number;
  startOffset: number;
  endOffset: number;
}

const WS = /\s/;
const isWs = (c: string | undefined): boolean => c !== undefined && WS.test(c);
const isNameStart = (c: string): boolean => c === '_' || /\p{L}/u.test(c);
const isNameChar = (c: string): boolean => c === '-' || c === '_' || c === ':' || c === '.' || /[\p{L}\p{Nd}]/u.test(c);
const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase();

function indexOfIgnoreCase(src: string, needle: string, from: number): number {
  const lower = needle.toLowerCase();
  for (let i = from; i <= src.length - lower.length; i++) {
    let k = 0;
    while (k < lower.length && src[i + k]!.toLowerCase() === lower[k]) k++;
    if (k === lower.length) return i;
  }
  return -1;
}

function tokenize(content: string): RawTag[] {
  const out: RawTag[] = [];
  const n = content.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const skipTo = (to: number): void => {
    let p = i;
    const end = Math.min(to, n);
    while (p < end) {
      const c = content[p];
      if (c === '\r' && p + 1 < end && content[p + 1] === '\n') { line++; lineStart = p + 2; p += 2; }
      else if (c === '\r' || c === '\n') { line++; lineStart = p + 1; p++; }
      else p++;
    }
    i = end;
  };

  while (i < n) {
    const c = content[i];
    if (c === '\r') {
      if (i + 1 < n && content[i + 1] === '\n') { line++; lineStart = i + 2; i += 2; }
      else { line++; lineStart = i + 1; i++; }
      continue;
    }
    if (c === '\n') { line++; lineStart = i + 1; i++; continue; }
    if (c !== '<') { i++; continue; }

    if (content.startsWith('<!--', i)) {
      const end = content.indexOf('-->', i + 4);
      skipTo(end < 0 ? n : end + 3); continue;
    }
    if (content.startsWith('<![CDATA[', i)) {
      const end = content.indexOf(']]>', i + 9);
      skipTo(end < 0 ? n : end + 3); continue;
    }
    if (content.startsWith('<!', i) || content.startsWith('<?', i)) {
      const end = content.indexOf('>', i + 2);
      skipTo(end < 0 ? n : end + 1); continue;
    }

    const tagStart = i;
    const startLine = line;
    const startCol = tagStart - lineStart;
    const isClose = i + 1 < n && content[i + 1] === '/';
    let p = isClose ? i + 2 : i + 1;
    if (p >= n || !isNameStart(content[p]!)) { i++; continue; }

    const nameStart = p;
    while (p < n && isNameChar(content[p]!)) p++;
    const name = content.substring(nameStart, p);

    const attrs = new Map<string, string>();
    let selfClosing = false;
    let closed = false;
    let tagEnd = -1;
    while (p < n) {
      const ch = content[p]!;
      if (ch === '\r') {
        if (p + 1 < n && content[p + 1] === '\n') { line++; lineStart = p + 2; p += 2; }
        else { line++; lineStart = p + 1; p++; }
        continue;
      }
      if (ch === '\n') { line++; lineStart = p + 1; p++; continue; }
      if (isWs(ch)) { p++; continue; }
      if (ch === '>') { tagEnd = p + 1; p++; closed = true; break; }
      if (ch === '/' && p + 1 < n && content[p + 1] === '>') {
        selfClosing = true; tagEnd = p + 2; p += 2; closed = true; break;
      }
      const an = p;
      while (p < n && !isWs(content[p]) && content[p] !== '=' && content[p] !== '>' && content[p] !== '/') p++;
      if (p === an) { p++; continue; }
      const attrName = content.substring(an, p).toLowerCase();
      let q = p;
      while (q < n && (content[q] === ' ' || content[q] === '\t')) q++;
      if (q < n && content[q] === '=') {
        q++;
        while (q < n && (content[q] === ' ' || content[q] === '\t')) q++;
        if (q >= n) { p = q; break; }
        const vc = content[q];
        let value: string;
        if (vc === '"' || vc === "'") {
          const end = content.indexOf(vc, q + 1);
          if (end < 0) return out;
          value = content.substring(q + 1, end);
          let k = q + 1;
          while (k < end) {
            const kc = content[k];
            if (kc === '\r') {
              if (k + 1 < end && content[k + 1] === '\n') { line++; lineStart = k + 2; k += 2; }
              else { line++; lineStart = k + 1; k++; }
            } else if (kc === '\n') { line++; lineStart = k + 1; k++; } else k++;
          }
          p = end + 1;
        } else if (vc === '{') {
          let depth = 1;
          let k = q + 1;
          while (k < n && depth > 0) {
            const kc = content[k];
            if (kc === '\r') {
              if (k + 1 < n && content[k + 1] === '\n') { line++; lineStart = k + 2; k += 2; continue; }
              line++; lineStart = k + 1; k++; continue;
            } else if (kc === '\n') { line++; lineStart = k + 1; }
            else if (kc === '{') depth++;
            else if (kc === '}') depth--;
            k++;
          }
          value = content.substring(q, Math.min(k, n));
          p = k;
        } else {
          const vs = q;
          while (q < n && !isWs(content[q]) && content[q] !== '>' && content[q] !== '/') q++;
          value = content.substring(vs, q);
          p = q;
        }
        attrs.set(attrName, value);
      } else {
        attrs.set(attrName, '');
        p = q;
      }
    }
    if (!closed) break;

    out.push({ name, attributes: attrs, isClose, selfClosing, line: startLine, column: startCol, startOffset: tagStart, endOffset: tagEnd });
    i = p;

    if (!isClose && !selfClosing) {
      const lname = name.toLowerCase();
      if (lname === 'script' || lname === 'style') {
        const endIdx = indexOfIgnoreCase(content, '</' + lname, i);
        skipTo(endIdx < 0 ? n : endIdx);
      }
    }
  }
  return out;
}

const SVG_TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function svgContainsTitle(source: string, tags: RawTag[], openIndex: number): boolean {
  const open = tags[openIndex]!;
  let depth = 1;
  let end = source.length;
  for (let i = openIndex + 1; i < tags.length; i++) {
    const t = tags[i]!;
    if (t.name.toLowerCase() !== 'svg') continue;
    if (t.isClose) {
      depth--;
      if (depth === 0) { end = t.startOffset; break; }
    } else if (!t.selfClosing) depth++;
  }
  const inner = source.substring(open.endOffset, Math.max(end, open.endOffset));
  const m = SVG_TITLE.exec(inner);
  return m !== null && (m[1] ?? '').trim().length > 0;
}

/**
 * Finds image-bearing elements in HTML / JSX / TSX / Vue / Svelte / Razor
 * sources. Comments, doctypes, CDATA, processing instructions and
 * `<script>` / `<style>` bodies are ignored; uppercase JSX components are skipped.
 */
export function scanAltTextElements(source: string): AltTextElement[] {
  const tags = tokenize(source);
  const out: AltTextElement[] = [];
  tags.forEach((tag, index) => {
    if (tag.isClose) return;
    if (tag.name.length === 0 || isUpper(tag.name[0]!)) return;
    const lower = tag.name.toLowerCase();
    let relevant: boolean;
    if (lower === 'img' || lower === 'area' || lower === 'svg') relevant = true;
    else if (lower === 'input') relevant = tag.attributes.get('type')?.trim().toLowerCase() === 'image';
    else relevant = false;
    if (!relevant) return;
    const svgHasTitle = lower === 'svg' && !tag.selfClosing && svgContainsTitle(source, tags, index);
    out.push(new AltTextElement(lower, tag.attributes, svgHasTitle, tag.line, tag.column, tag.startOffset, tag.endOffset));
  });
  return out;
}

/** Stable rule identifiers for alt-text findings. */
export const AltTextRule = {
  MISSING_ALT: { id: 'alt-missing', wcag: 'WCAG 1.1.1' },
  FILENAME_AS_ALT: { id: 'alt-filename', wcag: 'WCAG 1.1.1' },
  PLACEHOLDER_ALT: { id: 'alt-placeholder', wcag: 'WCAG 1.1.1' },
  REDUNDANT_PHRASE: { id: 'alt-redundant-phrase', wcag: 'WCAG 1.1.1' },
  ALT_TOO_LONG: { id: 'alt-too-long', wcag: 'WCAG 1.1.1' },
  WHITESPACE_ALT: { id: 'alt-whitespace-only', wcag: 'WCAG 1.1.1' },
  DECORATIVE_CONFLICT: { id: 'alt-decorative-conflict', wcag: 'WAI-ARIA 1.2' },
  TITLE_DUPLICATES_ALT: { id: 'alt-title-duplicate', wcag: 'WCAG 1.1.1' },
  SVG_IMG_MISSING_NAME: { id: 'svg-img-missing-name', wcag: 'WCAG 1.1.1' },
  SVG_UNMARKED: { id: 'svg-unmarked', wcag: 'WCAG 1.1.1' },
} as const;

export type AltTextRuleDef = (typeof AltTextRule)[keyof typeof AltTextRule];

/** One alt-text quality problem bound to a scanned element. */
export interface AltTextIssue {
  readonly rule: AltTextRuleDef;
  readonly severity: IssueSeverity;
  readonly element: AltTextElement;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly suggestion: string;
}

/** Result of an alt-text quality audit; `score` = 100 − 15·ERROR − 7·WARNING − 2·INFO, floored at 0. */
export interface AltTextAuditReport {
  readonly filePath: string;
  readonly elements: readonly AltTextElement[];
  readonly total: number;
  readonly accessible: number;
  readonly decorative: number;
  readonly issues: readonly AltTextIssue[];
  readonly score: number;
}

/** Advisory maximum alt-text length (characters). */
export const MAX_ALT_LENGTH = 125;

const FILE_EXT_REGEX = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)$/;
const CAMERA_NAME_REGEX = /^(?:img|dsc|dscn|dcim|image|photo|pic|screenshot|snimek)[-_ ]?\d+$/;
const PLACEHOLDER_WORDS = new Set([
  'image', 'img', 'photo', 'picture', 'graphic', 'icon', 'alt',
  'untitled', 'placeholder', 'spacer', 'blank', 'empty', '*', '.',
]);
const REDUNDANT_PREFIXES = [
  'image of ', 'picture of ', 'photo of ', 'photograph of ',
  'graphic of ', 'icon of ', 'screenshot of ', 'image:', 'photo:',
];

function issue(rule: AltTextRuleDef, severity: IssueSeverity, el: AltTextElement, message: string, suggestion: string): AltTextIssue {
  return { rule, severity, element: el, line: el.line, column: el.column, message, suggestion };
}

function looksLikeFilename(normalizedAlt: string, src: string | undefined): boolean {
  if (FILE_EXT_REGEX.test(normalizedAlt)) return true;
  if (CAMERA_NAME_REGEX.test(normalizedAlt)) return true;
  if (src !== undefined) {
    const afterSlash = src.substring(src.lastIndexOf('/') + 1);
    const srcBase = afterSlash.substring(afterSlash.lastIndexOf('\\') + 1).toLowerCase();
    if (srcBase.length > 0) {
      const dot = srcBase.lastIndexOf('.');
      const withoutExt = dot < 0 ? srcBase : srcBase.substring(0, dot);
      if ((normalizedAlt === srcBase || normalizedAlt === withoutExt) && !normalizedAlt.includes(' ')) return true;
    }
  }
  return false;
}

/** Returns `true` when the element is correctly decorative. */
function auditImageLike(el: AltTextElement, issues: AltTextIssue[]): boolean {
  const alt = el.alt;
  const dynamicAlt = el.isDynamic('alt');
  const hidden = el.ariaHidden || el.presentational;

  if (alt === null && !dynamicAlt) {
    if (hidden) return true;
    if (el.ariaLabel !== null || el.hasAriaLabelledby) return false;
    const requiresAlt = el.tag === 'area' ? el.attributes.has('href') : true;
    if (requiresAlt) {
      issues.push(issue(
        AltTextRule.MISSING_ALT, 'ERROR', el,
        `<${el.tag}${el.tag === 'input' ? ' type="image"' : ''}> has no alt attribute.`,
        'Add alt="…" describing the content, or alt="" if purely decorative.',
      ));
    }
    return false;
  }

  if (dynamicAlt) return false;
  if (alt === null) return false;
  const value = alt;
  if (value.length === 0) return true; // alt="" is the canonical decorative marker

  if (value.trim().length === 0) {
    issues.push(issue(
      AltTextRule.WHITESPACE_ALT, 'WARNING', el,
      `alt="${value}" contains only whitespace — assistive technologies handle this inconsistently.`,
      'Use alt="" (empty, no spaces) for decorative images.',
    ));
    return false;
  }

  if (hidden) {
    issues.push(issue(
      AltTextRule.DECORATIVE_CONFLICT, 'WARNING', el,
      `Non-empty alt text combined with ${el.ariaHidden ? 'aria-hidden="true"' : `role="${el.role}"`} — conflicting semantics.`,
      'Either remove the hiding attribute or use alt="" for decorative images.',
    ));
  }

  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();

  if (looksLikeFilename(normalized, el.attributes.get('src'))) {
    issues.push(issue(
      AltTextRule.FILENAME_AS_ALT, 'ERROR', el,
      `alt="${trimmed}" looks like a file name, which conveys nothing to screen-reader users.`,
      'Describe what the image shows, e.g. alt="Team standing in front of the office".',
    ));
  } else if (PLACEHOLDER_WORDS.has(normalized)) {
    issues.push(issue(
      AltTextRule.PLACEHOLDER_ALT, 'WARNING', el,
      `alt="${trimmed}" is a generic placeholder that conveys no information.`,
      'Describe the specific content or purpose of the image.',
    ));
  } else {
    const redundant = REDUNDANT_PREFIXES.find((p) => normalized.startsWith(p));
    if (redundant !== undefined) {
      const rest = trimmed.substring(redundant.length).trim();
      const fixed = rest.length > 0 ? rest[0]!.toUpperCase() + rest.substring(1) : rest;
      issues.push(issue(
        AltTextRule.REDUNDANT_PHRASE, 'WARNING', el,
        `alt text starts with "${redundant}" — screen readers already announce the element as an image.`,
        `Drop the prefix: alt="${fixed}".`,
      ));
    }
  }

  if (trimmed.length > MAX_ALT_LENGTH) {
    issues.push(issue(
      AltTextRule.ALT_TOO_LONG, 'INFO', el,
      `alt text is ${trimmed.length} characters long (recommended ≤ ${MAX_ALT_LENGTH}).`,
      'Keep alt concise; move detail to a <figcaption> or aria-describedby target.',
    ));
  }

  const title = el.attributes.get('title')?.trim();
  if (title && title === trimmed) {
    issues.push(issue(
      AltTextRule.TITLE_DUPLICATES_ALT, 'INFO', el,
      'title duplicates alt — some screen readers announce the text twice.',
      'Remove the title attribute or give it complementary content.',
    ));
  }
  return false;
}

/** Returns `true` when the SVG has an accessible name. */
function auditSvg(el: AltTextElement, issues: AltTextIssue[]): boolean {
  if (el.ariaHidden || el.presentational) return false;
  const named = el.ariaLabel !== null || el.hasAriaLabelledby || el.svgHasTitleChild;
  if (el.role === 'img' && !named) {
    issues.push(issue(
      AltTextRule.SVG_IMG_MISSING_NAME, 'ERROR', el,
      '<svg role="img"> has no accessible name (aria-label, aria-labelledby or <title> child).',
      'Add aria-label="…" or a <title>…</title> first child.',
    ));
    return false;
  }
  if (el.role === null && !named) {
    issues.push(issue(
      AltTextRule.SVG_UNMARKED, 'INFO', el,
      'Inline <svg> has neither an accessible name nor aria-hidden — screen readers may announce its raw structure.',
      'Add aria-hidden="true" if decorative, or role="img" + <title>/aria-label if informative.',
    ));
    return false;
  }
  return named;
}

function hasMeaningfulName(el: AltTextElement): boolean {
  if (el.isDynamic('alt') || el.isDynamic('aria-label')) return true;
  const alt = el.alt?.trim();
  if (alt) return true;
  return el.ariaLabel !== null || el.hasAriaLabelledby;
}

function computeScore(issues: readonly AltTextIssue[]): number {
  let score = 100;
  for (const i of issues) score -= i.severity === 'ERROR' ? 15 : i.severity === 'WARNING' ? 7 : 2;
  return Math.max(0, score);
}

/**
 * Audits the alt-text quality of `source`: missing alt, file names and
 * camera names as alt, placeholder words, redundant "image of" prefixes,
 * over-long alt, whitespace-only alt, conflicting decorative semantics,
 * `title` duplicating `alt`, nameless `<svg role="img">` and unmarked inline SVG.
 * JSX expression values (`alt={…}`) are treated as present-but-dynamic.
 */
export function auditAltText(content: string, filePath: string): AltTextAuditReport {
  const elements = scanAltTextElements(content);
  const issues: AltTextIssue[] = [];
  let accessible = 0;
  let decorative = 0;
  for (const el of elements) {
    if (el.tag === 'svg') {
      const named = auditSvg(el, issues);
      if (named) accessible++;
      else if (el.ariaHidden || el.presentational) decorative++;
    } else {
      const isDecorative = auditImageLike(el, issues);
      if (isDecorative) decorative++;
      else if (hasMeaningfulName(el)) accessible++;
    }
  }
  return {
    filePath, elements, total: elements.length, accessible, decorative, issues, score: computeScore(issues),
  };
}
