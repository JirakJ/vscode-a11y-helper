/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

import { isWhitespace, MarkupDocument, MarkupTag, parseMarkup } from './markup';
import { AuditRule, IssueSeverity, MarkupAuditReport, MarkupIssue, reportOf } from './markupAudit';

/**
 * Keyboard & Focus auditor (`focus-*`).
 *
 * Markup checks (HTML / JSX / TSX / Vue / Svelte / Razor):
 * - `tabindex` greater than `0` — WARNING (WCAG 2.4.3),
 * - click handler on a non-interactive element (`div`, `span`, `li`, `img`, …):
 *   not focusable — WARNING (WCAG 2.1.1; composite-widget items exempt),
 *   focusable but no `role` — WARNING (WCAG 4.1.2),
 *   role and focus but no key handler — INFO,
 * - `autofocus` — INFO (WCAG 3.2.1 advisory).
 *
 * Stylesheet checks (CSS / SCSS / LESS and `<style>` blocks; a linear
 * structural parser handles nesting and comments): a rule whose effective
 * `outline` removes the focus ring without a visible replacement — WARNING
 * (WCAG 2.4.7), downgraded to INFO when the sheet styles `:focus-visible`.
 */

const KEYBOARD = 'https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html';

export const FocusRules = {
  POSITIVE_TABINDEX: {
    id: 'focus-positive-tabindex', title: 'Positive tabindex overrides natural focus order', wcag: 'WCAG 2.4.3',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html',
  },
  CLICK_NOT_FOCUSABLE: {
    id: 'focus-click-not-focusable', title: 'Clickable element cannot receive keyboard focus', wcag: 'WCAG 2.1.1', helpUri: KEYBOARD,
  },
  CLICK_NO_ROLE: {
    id: 'focus-click-no-role', title: 'Clickable element has no interactive role', wcag: 'WCAG 4.1.2',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html',
  },
  CLICK_NO_KEY_HANDLER: {
    id: 'focus-click-no-key-handler', title: 'Custom control handles mouse but not keyboard', wcag: 'WCAG 2.1.1', helpUri: KEYBOARD,
  },
  AUTOFOCUS: {
    id: 'focus-autofocus', title: 'autofocus moves focus on load', wcag: 'WCAG 3.2.1',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/on-focus.html',
  },
  OUTLINE_SUPPRESSED: {
    id: 'focus-outline-suppressed', title: 'Focus indicator removed without replacement', wcag: 'WCAG 2.4.7 / 2.4.11',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html',
  },
  /** Emitted (INFO) when a stylesheet nests deeper than the parser follows. */
  ANALYSIS_INCOMPLETE: {
    id: 'audit-analysis-incomplete', title: 'Analysis incomplete', wcag: '—',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html',
  },
} as const satisfies Record<string, AuditRule>;

export const FOCUS_RULES: readonly AuditRule[] = [
  FocusRules.POSITIVE_TABINDEX, FocusRules.CLICK_NOT_FOCUSABLE, FocusRules.CLICK_NO_ROLE,
  FocusRules.CLICK_NO_KEY_HANDLER, FocusRules.AUTOFOCUS, FocusRules.OUTLINE_SUPPRESSED,
];

const CLICK_HANDLERS = new Set([
  'onclick', 'ondblclick', '@click', 'v-on:click', 'on:click', '(click)', '@click.prevent', '@click.stop', '@onclick',
]);
const KEY_HANDLERS = new Set([
  'onkeydown', 'onkeyup', 'onkeypress', '@keydown', '@keyup', '@keydown.enter', '@keyup.enter', '@keydown.space',
  'v-on:keydown', 'v-on:keyup', 'on:keydown', 'on:keyup', '(keydown)', '(keyup)', '@onkeydown', '@onkeyup',
]);

/** Elements that are not interactive by default (`label` is omitted — clicking it is native behaviour). */
export const NON_INTERACTIVE: ReadonlySet<string> = new Set([
  'div', 'span', 'li', 'p', 'img', 'td', 'th', 'tr', 'section', 'article', 'aside', 'header', 'footer',
  'nav', 'main', 'i', 'b', 'em', 'strong', 'svg', 'ul', 'ol', 'dl', 'dt', 'dd', 'figure', 'picture',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'small', 'blockquote', 'pre', 'code',
]);
const NATIVE_CONTROLS = new Set(['button', 'input', 'select', 'textarea', 'summary', 'details', 'audio', 'video']);
const MAX_SELECTOR_MEMBERS = 64;
const MAX_SELECTOR_DISPLAY = 160;
const FUNCTION_ARGS = /\([^()]*\)/g;
const LENGTH_UNITS = new Set(['px', 'em', 'rem', 'pt', 'vh', 'vw', 'vmin', 'vmax', '%', 'ch', 'ex', 'cm', 'mm', 'in', 'pc', 'q']);
const OUTLINE_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset', 'auto']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'menuitem', 'tab', 'switch', 'option', 'radio', 'textbox', 'combobox', 'slider']);
const MAX_SELECTOR_CHARS = 4096;
const MAX_RETAINED_SELECTOR = 512;
const COMPOSITE_ITEM_ROLES = new Set([
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'gridcell', 'row', 'presentation', 'none',
]);
const REPLACEMENT_PROPERTIES = new Set([
  'box-shadow', 'border', 'border-color', 'border-bottom', 'border-top', 'border-left', 'border-right',
  'background', 'background-color', 'text-decoration',
]);
/** Nesting deeper than this is treated as opaque. */
export const MAX_NESTING = 128;

const INT_RE = /^[+-]?\d+$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ZERO_LENGTH_RE = /^0+(\.0+)?(px|em|rem|pt|vh|vw|%)?$/;
const BOX_SHADOW_COLOR_RE = /#[0-9a-f]{3,8}|rgba?\(|hsla?\(|currentcolor|var\(|\b[a-z]{3,}\b/;
const LETTER_RE = /\p{L}/u;

function parseIntAttr(raw: string): number | null {
  let v = raw.trim();
  if (v.startsWith('{')) v = v.substring(1);
  if (v.endsWith('}')) v = v.substring(0, v.length - 1);
  v = v.trim().replace(/^["']+|["']+$/g, '');
  if (!INT_RE.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && Math.abs(n) <= 2147483647 ? n : null;
}

function toDoubleOrNull(s: string): number | null {
  const t = s.trim();
  return NUMBER_RE.test(t) ? Number(t) : null;
}

function issue(rule: AuditRule, severity: IssueSeverity, line: number, column: number, message: string, suggestion: string): MarkupIssue {
  return { rule, severity, line, column, message, suggestion };
}

function sortIssues(issues: MarkupIssue[]): void {
  issues.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Sorted indices of native / role-based controls. */
function nativeControlPositions(doc: MarkupDocument): number[] {
  const out: number[] = [];
  doc.tags.forEach((t, i) => {
    if (t.isClose) return;
    const role = t.role;
    if (NATIVE_CONTROLS.has(t.lowerName) || (t.lowerName === 'a' && (t.has('href') || t.hasBinding('href'))) ||
      (role !== null && INTERACTIVE_ROLES.has(role))) out.push(i);
  });
  return out;
}

function containsNativeControl(positions: number[], index: number, end: number): boolean {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid]! <= index) lo = mid + 1; else hi = mid;
  }
  return lo < positions.length && positions[lo]! < end;
}

/** Audits a markup document (and any embedded `<style>` blocks). Accepts a parsed document or raw source. */
export function auditFocusMarkup(input: MarkupDocument | string, filePath: string): MarkupAuditReport {
  const doc = typeof input === 'string' ? parseMarkup(input) : input;
  const tags = doc.tags;
  const issues: MarkupIssue[] = [];
  let checked = 0;
  let failed = 0;
  let controlPositions: number[] | undefined;

  const report = (tag: MarkupTag, rule: AuditRule, severity: IssueSeverity, message: string, suggestion: string): void => {
    issues.push(issue(rule, severity, tag.line, tag.column, message, suggestion));
  };

  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]!;
    if (tag.isClose || tag.isComponent || tag.hasSpread) continue;
    if (doc.isHidden(index)) continue;

    const tabindexRaw = tag.attr('tabindex');
    const tabindexValue = tabindexRaw !== null ? parseIntAttr(tabindexRaw) : null;
    const tabindexDynamic = tag.hasBinding('tabindex') || (tabindexRaw !== null && tabindexValue === null && tag.isDynamic('tabindex'));
    const keys = [...tag.attributes.keys()];
    const clickable = keys.some((k) => CLICK_HANDLERS.has(k));
    const autofocus = tag.boolAttr('autofocus');
    if (tabindexRaw === null && !tag.hasBinding('tabindex') && !clickable && autofocus !== true) continue;
    checked++;
    let elementFailed = false;

    if (tabindexValue !== null && tabindexValue > 0) {
      elementFailed = true;
      report(
        tag, FocusRules.POSITIVE_TABINDEX, 'WARNING',
        `tabindex="${tabindexValue}" forces this element ahead of the natural tab order.`,
        'Use tabindex="0" (focusable, natural order) or restructure the DOM instead.',
      );
    }

    const roleUnknown = tag.isDynamic('role') || tag.hasBinding('role');
    const nonInteractive = NON_INTERACTIVE.has(tag.lowerName);
    let delegatesToNativeControl = false;
    if (clickable && nonInteractive) {
      controlPositions ??= nativeControlPositions(doc);
      delegatesToNativeControl = containsNativeControl(controlPositions, index, doc.contentEndIndex[index]!);
    }
    const role = tag.role;
    if (clickable && nonInteractive && !(role !== null && COMPOSITE_ITEM_ROLES.has(role)) && !delegatesToNativeControl) {
      const focusable = tabindexDynamic || (tabindexValue !== null && tabindexValue >= 0);
      const hasKeyHandler = keys.some((k) => KEY_HANDLERS.has(k));
      if (!focusable && !roleUnknown) {
        elementFailed = true;
        report(
          tag, FocusRules.CLICK_NOT_FOCUSABLE, 'WARNING',
          tabindexValue !== null
            ? `<${tag.lowerName}> handles click but tabindex="${tabindexValue}" keeps it out of the tab order.`
            : `<${tag.lowerName}> handles click but has no tabindex — keyboard users cannot reach it.`,
          'Prefer <button>; otherwise add tabindex="0", role="button" and an Enter/Space key handler.',
        );
      } else if (!focusable) {
        // role decided at runtime — may be a composite item
      } else if (role === null && !roleUnknown) {
        elementFailed = true;
        report(
          tag, FocusRules.CLICK_NO_ROLE, 'WARNING',
          `<${tag.lowerName}> is focusable and clickable but has no role — screen readers announce plain text.`,
          'Add role="button" (or the matching widget role), or use a native <button>.',
        );
      } else if (role !== null && !hasKeyHandler) {
        report(
          tag, FocusRules.CLICK_NO_KEY_HANDLER, 'INFO',
          `<${tag.lowerName} role="${role}"> reacts to click only — verify Enter/Space activate it as well.`,
          'Add an onKeyDown handler for Enter and Space, or use a native <button>.',
        );
      }
    }

    if (autofocus === true) {
      report(
        tag, FocusRules.AUTOFOCUS, 'INFO',
        `autofocus moves keyboard focus on page load, skipping the content that precedes <${tag.lowerName}>.`,
        "Drop autofocus unless the page's sole purpose is this field (e.g. a login form).",
      );
    }
    if (elementFailed) failed++;
  }

  for (const block of doc.styleBlocks()) {
    const styleReport = auditFocusCss(block.css, filePath, block.line - 1, block.column);
    checked += styleReport.checked;
    failed += styleReport.checked - styleReport.passed;
    issues.push(...styleReport.issues);
  }

  sortIssues(issues);
  return reportOf(filePath, checked, failed, issues);
}

// ── CSS ──────────────────────────────────────────────────────────────

interface Declaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

interface Rule {
  readonly selector: string;
  readonly declarations: readonly Declaration[];
  /** Offset of the first selector character within the (comment-stripped) stylesheet. */
  readonly offset: number;
}

/**
 * Audits a stylesheet. Each rule that declares `outline` counts as one
 * checked unit. `lineOffset` shifts reported lines when the CSS is embedded
 * in a larger file; `firstLineColumnOffset` shifts columns on its first line.
 */
export function auditFocusCss(css: string, filePath: string, lineOffset = 0, firstLineColumnOffset = 0): MarkupAuditReport {
  const stripped = stripComments(css);
  const rules: Rule[] = [];
  const state = { truncated: false, parentPartsCache: new Map<string, string[]>() };
  parseBlock(stripped, 0, stripped.length, '', 0, rules, 0, state);
  const lineIndex = new LineIndex(stripped);

  const issues: MarkupIssue[] = [];
  let checked = 0;
  let failed = 0;
  const siteUsesFocusVisible = rules.some((r) =>
    r.selector.includes(':focus-visible') && !r.selector.includes(':not(:focus-visible)') &&
    r.declarations.some((d) => isVisibleReplacement(d) || (d.property === 'outline' && !isSuppressedOutline(d.value))),
  );

  for (const rule of rules) {
    const resolved = resolveOutline(rule.declarations);
    if (resolved === null) continue;
    checked++;
    if (!resolved.suppressed) continue;

    const members = splitTopLevel(rule.selector);
    const unsafe = members.filter((m) => !isAcceptedPattern(m));
    if (unsafe.length === 0) continue;

    const replacedByPaint = [...REPLACEMENT_PROPERTIES].some((prop) => {
      const d = effectiveDeclaration(rule.declarations, prop);
      return d !== null && isVisibleReplacement(d);
    });
    if (replacedByPaint) continue;

    const severity: IssueSeverity = siteUsesFocusVisible ? 'INFO' : 'WARNING';
    if (severity !== 'INFO') failed++;
    const [line, rawColumn] = lineIndex.locate(rule.offset);
    const column = line === 1 ? rawColumn + firstLineColumnOffset : rawColumn;
    const shownFull = unsafe.length === members.length ? rule.selector : unsafe.join(', ');
    const shown = shownFull.length > MAX_SELECTOR_DISPLAY ? shownFull.slice(0, MAX_SELECTOR_DISPLAY) + '…' : shownFull;
    issues.push(issue(
      FocusRules.OUTLINE_SUPPRESSED, severity, lineOffset + line, column,
      siteUsesFocusVisible
        ? `\`${shown}\` removes the focus outline (\`${resolved.shown}\`); the stylesheet styles :focus-visible elsewhere — verify it covers this element.`
        : `\`${shown}\` removes the focus outline (\`${resolved.shown}\`) without a visible replacement.`,
      'Keep a visible focus style: use :focus-visible with outline/box-shadow, or scope the reset to :focus:not(:focus-visible).',
    ));
  }
  if (state.truncated) {
    issues.push(issue(
      FocusRules.ANALYSIS_INCOMPLETE, 'INFO', lineOffset + 1, firstLineColumnOffset,
      `Stylesheet nests deeper than ${MAX_NESTING} blocks; rules below that depth were not checked for focus styles.`,
      'Flatten the nesting, or review the deepest rules for `outline: none` manually.',
    ));
  }
  return reportOf(filePath, checked, failed, issues);
}

interface ParseState {
  truncated: boolean;
  parentPartsCache: Map<string, string[]>;
}

/**
 * Linear recursive descent over one block body `[start, end)`: collects the
 * block's own declarations and recurses into nested `prelude { … }` blocks.
 */
function parseBlock(css: string, start: number, end: number, selector: string, offset: number, out: Rule[], depth: number, state: ParseState): void {
  const declarations: Declaration[] = [];
  let i = start;
  let tokenStart = start;

  const flushDeclaration = (upTo: number): void => {
    const text = css.substring(tokenStart, Math.max(upTo, tokenStart)).trim();
    if (text.length > 0 && text.includes(':')) {
      const colon = text.indexOf(':');
      const prop = text.substring(0, colon).trim().toLowerCase();
      let value = text.substring(colon + 1).trim();
      const important = value.toLowerCase().endsWith('!important');
      if (important) value = value.substring(0, value.length - '!important'.length).trim();
      declarations.push({ property: prop, value: value.toLowerCase(), important });
    }
  };

  while (i < end) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < end && css[i] !== c) { if (css[i] === '\\') i++; i++; }
      i++;
    } else if (c === '(') {
      let d = 1;
      i++;
      while (i < end && d > 0) { if (css[i] === '(') d++; else if (css[i] === ')') d--; i++; }
    } else if (c === ';') {
      flushDeclaration(i); i++; tokenStart = i;
    } else if (c === '{') {
      let preludeOffset = tokenStart;
      for (let k = tokenStart; k < i; k++) { if (!isWhitespace(css[k])) { preludeOffset = k; break; } }
      const prelude = css.substring(preludeOffset, Math.min(i, preludeOffset + MAX_SELECTOR_CHARS));
      const close = matchingBrace(css, i, end);
      const childSelector = prelude.trim();
      let effective: string;
      if (childSelector.startsWith('@')) effective = selector;
      else if (selector.length === 0) effective = childSelector;
      else effective = combineSelectors(selector, childSelector, state.parentPartsCache);
      if (depth < MAX_NESTING) {
        parseBlock(css, i + 1, close, effective, childSelector.startsWith('@') ? offset : preludeOffset, out, depth + 1, state);
      } else {
        state.truncated = true;
      }
      i = Math.min(close + 1, end);
      tokenStart = i;
    } else if (c === '}') {
      flushDeclaration(i); i++; tokenStart = i;
    } else {
      i++;
    }
  }
  flushDeclaration(end);
  const relevant = declarations.some((d) => d.property.startsWith('outline')) ||
    (selector.includes(':focus-visible') && declarations.some((d) => REPLACEMENT_PROPERTIES.has(d.property)));
  if (relevant && declarations.length > 0 && selector.length > 0 && !selector.startsWith('@')) {
    const retained = selector.length > MAX_RETAINED_SELECTOR ? selector.slice(0, MAX_RETAINED_SELECTOR) : selector;
    out.push({ selector: retained, declarations, offset });
  }
}

/** Splits a selector list at commas, stopping after MAX_SELECTOR_MEMBERS members of ≤ MAX_RETAINED_SELECTOR chars. */
function splitBounded(selector: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start <= selector.length && out.length < MAX_SELECTOR_MEMBERS) {
    const idx = selector.indexOf(',', start);
    const comma = idx < 0 ? selector.length : idx;
    const member = selector.substring(start, Math.min(comma, start + MAX_RETAINED_SELECTOR)).trim();
    if (member.length > 0) out.push(member);
    start = comma + 1;
  }
  return out;
}

/** SCSS nesting: every parent list member is combined with every child member (`&` = parent). */
function combineSelectors(parent: string, child: string, cache: Map<string, string[]>): string {
  if (cache.size > 1024) cache.clear();
  let parents = cache.get(parent);
  if (!parents) { parents = splitBounded(parent); cache.set(parent, parents); }
  const children = splitBounded(child);
  if (parents.length === 0 || children.length === 0) {
    const fallback = child.includes('&') ? child.replace('&', () => parent) : `${parent} ${child}`;
    return fallback.length > MAX_SELECTOR_CHARS ? fallback.slice(0, MAX_SELECTOR_CHARS) : fallback;
  }
  const combined: string[] = [];
  let total = 0;
  outer: for (const pm of parents) {
    for (const cm of children) {
      if (combined.length >= MAX_SELECTOR_MEMBERS || total > MAX_SELECTOR_CHARS) break outer;
      const cmShort = cm.length > MAX_RETAINED_SELECTOR ? cm.slice(0, MAX_RETAINED_SELECTOR) : cm;
      const member = cmShort.includes('&') ? cmShort.replace('&', () => pm) : `${pm} ${cmShort}`;
      const bounded = member.length > MAX_SELECTOR_CHARS ? member.slice(0, MAX_SELECTOR_CHARS) : member;
      combined.push(bounded);
      total += bounded.length;
    }
  }
  return combined.join(', ');
}

/** Splits a selector list at commas that are not inside `(...)`. */
function splitTopLevel(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let sb = '';
  for (const c of selector) {
    if (c === '(') { depth++; sb += c; }
    else if (c === ')') { if (depth > 0) depth--; sb += c; }
    else if (c === ',') { if (depth === 0) { out.push(sb.trim()); sb = ''; } else sb += c; }
    else sb += c;
  }
  out.push(sb.trim());
  return out.filter((s) => s.length > 0);
}

/** Precomputed line starts so every diagnostic location is a binary search. */
class LineIndex {
  private readonly starts: number[];
  constructor(text: string) {
    const list = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\r') { if (i + 1 < text.length && text[i + 1] === '\n') i++; list.push(i + 1); }
      else if (c === '\n') list.push(i + 1);
    }
    this.starts = list;
  }
  /** Returns `[1-based line, 0-based column]`. */
  locate(offset: number): [number, number] {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.starts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    return [lo + 1, offset - this.starts[lo]!];
  }
}

function matchingBrace(css: string, open: number, end: number): number {
  let depth = 0;
  let i = open;
  while (i < end) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < end && css[i] !== c) { if (css[i] === '\\') i++; i++; }
    } else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return end;
}

interface OutlineState {
  suppressed: boolean;
  shown: string;
}

/** Cascades `outline` shorthand and longhands in source order (`!important` only replaced by `!important`). */
function resolveOutline(declarations: readonly Declaration[]): OutlineState | null {
  let touched = false;
  let style: string | null = null; let styleImp = false;
  let widthZero: boolean | null = null; let widthImp = false;
  let transparent: boolean | null = null; let colorImp = false;
  let last = '';
  const canSet = (imp: boolean, currentImp: boolean): boolean => imp || !currentImp;
  for (const d of declarations) {
    switch (d.property) {
      case 'outline': {
        touched = true;
        const v = d.value.trim();
        const tokens = v.replace(FUNCTION_ARGS, '()').split(/\s+/);
        const newStyle = tokens.find((t) => OUTLINE_STYLES.has(t)) ??
          (v === 'none' || v === '0' || tokens.every(isZeroLength) ? 'none' : 'solid');
        const newWidthZero = tokens.some(isZeroLength) || v === 'none';
        const newTransparent = v.includes('transparent') || isAlphaZero(v);
        if (canSet(d.important, styleImp)) { style = newStyle; styleImp = d.important; }
        if (canSet(d.important, widthImp)) { widthZero = newWidthZero; widthImp = d.important; }
        if (canSet(d.important, colorImp)) { transparent = newTransparent; colorImp = d.important; }
        last = `outline: ${v}`;
        break;
      }
      case 'outline-style':
        if (canSet(d.important, styleImp)) { touched = true; style = d.value.trim(); styleImp = d.important; last = `outline-style: ${d.value}`; }
        break;
      case 'outline-width':
        if (canSet(d.important, widthImp)) { touched = true; widthZero = isZeroLength(d.value.trim()); widthImp = d.important; last = `outline-width: ${d.value}`; }
        break;
      case 'outline-color':
        if (canSet(d.important, colorImp)) { touched = true; transparent = d.value.includes('transparent') || isAlphaZero(d.value); colorImp = d.important; last = `outline-color: ${d.value}`; }
        break;
    }
  }
  if (!touched) return null;
  const suppressed = style === 'none' || style === 'hidden' || widthZero === true || transparent === true;
  return { suppressed, shown: last };
}

/** Last declaration of `property`; an `!important` one beats later normal ones. */
function effectiveDeclaration(declarations: readonly Declaration[], property: string): Declaration | null {
  const matching = declarations.filter((d) => d.property === property);
  if (matching.length === 0) return null;
  for (let k = matching.length - 1; k >= 0; k--) if (matching[k]!.important) return matching[k]!;
  return matching[matching.length - 1]!;
}

function isSuppressedOutline(value: string): boolean {
  const v = value.trim();
  if (v === 'none' || v === 'transparent') return true;
  if (isAlphaZero(v)) return true;
  const parts = v.replace(FUNCTION_ARGS, '()').split(/\s+/);
  return parts.some((p) => p === 'none' || p === 'transparent' || p === 'hidden' || isZeroLength(p));
}

/** `rgba(0,0,0,0)`, `rgb(0 0 0 / 0)`, `hsla(…, 0)` — fully transparent colours. */
function isAlphaZero(value: string): boolean {
  let from = 0;
  for (;;) {
    const open = value.indexOf('(', from);
    if (open < 0) return false;
    let nameStart = 0;
    for (let k = open - 1; k >= 0; k--) { if (!LETTER_RE.test(value[k]!)) { nameStart = k + 1; break; } }
    const name = value.substring(nameStart, open);
    const close = value.indexOf(')', open + 1);
    const body = value.substring(open + 1, close < 0 ? value.length : close);
    if (name === 'rgb' || name === 'rgba' || name === 'hsl' || name === 'hsla') {
      const slash = body.indexOf('/');
      let alpha: string | null;
      if (slash >= 0) alpha = body.substring(slash + 1);
      else { const parts = body.split(','); alpha = parts.length === 4 ? parts[3]! : null; }
      if (alpha !== null) {
        let a = alpha.trim();
        if (a.endsWith('%')) a = a.substring(0, a.length - 1);
        if (toDoubleOrNull(a) === 0) return true;
      }
    }
    if (close < 0) return false;
    from = close + 1;
  }
}

/** `3px`, `.5rem`, `2vh` — a length token with a positive value. */
function isNonZeroLength(token: string): boolean {
  let unitStart = -1;
  for (let k = 0; k < token.length; k++) {
    if (token[k] === '%' || LETTER_RE.test(token[k]!)) { unitStart = k; break; }
  }
  if (unitStart <= 0) return false;
  if (!LENGTH_UNITS.has(token.substring(unitStart))) return false;
  const num = toDoubleOrNull(token.substring(0, unitStart));
  return num !== null && num > 0;
}

function isZeroLength(token: string): boolean {
  return ZERO_LENGTH_RE.test(token);
}

/** Declarations that paint a visible focus indicator on their own. */
function isVisibleReplacement(d: Declaration): boolean {
  if (!REPLACEMENT_PROPERTIES.has(d.property)) return false;
  const v = d.value.trim();
  if (v === 'none' || v === '0' || v === 'transparent' || v === 'initial' || v === 'unset' || v === 'inherit') return false;
  if (v.includes('transparent') || isAlphaZero(v)) return false;
  if (d.property === 'box-shadow') {
    const hasColor = BOX_SHADOW_COLOR_RE.test(v.replace(/inset/g, ''));
    const nonZero = v.replace(FUNCTION_ARGS, '()').split(/[\s,]+/).some(isNonZeroLength);
    return hasColor && nonZero;
  }
  return true;
}

function isAcceptedPattern(selectorMember: string): boolean {
  return selectorMember.replace(/ /g, '').toLowerCase().includes(':not(:focus-visible)');
}

/** Blanks `/* *\/` and SCSS/LESS `//` comments (newlines kept); strings and `url(...)` bodies are left intact. */
function stripComments(css: string): string {
  const sb: string[] = [];
  let i = 0;
  let parenDepth = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '"' || c === "'") {
      sb.push(c); i++;
      while (i < css.length && css[i] !== c) {
        if (css[i] === '\\' && i + 1 < css.length) { sb.push(css[i]!); i++; }
        sb.push(css[i]!); i++;
      }
      if (i < css.length) { sb.push(css[i]!); i++; }
    } else if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      for (let k = i; k < stop; k++) sb.push(css[k] === '\n' || css[k] === '\r' ? css[k]! : ' ');
      i = stop;
    } else if (parenDepth === 0 && css.startsWith('//', i) && (i === 0 || css[i - 1] !== ':')) {
      while (i < css.length && css[i] !== '\n' && css[i] !== '\r') { sb.push(' '); i++; }
    } else {
      if (c === '(') parenDepth++; else if (c === ')' && parenDepth > 0) parenDepth--;
      sb.push(c); i++;
    }
  }
  return sb.join('');
}
