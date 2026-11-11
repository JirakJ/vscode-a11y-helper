/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Locates interactive elements (Screen Reader Label Coverage) and resolves
 * their accessible names with a simplified-but-faithful subset of the
 * WAI-ARIA 1.2 accessible-name computation.
 *
 * Interactive by default: `button`, `a[href]`, `input` (not `type="hidden"`),
 * `textarea`, `select`, `summary`, `details`; plus any element with an
 * interactive ARIA role. Elements with `aria-hidden="true"`, `hidden` or
 * `role="presentation|none"` are skipped. PascalCase JSX components are only
 * interactive through an explicit role.
 */

/** An interactive element found by {@link scanInteractiveElements} (line 1-based, column 0-based). */
export interface InteractiveElement {
  readonly tag: string;
  readonly role: string | null;
  readonly line: number;
  readonly column: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly rawTag: string;
  readonly attributes: ReadonlyMap<string, string>;
}

/** Sources of an accessible name. */
export type NameSource =
  | 'ARIA_LABELLEDBY'
  | 'ARIA_LABEL'
  | 'TITLE'
  | 'TEXT_CONTENT'
  | 'ALT_ATTR'
  | 'VALUE_ATTR'
  | 'LABEL_ELEMENT'
  | 'PLACEHOLDER_ATTR'
  | 'NONE';

export interface NameResolution {
  readonly source: NameSource;
  readonly value: string | null;
  readonly isEmpty: boolean;
}

const NATIVE_INTERACTIVE = new Set(['button', 'a', 'input', 'textarea', 'select', 'summary', 'details']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'searchbox',
  'textbox', 'spinbutton', 'slider', 'treeitem',
]);

const WS = /\s/;
const LETTER = /\p{L}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const isWs = (c: string | undefined): boolean => c !== undefined && WS.test(c);
const isNameStart = (c: string): boolean => c === '_' || LETTER.test(c);
const isNameChar = (c: string): boolean => c === '-' || c === '_' || c === ':' || c === '.' || LETTER_OR_DIGIT.test(c);
const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase();

type TagKind = 'OPEN' | 'CLOSE' | 'SELF_CLOSING';

interface RawTag {
  name: string;
  attributes: Map<string, string>;
  kind: TagKind;
  line: number;
  column: number;
  startOffset: number;
  endOffset: number;
}

/** Returns all interactive elements found in `source` in source order. */
export function scanInteractiveElements(source: string): InteractiveElement[] {
  const out: InteractiveElement[] = [];
  for (const t of tokenizeRaw(source)) {
    if (t.kind === 'CLOSE') continue;
    if (isSkipped(t.attributes)) continue;
    if (!isInteractive(t)) continue;
    const role = t.attributes.get('role')?.trim().toLowerCase();
    out.push({
      tag: t.name,
      role: role ? role : null,
      line: t.line,
      column: t.column,
      startOffset: t.startOffset,
      endOffset: t.endOffset,
      rawTag: source.substring(t.startOffset, t.endOffset),
      attributes: t.attributes,
    });
  }
  return out;
}

function isSkipped(attrs: Map<string, string>): boolean {
  if (attrs.get('aria-hidden')?.trim().toLowerCase() === 'true') return true;
  if (attrs.has('hidden')) return true;
  const role = attrs.get('role')?.trim().toLowerCase();
  return role === 'presentation' || role === 'none';
}

function isInteractive(tag: RawTag): boolean {
  const role = tag.attributes.get('role')?.trim().toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  const name = tag.name;
  if (name.length === 0 || isUpper(name[0]!)) return false;
  const lower = name.toLowerCase();
  if (!NATIVE_INTERACTIVE.has(lower)) return false;
  if (lower === 'a') return tag.attributes.has('href');
  if (lower === 'input') return tag.attributes.get('type')?.trim().toLowerCase() !== 'hidden';
  return true;
}

function indexOfIgnoreCase(src: string, needle: string, from: number): number {
  const lower = needle.toLowerCase();
  for (let i = from; i <= src.length - lower.length; i++) {
    let k = 0;
    while (k < lower.length && src[i + k]!.toLowerCase() === lower[k]) k++;
    if (k === lower.length) return i;
  }
  return -1;
}

/** Single-pass opening-tag tokenizer (line 1-based, column 0-based; CRLF and lone CR are one line break). */
function tokenizeRaw(content: string): RawTag[] {
  const out: RawTag[] = [];
  const n = content.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const advance = (from: number, to: number): number => {
    let p = from;
    const end = Math.min(to, n);
    while (p < end) {
      const c = content[p];
      if (c === '\r' && p + 1 < end && content[p + 1] === '\n') { line++; lineStart = p + 2; p += 2; }
      else if (c === '\r' || c === '\n') { line++; lineStart = p + 1; p++; }
      else p++;
    }
    return end;
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
      i = advance(i, end < 0 ? n : end + 3); continue;
    }
    if (content.startsWith('<![CDATA[', i)) {
      const end = content.indexOf(']]>', i + 9);
      i = advance(i, end < 0 ? n : end + 3); continue;
    }
    if (content.startsWith('<!', i) || content.startsWith('<?', i)) {
      const end = content.indexOf('>', i + 2);
      i = advance(i, end < 0 ? n : end + 1); continue;
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
          advance(q + 1, end);
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

    const kind: TagKind = isClose ? 'CLOSE' : selfClosing ? 'SELF_CLOSING' : 'OPEN';
    out.push({ name, attributes: attrs, kind, line: startLine, column: startCol, startOffset: tagStart, endOffset: tagEnd });
    i = p;

    if (kind === 'OPEN') {
      const lname = name.toLowerCase();
      if (lname === 'script' || lname === 'style') {
        const endIdx = indexOfIgnoreCase(content, '</' + lname, i);
        i = advance(i, endIdx < 0 ? n : endIdx);
      }
    }
  }
  return out;
}

// ── Accessible name resolution ───────────────────────────────────────────

const trimmed = (v: string | undefined): string => (v ?? '').trim();

/**
 * Resolves the accessible name of `el`: aria-labelledby (raw id list) →
 * aria-label → host language (input value / alt, a / button / summary text or
 * nested img alt) → title → placeholder (warning) → NONE. Cross-element
 * `<label>` association is handled by the auditor.
 */
export function resolveAccessibleName(el: InteractiveElement, source: string): NameResolution {
  const a = el.attributes;
  const labelledBy = trimmed(a.get('aria-labelledby'));
  if (labelledBy) return { source: 'ARIA_LABELLEDBY', value: labelledBy, isEmpty: false };
  const ariaLabel = trimmed(a.get('aria-label'));
  if (ariaLabel) return { source: 'ARIA_LABEL', value: ariaLabel, isEmpty: false };

  const lowerTag = el.tag.toLowerCase();
  if (lowerTag === 'input') {
    const type = a.get('type')?.trim().toLowerCase() ?? 'text';
    if (type === 'button' || type === 'submit' || type === 'reset') {
      const v = trimmed(a.get('value'));
      if (v) return { source: 'VALUE_ATTR', value: v, isEmpty: false };
    } else if (type === 'image') {
      const v = trimmed(a.get('alt'));
      if (v) return { source: 'ALT_ATTR', value: v, isEmpty: false };
    }
  } else if (lowerTag === 'a' || lowerTag === 'button') {
    const text = extractTextContent(source, el);
    if (text) return { source: 'TEXT_CONTENT', value: text, isEmpty: false };
    const imgAlt = findFirstImgAlt(source, el);
    if (imgAlt) return { source: 'ALT_ATTR', value: imgAlt, isEmpty: false };
  } else if (lowerTag === 'summary') {
    const text = extractTextContent(source, el);
    if (text) return { source: 'TEXT_CONTENT', value: text, isEmpty: false };
  }

  const title = trimmed(a.get('title'));
  if (title) return { source: 'TITLE', value: title, isEmpty: false };
  const placeholder = trimmed(a.get('placeholder'));
  if (placeholder) return { source: 'PLACEHOLDER_ATTR', value: placeholder, isEmpty: false };
  return { source: 'NONE', value: null, isEmpty: true };
}

function extractTextContent(source: string, el: InteractiveElement): string {
  if (el.rawTag.endsWith('/>')) return '';
  const closeIdx = findMatchingClose(source, el.endOffset, el.tag.toLowerCase());
  if (closeIdx === null) return '';
  return stripAndCollapse(source.substring(el.endOffset, closeIdx));
}

function findFirstImgAlt(source: string, el: InteractiveElement): string | null {
  if (el.rawTag.endsWith('/>')) return null;
  const closeIdx = findMatchingClose(source, el.endOffset, el.tag.toLowerCase());
  if (closeIdx === null) return null;
  const inner = source.substring(el.endOffset, closeIdx);
  const imgMatch = /<img\b[^>]*>/i.exec(inner);
  if (!imgMatch) return null;
  const altMatch = /\balt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(imgMatch[0]);
  if (!altMatch) return '';
  return (altMatch[2] || altMatch[3] || '').trim();
}

/** Offset of the `<` of the matching `</tagLower>`, nesting-aware; `null` when unbalanced. */
function findMatchingClose(source: string, from: number, tagLower: string): number | null {
  let depth = 1;
  let i = from;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0 || lt + 1 >= n) return null;
    if (source.startsWith('<!--', lt)) {
      const e = source.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const isClose = source[lt + 1] === '/';
    const nameStart = isClose ? lt + 2 : lt + 1;
    if (nameStart >= n || !isNameStart(source[nameStart]!)) { i = lt + 1; continue; }
    let p = nameStart;
    while (p < n && isNameChar(source[p]!)) p++;
    const name = source.substring(nameStart, p).toLowerCase();
    let q = p;
    let inQuote = '';
    let selfClose = false;
    while (q < n) {
      const c = source[q]!;
      if (inQuote) {
        if (c === inQuote) inQuote = '';
        q++; continue;
      }
      if (c === '"' || c === "'") { inQuote = c; q++; continue; }
      if (c === '>') { q++; break; }
      if (c === '/' && q + 1 < n && source[q + 1] === '>') { selfClose = true; q += 2; break; }
      q++;
    }
    if (name === tagLower) {
      if (isClose) {
        depth--;
        if (depth === 0) return lt;
      } else if (!selfClose) {
        depth++;
      }
    }
    i = q;
  }
  return null;
}

function stripAndCollapse(html: string): string {
  let sb = '';
  let i = 0;
  const n = html.length;
  while (i < n) {
    const c = html[i]!;
    if (c === '<') {
      const end = html.indexOf('>', i + 1);
      i = end < 0 ? n : end + 1;
      sb += ' ';
    } else {
      sb += c; i++;
    }
  }
  return sb.replace(/\s+/g, ' ').trim();
}
