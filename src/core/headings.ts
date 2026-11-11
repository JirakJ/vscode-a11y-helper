/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Heading structure audit (WCAG 1.3.1 / 2.4.6 and WAI-ARIA 1.2
 * `role="heading"` rules) for HTML / JSX / TSX / Vue / Svelte / Razor.
 *
 * Checks performed:
 * - missing `<h1>` — ERROR for complete documents, WARNING for fragments,
 * - multiple `<h1>` — WARNING,
 * - skipped levels (`h2` → `h4`) — WARNING,
 * - empty headings — ERROR (unless dynamic or named via aria-label / aria-labelledby),
 * - headings longer than {@link MAX_HEADING_LENGTH} characters — INFO,
 * - `role="heading"` without `aria-level` — WARNING,
 * - invalid `aria-level` value — ERROR.
 */

/** WAI-ARIA 1.2 default level for `role="heading"` without `aria-level`. */
export const DEFAULT_ARIA_HEADING_LEVEL = 2;
/** Advisory maximum heading length (characters). */
export const MAX_HEADING_LENGTH = 120;

/** A single heading. `line` is 1-based, `column` 0-based. */
export interface Heading {
  /** Effective level 1..9 (native digit, parsed aria-level, or default 2). */
  readonly level: number;
  readonly tag: string;
  /** `true` for `<h1>`–`<h6>`, `false` for `role="heading"`. */
  readonly native: boolean;
  readonly declaredAriaLevel: string | null;
  readonly text: string;
  readonly ariaLabel: string | null;
  readonly hasAriaLabelledby: boolean;
  /** Inner content contains a JSX expression — text is computed at runtime. */
  readonly dynamicContent: boolean;
  readonly line: number;
  readonly column: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface HeadingScanOutcome {
  readonly headings: readonly Heading[];
  readonly fullDocument: boolean;
}

export type HeadingIssueSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface HeadingRule {
  readonly id: string;
  readonly wcag: string;
}

export const HEADING_RULES = {
  MISSING_H1: { id: 'heading-missing-h1', wcag: 'WCAG 1.3.1 / 2.4.6' },
  MULTIPLE_H1: { id: 'heading-multiple-h1', wcag: 'WCAG 1.3.1' },
  SKIPPED_LEVEL: { id: 'heading-skipped-level', wcag: 'WCAG 1.3.1' },
  EMPTY_HEADING: { id: 'heading-empty', wcag: 'WCAG 1.3.1 / 2.4.6' },
  HEADING_TOO_LONG: { id: 'heading-too-long', wcag: 'WCAG 2.4.6' },
  ROLE_HEADING_WITHOUT_LEVEL: { id: 'heading-role-without-aria-level', wcag: 'WAI-ARIA 1.2' },
  INVALID_ARIA_LEVEL: { id: 'heading-invalid-aria-level', wcag: 'WAI-ARIA 1.2' },
} as const satisfies Record<string, HeadingRule>;

export interface HeadingIssue {
  readonly rule: HeadingRule;
  readonly severity: HeadingIssueSeverity;
  /** The heading concerned, or `null` for document-level findings. */
  readonly heading: Heading | null;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly suggestion: string;
}

export interface HeadingAuditReport {
  readonly filePath: string;
  readonly headings: readonly Heading[];
  readonly issues: readonly HeadingIssue[];
  readonly fullDocument: boolean;
  /** 100 minus 15 per ERROR, 7 per WARNING, 2 per INFO; floored at 0. */
  readonly score: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
}

// ── Scanner ──────────────────────────────────────────────────────────────

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

/** Extracts native `<h1>`–`<h6>` and `role="heading"` elements, skipping hidden ones. */
export function scanHeadings(source: string): HeadingScanOutcome {
  const tags = tokenizeHeadingTags(source);
  const headings: Heading[] = [];
  let fullDocument = false;

  tags.forEach((tag, index) => {
    if (tag.isClose) return;
    const lower = tag.name.toLowerCase();
    if (lower === 'html' || lower === 'body') fullDocument = true;

    const nativeLevel = nativeHeadingLevel(tag.name);
    const role = tag.attributes.get('role')?.trim().toLowerCase();
    if (nativeLevel === null && role !== 'heading') return;
    if (isHiddenAttrs(tag.attributes)) return;

    const declaredAriaLevel = tag.attributes.get('aria-level')?.trim() ?? null;
    const parsed = declaredAriaLevel !== null ? parseIntStrict(declaredAriaLevel) : null;
    const level = nativeLevel ?? (parsed !== null && parsed >= 1 && parsed <= 9 ? parsed : DEFAULT_ARIA_HEADING_LEVEL);

    const inner = tag.selfClosing ? '' : innerContent(source, tags, index);
    const ariaLabel = tag.attributes.get('aria-label')?.trim();
    headings.push({
      level,
      tag: tag.name,
      native: nativeLevel !== null,
      declaredAriaLevel,
      text: visibleText(inner),
      ariaLabel: ariaLabel ? ariaLabel : null,
      hasAriaLabelledby: (tag.attributes.get('aria-labelledby') ?? '').trim().length > 0,
      dynamicContent: containsJsx(inner),
      line: tag.line,
      column: tag.column,
      startOffset: tag.startOffset,
      endOffset: tag.endOffset,
    });
  });
  return { headings, fullDocument };
}

function parseIntStrict(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const v = Number(s);
  return Number.isSafeInteger(v) && Math.abs(v) <= 2147483647 ? v : null;
}

function nativeHeadingLevel(name: string): number | null {
  if (name.length !== 2) return null;
  if (name[0] !== 'h' && name[0] !== 'H') return null;
  const d = name.charCodeAt(1) - 48;
  return d >= 1 && d <= 6 ? d : null;
}

function isHiddenAttrs(attrs: Map<string, string>): boolean {
  if (attrs.get('aria-hidden')?.trim().toLowerCase() === 'true') return true;
  return attrs.has('hidden');
}

function innerContent(source: string, tags: readonly RawTag[], openIndex: number): string {
  const open = tags[openIndex]!;
  const lowerName = open.name.toLowerCase();
  let depth = 1;
  for (let i = openIndex + 1; i < tags.length; i++) {
    const t = tags[i]!;
    if (t.name.toLowerCase() !== lowerName) continue;
    if (t.isClose) {
      depth--;
      if (depth === 0) return source.substring(open.endOffset, t.startOffset);
    } else if (!t.selfClosing) {
      depth++;
    }
  }
  return source.substring(open.endOffset);
}

const ALT_REGEX = /\balt\s*=\s*("([^"]*)"|'([^']*)')/i;

/** Strips markup and collapses whitespace; nested `<img>` / `<area>` alt text contributes. */
function visibleText(inner: string): string {
  if (inner.length === 0) return '';
  let sb = '';
  let i = 0;
  const n = inner.length;
  while (i < n) {
    const c = inner[i]!;
    if (c === '<') {
      if (inner.startsWith('<!--', i)) {
        const end = inner.indexOf('-->', i + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      const end = inner.indexOf('>', i + 1);
      if (end < 0) break;
      const tagBody = inner.substring(i + 1, end);
      const tagName = (/^[\p{L}\p{Nd}]*/u.exec(tagBody)?.[0] ?? '').toLowerCase();
      if (tagName === 'img' || tagName === 'area') {
        const m = ALT_REGEX.exec(tagBody);
        const value = m ? (m[2] ? m[2] : m[3]) : undefined;
        if (value !== undefined && value.trim().length > 0) sb += ' ' + value;
      }
      i = end + 1;
      continue;
    }
    sb += c;
    i++;
  }
  return sb.replace(/\s+/g, ' ').trim();
}

function containsJsx(inner: string): boolean {
  let inTag = false;
  for (const c of inner) {
    if (c === '<') inTag = true;
    else if (c === '>') inTag = false;
    else if (c === '{' && !inTag) return true;
  }
  return false;
}

const WS = /\s/;
const isWs = (c: string | undefined): boolean => c !== undefined && WS.test(c);
const isNameStart = (c: string): boolean => c === '_' || /\p{L}/u.test(c);
const isNameChar = (c: string): boolean => c === '-' || c === '_' || c === ':' || c === '.' || /[\p{L}\p{Nd}]/u.test(c);

function indexOfIgnoreCase(src: string, needle: string, from: number): number {
  const lower = needle.toLowerCase();
  const m = lower.length;
  for (let i = from; i <= src.length - m; i++) {
    let k = 0;
    while (k < m && src[i + k]!.toLowerCase() === lower[k]) k++;
    if (k === m) return i;
  }
  return -1;
}

function tokenizeHeadingTags(content: string): RawTag[] {
  const out: RawTag[] = [];
  const n = content.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const col = (p: number): number => p - lineStart;

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
    const startCol = col(tagStart);
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
      if (ch === '/' && p + 1 < n && content[p + 1] === '>') { selfClosing = true; tagEnd = p + 2; p += 2; closed = true; break; }
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
              if (k + 1 < n && content[k + 1] === '\n') { line++; lineStart = k + 2; k += 2; }
              else { line++; lineStart = k + 1; k++; }
              continue;
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

// ── Auditor ──────────────────────────────────────────────────────────────

function issue(
  rule: HeadingRule,
  severity: HeadingIssueSeverity,
  heading: Heading | null,
  message: string,
  suggestion: string,
): HeadingIssue {
  return { rule, severity, heading, line: heading?.line ?? 1, column: heading?.column ?? 0, message, suggestion };
}

/** Audits the heading structure of one file. */
export function auditHeadings(source: string, filePath: string): HeadingAuditReport {
  const outcome = scanHeadings(source);
  const headings = outcome.headings;
  const issues: HeadingIssue[] = [];

  const h1s = headings.filter((h) => h.level === 1);
  if (headings.length > 0 || outcome.fullDocument) {
    if (h1s.length === 0) {
      issues.push(issue(
        HEADING_RULES.MISSING_H1,
        outcome.fullDocument ? 'ERROR' : 'WARNING',
        null,
        outcome.fullDocument
          ? 'Document has no <h1>. Every page needs exactly one top-level heading.'
          : 'Fragment contains headings but no <h1>. Verify a parent component renders the page title.',
        'Add a single <h1> describing the page topic (WCAG 2.4.6).',
      ));
    } else if (h1s.length > 1) {
      issues.push(issue(
        HEADING_RULES.MULTIPLE_H1,
        'WARNING',
        h1s[1]!,
        `Document contains ${h1s.length} <h1> elements; screen-reader users rely on a single page title.`,
        'Keep one <h1> and demote the others to <h2>.',
      ));
    }
  }

  let previousLevel = 0;
  for (const h of headings) {
    if (previousLevel !== 0 && h.level > previousLevel + 1) {
      issues.push(issue(
        HEADING_RULES.SKIPPED_LEVEL,
        'WARNING',
        h,
        `Heading level skips from h${previousLevel} to h${h.level}.`,
        `Use h${previousLevel + 1} instead, or restructure the outline — assistive tech users navigate by heading levels.`,
      ));
    }
    previousLevel = h.level;

    const hasName = h.text.trim().length > 0 || (h.ariaLabel ?? '').trim().length > 0 || h.hasAriaLabelledby;
    if (!hasName && !h.dynamicContent) {
      issues.push(issue(
        HEADING_RULES.EMPTY_HEADING,
        'ERROR',
        h,
        `<${h.tag}> has no text content.`,
        'Add visible text, or remove the empty heading — empty headings confuse screen-reader navigation.',
      ));
    }

    if (h.text.length > MAX_HEADING_LENGTH) {
      issues.push(issue(
        HEADING_RULES.HEADING_TOO_LONG,
        'INFO',
        h,
        `Heading is ${h.text.length} characters long (recommended ≤ ${MAX_HEADING_LENGTH}).`,
        'Shorten the heading; move detail into the following paragraph.',
      ));
    }

    if (!h.native) {
      const declared = h.declaredAriaLevel;
      if (declared === null) {
        issues.push(issue(
          HEADING_RULES.ROLE_HEADING_WITHOUT_LEVEL,
          'WARNING',
          h,
          `role="heading" without aria-level — assistive technologies assume level ${DEFAULT_ARIA_HEADING_LEVEL}.`,
          'Add aria-level="…", or prefer a native <h1>–<h6> element.',
        ));
      } else {
        const v = parseIntStrict(declared);
        if (v === null || v < 1 || v > 9) {
          issues.push(issue(
            HEADING_RULES.INVALID_ARIA_LEVEL,
            'ERROR',
            h,
            `aria-level="${declared}" is not a valid heading level (1–9).`,
            'Use an integer between 1 and 9, matching the document outline.',
          ));
        }
      }
    }
  }

  let score = 100;
  for (const i of issues) score -= i.severity === 'ERROR' ? 15 : i.severity === 'WARNING' ? 7 : 2;

  return {
    filePath,
    headings,
    issues,
    fullDocument: outcome.fullDocument,
    score: Math.max(0, score),
    errorCount: issues.filter((i) => i.severity === 'ERROR').length,
    warningCount: issues.filter((i) => i.severity === 'WARNING').length,
    infoCount: issues.filter((i) => i.severity === 'INFO').length,
  };
}

function escapeTable(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r/g, ' ').replace(/\n/g, ' ');
}

function escapeInlineCode(s: string): string {
  return s.replace(/`/g, '\\`');
}

/** Renders the document outline plus issue table as Markdown. */
export function headingReportToMarkdown(r: HeadingAuditReport): string {
  let sb = `# Heading Structure Audit — \`${escapeInlineCode(r.filePath)}\`\n\n`;
  sb += `- Score: **${r.score}/100**\n`;
  sb += `- Headings: **${r.headings.length}**\n`;
  sb += `- Errors: **${r.errorCount}**, Warnings: **${r.warningCount}**, Info: **${r.infoCount}**\n\n`;
  sb += '## Document outline\n\n';
  if (r.headings.length === 0) {
    sb += '_No headings detected._\n\n';
  } else {
    for (const h of r.headings) {
      sb += '  '.repeat(h.level - 1);
      sb += `- **h${h.level}** `;
      let label: string;
      if (h.text.trim().length > 0) label = h.text;
      else if (h.ariaLabel !== null) label = `(aria-label: ${h.ariaLabel})`;
      else if (h.dynamicContent) label = '(dynamic content)';
      else label = '(empty)';
      sb += escapeTable(label);
      sb += `  — \`${escapeInlineCode(`${r.filePath}:${h.line}:${h.column}`)}\`\n`;
    }
    sb += '\n';
  }
  sb += '## Issues\n\n';
  if (r.issues.length === 0) {
    sb += '_No issues detected._\n';
  } else {
    sb += '| Severity | Rule | Location | Message | Suggestion |\n';
    sb += '|---|---|---|---|---|\n';
    for (const i of r.issues) {
      sb += `| ${i.severity} | ${i.rule.id} | ${escapeTable(`${r.filePath}:${i.line}:${i.column}`)} | ${escapeTable(i.message)} | ${escapeTable(i.suggestion)} |\n`;
    }
  }
  return sb;
}

/** Serialises the report to a stable JSON shape. */
export function headingReportToJson(r: HeadingAuditReport): string {
  return JSON.stringify({
    filePath: r.filePath,
    score: r.score,
    fullDocument: r.fullDocument,
    headingCount: r.headings.length,
    errors: r.errorCount,
    warnings: r.warningCount,
    infos: r.infoCount,
    outline: r.headings.map((h) => ({ level: h.level, tag: h.tag, text: h.text, line: h.line, column: h.column })),
    issues: r.issues.map((i) => ({
      rule: i.rule.id,
      wcag: i.rule.wcag,
      severity: i.severity,
      line: i.line,
      column: i.column,
      message: i.message,
      suggestion: i.suggestion,
    })),
  }, null, 2);
}
