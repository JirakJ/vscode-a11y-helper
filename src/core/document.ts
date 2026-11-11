/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

import { isWhitespace, MarkupDocument, MarkupTag, parseMarkup } from './markup';
import { AuditRule, IssueSeverity, MarkupAuditReport, MarkupIssue, reportOf } from './markupAudit';

/** Rules reported by {@link auditDocument}. */
export const DocumentRules = {
  MISSING_LANG: {
    id: 'doc-missing-lang', title: 'Document language not declared', wcag: 'WCAG 3.1.1',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html',
  },
  INVALID_LANG: {
    id: 'doc-invalid-lang', title: 'Invalid language tag', wcag: 'WCAG 3.1.1',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html',
  },
  MISSING_TITLE: {
    id: 'doc-missing-title', title: 'Page without <title>', wcag: 'WCAG 2.4.2',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/page-titled.html',
  },
  EMPTY_TITLE: {
    id: 'doc-empty-title', title: 'Empty <title>', wcag: 'WCAG 2.4.2',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/page-titled.html',
  },
  VIEWPORT_ZOOM_BLOCKED: {
    id: 'doc-viewport-zoom-blocked', title: 'Viewport blocks pinch-zoom', wcag: 'WCAG 1.4.4',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html',
  },
  META_REFRESH: {
    id: 'doc-meta-refresh', title: 'Timed refresh / redirect', wcag: 'WCAG 2.2.1 / 3.2.5',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Techniques/failures/F41',
  },
  DUPLICATE_ID: {
    id: 'doc-duplicate-id', title: 'Duplicate id breaks label / ARIA references', wcag: 'WCAG 1.3.1 / 4.1.2',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Techniques/html/H93',
  },
  DUPLICATE_ACCESSKEY: {
    id: 'doc-duplicate-accesskey', title: 'Duplicate accesskey', wcag: 'WCAG 2.1.1 / 2.4.1',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Techniques/html/H93',
  },
} as const satisfies Record<string, AuditRule>;

export const DOCUMENT_RULES: readonly AuditRule[] = Object.values(DocumentRules);

/** BCP 47 tags are short; anything longer is rejected before the regex runs. */
const MAX_LANG_LENGTH = 64;
/** Loose BCP 47 shape: 2–3 letter primary subtag, optional 1–8 char subtags. */
const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const CONDITIONAL_ATTRIBUTES: ReadonlySet<string> = new Set(['v-if', 'v-else', 'v-else-if', '*ngif', 'x-if', '@if', '@else', '@else-if', '*ngif-else']);
const ELSE_ATTRIBUTES: ReadonlySet<string> = new Set(['v-else', 'v-else-if', '@else', '@else-if']);
/** Longest source span inspected between two duplicate-id owners for a branch marker. */
const MAX_BRANCH_WINDOW = 4_096;
const REFERENCE_ATTRIBUTES = [
  'for', 'htmlfor', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns',
  'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto', 'list', 'form',
];

/**
 * Audits page-level metadata and document-wide invariants.
 *
 * Document checks (only when an `<html>` element exists): missing / invalid
 * `lang` (ERROR), missing / empty `<title>` (ERROR; `<svg><title>` does not count).
 * Per-element checks (fragments included): zoom-blocking viewport (ERROR),
 * `<meta http-equiv="refresh">` (WARNING; INFO for an immediate redirect),
 * duplicate static ids (WARNING; ERROR when referenced), duplicate accesskeys (WARNING).
 */
export function auditDocument(doc: MarkupDocument, filePath: string): MarkupAuditReport {
  const tags = doc.tags;
  const issues: MarkupIssue[] = [];
  let checked = 0;
  const failing = new Set<string>();

  const report = (tag: MarkupTag | null, rule: AuditRule, severity: IssueSeverity, message: string, suggestion: string, unit: string): void => {
    if (severity !== 'INFO') failing.add(unit);
    issues.push({ rule, severity, line: tag?.line ?? 1, column: tag?.column ?? 0, message, suggestion });
  };

  const htmlIndex = tags.findIndex((t) => !t.isClose && t.lowerName === 'html');
  if (htmlIndex >= 0) {
    const html = tags[htmlIndex]!;

    checked++;
    const lang = html.attr('lang');
    if (html.isDynamic('lang') || html.hasBinding('lang')) {
      // decided at runtime
    } else if (lang === null) {
      report(
        html, DocumentRules.MISSING_LANG, 'ERROR',
        '<html> has no lang attribute — screen readers may pick the wrong pronunciation rules.',
        'Add lang="en" (or the page\'s primary language as a BCP 47 tag).',
        'lang',
      );
    } else if (lang.length > MAX_LANG_LENGTH || !LANG_TAG.test(lang)) {
      report(
        html, DocumentRules.INVALID_LANG, 'ERROR',
        `lang="${lang}" is not a valid BCP 47 language tag.`,
        'Use a primary subtag like "en", "cs" or "pt-BR".',
        'lang',
      );
    }

    checked++;
    const graphicCache = new Map<number, boolean>();
    const titleIndex = tags.findIndex((t, i) => !t.isClose && t.lowerName === 'title' && !t.isComponent && !insideGraphic(doc, i, graphicCache));
    if (titleIndex < 0) {
      report(
        html, DocumentRules.MISSING_TITLE, 'ERROR',
        'Document has no <title> — the page cannot be identified in tabs, history or by screen readers.',
        'Add <title>Page name – Site name</title> inside <head>.',
        'title',
      );
    } else {
      const title = tags[titleIndex]!;
      const inner = doc.innerContent(titleIndex);
      if (doc.visibleText(titleIndex).length === 0 && !doc.hasDynamicContent(titleIndex) && !inner.includes('@')) {
        report(
          title, DocumentRules.EMPTY_TITLE, 'ERROR',
          '<title> is empty.',
          'Provide a concise title describing the page topic or purpose.',
          'title',
        );
      }
    }
  }

  for (const tag of tags) {
    if (tag.isClose || tag.lowerName !== 'meta' || tag.isComponent) continue;
    const name = tag.attr('name')?.toLowerCase();
    const httpEquiv = (tag.attr('http-equiv') ?? tag.attr('httpequiv'))?.toLowerCase();
    if (tag.isDynamic('content') || tag.hasBinding('content')) continue;
    const content = tag.attr('content') ?? '';
    const unit = `meta:${tag.startOffset}`;
    if (name === 'viewport') {
      checked++;
      if (blocksZoom(content)) {
        report(
          tag, DocumentRules.VIEWPORT_ZOOM_BLOCKED, 'ERROR',
          `Viewport meta disables pinch-zoom (content="${content}").`,
          'Remove user-scalable=no and keep maximum-scale at 2 or higher (or omit it).',
          unit,
        );
      }
    } else if (httpEquiv === 'refresh') {
      checked++;
      const delay = toIntOrNull(content.split(';')[0]!.trim());
      if (delay === 0 && content.toLowerCase().includes('url')) {
        report(
          tag, DocumentRules.META_REFRESH, 'INFO',
          'Immediate client-side redirect via <meta http-equiv="refresh">.',
          'Prefer a server-side (HTTP 301/302) redirect where possible.',
          unit,
        );
      } else {
        report(
          tag, DocumentRules.META_REFRESH, 'WARNING',
          `Page refreshes or redirects automatically after ${delay ?? '?'} s — users cannot stop or extend it.`,
          'Remove the timed refresh, or give users a control to turn it off (WCAG 2.2.1).',
          unit,
        );
      }
    }
  }

  // Duplicate ids / accesskeys
  const conditionalCache = new Map<number, number>();
  const referenced = new Set<string>();
  const idOwners = new Map<string, MarkupTag[]>();
  const ownerIndex = new Map<MarkupTag, number>();
  const accessKeys = new Map<string, MarkupTag[]>();
  tags.forEach((tag, tagIndex) => {
    if (tag.isClose) return;
    for (const ref of REFERENCE_ATTRIBUTES) {
      const v = tag.attr(ref);
      if (v === null || tag.isDynamic(ref)) continue;
      for (const part of v.split(/\s+/)) if (part.length > 0) referenced.add(part);
    }
    const id = tag.attr('id');
    if (id !== null && !tag.isDynamic('id') && !tag.hasBinding('id') && !isTemplated(id)) {
      let list = idOwners.get(id);
      if (!list) { list = []; idOwners.set(id, list); }
      list.push(tag);
      ownerIndex.set(tag, tagIndex);
    }
    const key = tag.attr('accesskey');
    if (key !== null && !tag.isDynamic('accesskey') && !tag.hasBinding('accesskey')) {
      const k = key.toLowerCase();
      let list = accessKeys.get(k);
      if (!list) { list = []; accessKeys.set(k, list); }
      list.push(tag);
    }
  });
  checked += idOwners.size;
  for (const [id, owners] of idOwners) {
    if (owners.length < 2) continue;
    const isReferenced = referenced.has(id);
    for (let k = 1; k < owners.length; k++) {
      const dup = owners[k]!;
      const prev = owners[k - 1]!;
      if (isExclusiveBranch(doc.source, prev, dup)) continue;
      if (isAlternativeBranch(doc, ownerIndex.get(prev)!, ownerIndex.get(dup)!, conditionalCache)) continue;
      report(
        dup, DocumentRules.DUPLICATE_ID, isReferenced ? 'ERROR' : 'WARNING',
        isReferenced
          ? `id="${id}" is declared ${owners.length}× and is the target of a label/ARIA reference — only the first element is associated.`
          : `id="${id}" is declared ${owners.length}× (first at line ${owners[0]!.line}).`,
        'Make ids unique within the document.',
        `id:${id}`,
      );
    }
  }
  checked += accessKeys.size;
  for (const [key, owners] of accessKeys) {
    if (owners.length < 2) continue;
    for (const dup of owners.slice(1)) {
      report(
        dup, DocumentRules.DUPLICATE_ACCESSKEY, 'WARNING',
        `accesskey="${key}" is assigned to ${owners.length} elements — only one can win.`,
        'Use a unique accesskey per element, or drop accesskeys (they conflict with AT shortcuts).',
        `accesskey:${key}`,
      );
    }
  }

  issues.sort((a, b) => a.line - b.line || a.column - b.column);
  return reportOf(filePath, checked, failing.size, issues);
}

/** Convenience overload: parses `source` first. */
export function auditDocumentSource(source: string, filePath: string): MarkupAuditReport {
  return auditDocument(parseMarkup(source), filePath);
}

function toIntOrNull(s: string): number | null {
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
}

function insideGraphic(doc: MarkupDocument, index: number, cache: Map<number, boolean>): boolean {
  const chain: number[] = [];
  let i = index;
  let result = false;
  while (i >= 0) {
    const cached = cache.get(i);
    if (cached !== undefined) { result = cached; break; }
    chain.push(i);
    const name = doc.tags[i]!.lowerName;
    if (name === 'svg' || name === 'math') { result = true; break; }
    i = doc.parentIndex[i]!;
  }
  for (const c of chain) cache.set(c, result);
  return result;
}

function nearestConditional(doc: MarkupDocument, index: number, cache: Map<number, number>): number {
  const chain: number[] = [];
  let i = index;
  let result = -1;
  while (i >= 0) {
    const cached = cache.get(i);
    if (cached !== undefined) { result = cached; break; }
    chain.push(i);
    if ([...doc.tags[i]!.attributes.keys()].some((k) => CONDITIONAL_ATTRIBUTES.has(k))) { result = i; break; }
    i = doc.parentIndex[i]!;
  }
  for (const c of chain) cache.set(c, result);
  return result;
}

/** The second owner sits in an else-branch of a different conditional element than the first. */
function isAlternativeBranch(doc: MarkupDocument, first: number, second: number, cache: Map<number, number>): boolean {
  const a = nearestConditional(doc, first, cache);
  const b = nearestConditional(doc, second, cache);
  if (a < 0 || b < 0 || a === b) return false;
  return [...doc.tags[b]!.attributes.keys()].some((k) => ELSE_ATTRIBUTES.has(k));
}

/** A JSX ternary else-arm or Svelte `{:else}` between two consecutive owners (bounded window). */
function isExclusiveBranch(source: string, first: MarkupTag, second: MarkupTag): boolean {
  if (second.startOffset <= first.endOffset) return false;
  if (second.startOffset - first.endOffset > MAX_BRANCH_WINDOW) return false;
  const between = source.substring(first.endOffset, second.startOffset) + '<';
  return between.includes('{:else') || hasTernaryElse(between);
}

function hasTernaryElse(text: string): boolean {
  let i = text.indexOf(':');
  while (i >= 0) {
    const before = i === 0 ? ' ' : text[i - 1]!;
    if (before === ')' || isWhitespace(before)) {
      let k = i + 1;
      while (k < text.length && isWhitespace(text[k])) k++;
      if (k < text.length && text[k] === '(') { k++; while (k < text.length && isWhitespace(text[k])) k++; }
      if (k < text.length && text[k] === '<') return true;
    }
    i = text.indexOf(':', i + 1);
  }
  return false;
}

function blocksZoom(content: string): boolean {
  for (const raw of content.split(/[,;]/)) {
    const part = raw.trim().toLowerCase();
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.substring(0, eq)).trim();
    const value = eq < 0 ? '' : part.substring(eq + 1).trim();
    if (key === 'user-scalable' && (value === 'no' || value === '0')) return true;
    if (key === 'maximum-scale') {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) continue;
      if (parseFloat(value) < 2.0) return true;
    }
  }
  return false;
}

function isTemplated(id: string): boolean {
  return id.includes('{') || id.includes('${') || id.includes('@') || id.includes('<%') || id.includes('<?');
}
