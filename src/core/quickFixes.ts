/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/** A text edit expressed in absolute source offsets. */
export interface OffsetEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface QuickFix {
  readonly title: string;
  readonly edit: OffsetEdit;
}

/** Absolute offset of a 1-based line / 0-based column (CRLF-safe); `-1` when out of range. */
export function offsetAt(source: string, line: number, column: number): number {
  let current = 1;
  let i = 0;
  while (current < line) {
    const nl = source.indexOf('\n', i);
    if (nl < 0) return -1;
    i = nl + 1;
    current++;
  }
  const offset = i + column;
  return offset <= source.length ? offset : -1;
}

interface TagHead {
  /** Offset just after the tag name. */
  readonly nameEnd: number;
  /** Offset of the closing `>` (or `/>`) of the start tag. */
  readonly tagEnd: number;
  readonly text: string;
}

/** Locates the start tag beginning at `offset` (`<name …>`); `null` when there is none. */
function tagAt(source: string, offset: number): TagHead | null {
  if (offset < 0 || source[offset] !== '<') return null;
  const m = /^<([A-Za-z_][\w.:-]*)/.exec(source.substring(offset, offset + 200));
  if (!m) return null;
  const nameEnd = offset + m[0].length;
  // Find the end of the start tag, skipping quoted values and brace expressions.
  let i = nameEnd;
  let depth = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      if (depth === 0) quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth = Math.max(0, depth - 1);
    } else if (c === '>' && depth === 0) {
      const tagEnd = source[i - 1] === '/' ? i - 1 : i;
      return { nameEnd, tagEnd, text: source.substring(offset, i + 1) };
    }
    i++;
  }
  return null;
}

function insertAttribute(source: string, offset: number, attribute: string, title: string): QuickFix | null {
  const tag = tagAt(source, offset);
  if (!tag) return null;
  const name = attribute.split('=')[0]!;
  if (new RegExp(`\\s${name.replace(/[-]/g, '\\-')}(\\s|=|/|>|$)`, 'i').test(tag.text)) return null;
  return { title, edit: { start: tag.nameEnd, end: tag.nameEnd, text: ` ${attribute}` } };
}

/** Rule-id prefix → quick fix factory. */
const FIXES: ReadonlyArray<{ match: (ruleId: string) => boolean; build: (source: string, offset: number) => QuickFix[] }> = [
  {
    // Missing alt: the original plugin's "Add alt attribute" fix (decorative by default — the author then describes it).
    match: (id) => id === 'alt-missing',
    build: (s, o) => [
      insertAttribute(s, o, 'alt=""', 'Add alt="" (mark image as decorative)'),
    ].filter((f): f is QuickFix => f !== null),
  },
  {
    match: (id) => id === 'label-missing' || id === 'link-empty',
    build: (s, o) => [insertAttribute(s, o, 'aria-label=""', 'Add aria-label attribute')].filter((f): f is QuickFix => f !== null),
  },
  {
    match: (id) => id === 'media-iframe-no-title',
    build: (s, o) => [insertAttribute(s, o, 'title=""', 'Add title attribute')].filter((f): f is QuickFix => f !== null),
  },
  {
    match: (id) => id === 'doc-missing-lang',
    build: (s, o) => [insertAttribute(s, o, 'lang="en"', 'Add lang="en"')].filter((f): f is QuickFix => f !== null),
  },
  {
    match: (id) => id === 'focus-positive-tabindex',
    build: (s, o) => {
      const tag = tagAt(s, o);
      if (!tag) return [];
      const m = /(\stabindex\s*=\s*)(\{\s*\d+\s*\}|"\s*\d+\s*"|'\s*\d+\s*'|\d+)/i.exec(tag.text);
      if (!m) return [];
      const start = o + m.index + m[1]!.length;
      const replacement = m[2]!.startsWith('{') ? '{0}' : '"0"';
      return [{ title: 'Change tabindex to 0 (follow DOM order)', edit: { start, end: start + m[2]!.length, text: replacement } }];
    },
  },
  {
    match: (id) => id === 'focus-autofocus',
    build: (s, o) => {
      const tag = tagAt(s, o);
      if (!tag) return [];
      const m = /\s(autofocus|autoFocus)(\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*'|[^\s>]+))?/i.exec(tag.text);
      if (!m) return [];
      const start = o + m.index;
      return [{ title: 'Remove autofocus', edit: { start, end: start + m[0].length, text: '' } }];
    },
  },
];

/** Quick fixes available for a finding at `line` / `column` (positions as reported by the auditors). */
export function quickFixesFor(ruleId: string, source: string, line: number, column: number): QuickFix[] {
  const offset = offsetAt(source, line, column);
  if (offset < 0) return [];
  const out: QuickFix[] = [];
  for (const f of FIXES) if (f.match(ruleId)) out.push(...f.build(source, offset));
  return out;
}

/** Offset range of the start tag at `offset` (for diagnostic ranges); falls back to the end of the line. */
export function tagRangeAt(source: string, offset: number): [number, number] {
  const tag = tagAt(source, offset);
  if (tag) return [offset, Math.min(offset + tag.text.length, offset + 400)];
  let end = source.indexOf('\n', offset);
  if (end < 0) end = source.length;
  if (end > offset && source[end - 1] === '\r') end--;
  return [offset, Math.max(end, Math.min(offset + 1, source.length))];
}
