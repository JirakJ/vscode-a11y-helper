/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

import { MarkupDocument, MarkupTag, parseMarkup } from './markup';
import {
  InteractiveElement,
  NameResolution,
  NameSource,
  resolveAccessibleName,
  scanInteractiveElements,
} from './labelsScanner';

export type { InteractiveElement, NameResolution, NameSource } from './labelsScanner';
export { resolveAccessibleName, scanInteractiveElements } from './labelsScanner';

/** A labeled occurrence (what source named each element). */
export interface LabeledOccurrence {
  readonly element: InteractiveElement;
  readonly source: NameSource;
  readonly value: string | null;
}

/** An unlabeled (`NONE`) or placeholder-only (`PLACEHOLDER_ATTR`, warning) element. */
export interface LabelIssue {
  readonly element: InteractiveElement;
  readonly line: number;
  readonly column: number;
  readonly tagName: string;
  readonly role: string | null;
  readonly source: NameSource;
  readonly missingReason: string;
  readonly suggestion: string;
}

export interface LabelCoverageReport {
  readonly filePath: string;
  readonly total: number;
  readonly labeled: number;
  readonly unlabeled: number;
  readonly placeholderOnlyWarnings: number;
  /** Labeled / total × 100, one decimal; `100` for a file without interactive elements. */
  readonly coveragePercent: number;
  readonly issues: readonly LabelIssue[];
  readonly occurrences: readonly LabeledOccurrence[];
}

export interface ProjectLabelCoverageReport {
  readonly perFile: readonly LabelCoverageReport[];
  readonly total: number;
  readonly labeled: number;
  readonly unlabeled: number;
  readonly placeholderOnlyWarnings: number;
  readonly coveragePercent: number;
}

type LabelState = 'LABELED' | 'UNKNOWN' | 'NONE';
/** Template language of the audited file — decides which attribute values are runtime expressions. */
type Lang = 'HTML' | 'JSX' | 'VUE' | 'SVELTE' | 'RAZOR';

const JSX_EXPRESSION = /\{[^{}]*\}/g;
/** Elements a `<label>` can name (HTML "labelable elements"). */
const LABELABLE = new Set(['input', 'textarea', 'select', 'button', 'meter', 'output', 'progress']);

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot < 0 ? '' : filePath.substring(dot + 1).toLowerCase();
}

function langOf(filePath: string): Lang {
  switch (extensionOf(filePath)) {
    case 'jsx': case 'tsx': case 'js': case 'ts': case 'mjs': case 'astro': return 'JSX';
    case 'vue': return 'VUE';
    case 'svelte': return 'SVELTE';
    case 'razor': case 'cshtml': return 'RAZOR';
    default: return 'HTML';
  }
}

const LETTER = /\p{L}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;

/** `@(` or `@ident` followed by `.`, `[` or `(` — member access / invocation, not a literal handle. */
function isRazorExpression(v: string): boolean {
  if (v.length === 0 || v[0] !== '@') return false;
  if (v.length > 1 && v[1] === '(') return true;
  let i = 1;
  if (i >= v.length || !(LETTER.test(v[i]!) || v[i] === '_')) return false;
  while (i < v.length && (LETTER_OR_DIGIT.test(v[i]!) || v[i] === '_')) i++;
  while (i < v.length && v[i] === ' ') i++;
  return i < v.length && (v[i] === '.' || v[i] === '[' || v[i] === '(');
}

/** `{identifier.path}` or `{fn(args)}` anywhere in the value; single forward pass. */
function hasBraceInterpolation(v: string): boolean {
  let i = v.indexOf('{');
  while (i >= 0) {
    let j = i + 1;
    while (j < v.length && v[j] === ' ') j++;
    const identStart = j;
    while (j < v.length && (LETTER_OR_DIGIT.test(v[j]!) || v[j] === '_' || v[j] === '$' || v[j] === '.')) j++;
    const s = v[identStart];
    if (j > identStart && s !== undefined && (LETTER.test(s) || s === '_' || s === '$')) {
      if (j < v.length && v[j] === '(') {
        const close = v.indexOf(')', j + 1);
        if (close < 0) return false;
        j = close + 1;
      }
      while (j < v.length && v[j] === ' ') j++;
      if (j < v.length && v[j] === '}') return true;
    }
    i = v.indexOf('{', i + 1);
  }
  return false;
}

/**
 * Whether an attribute value is decided at runtime, per language: `{{…}}`
 * everywhere, a whole `{…}` expression outside plain HTML, a partial
 * `{ident}` interpolation only in Svelte, `@Model.X` / `@(…)` only in Razor.
 */
function isRuntimeValue(raw: string | null | undefined, lang: Lang): boolean {
  if (raw === null || raw === undefined) return false;
  const v = raw.trim();
  if (v.indexOf('{{') >= 0) return true;
  if (lang === 'HTML') return false;
  if (v.length >= 2 && v[0] === '{' && v[v.length - 1] === '}') return true;
  if (lang === 'RAZOR') return isRazorExpression(v);
  if (lang === 'SVELTE') return hasBraceInterpolation(v);
  return false;
}

/** Visible text of an element with JSX expressions removed. */
function literalText(doc: MarkupDocument, idx: number): string {
  const text = doc.visibleText(idx);
  return text.indexOf('{') >= 0 ? text.replace(JSX_EXPRESSION, ' ').trim() : text;
}

/**
 * `true` when a name source that the ARIA computation would consult before or
 * instead of the static result is decided at runtime.
 */
function nameIsDynamic(doc: MarkupDocument, idx: number, tag: MarkupTag, resolved: NameResolution, lang: Lang): boolean {
  const dyn = (name: string): boolean => tag.hasBinding(name) || isRuntimeValue(tag.attributes.get(name), lang);
  if (dyn('aria-labelledby')) return true;
  if (resolved.source === 'ARIA_LABELLEDBY') return false;
  if (dyn('aria-label')) return true;
  if (resolved.source === 'ARIA_LABEL') return false;
  const lower = tag.lowerName;
  const type = tag.attr('type')?.toLowerCase() ?? 'text';
  if (lower === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) {
    if (dyn('value')) return true;
  } else if (lower === 'input' && type === 'image') {
    if (dyn('alt')) return true;
  } else if (lower === 'a' || lower === 'button' || lower === 'summary' || tag.role !== null) {
    if (tag.has('v-text') || tag.has('v-html') || tag.has('[innertext]') || tag.has('[innerhtml]')) return true;
    if (lang !== 'HTML' && (doc.hasDynamicContent(idx) || doc.hasDynamicNameSource(idx))) {
      if (literalText(doc, idx).length === 0) return true;
    }
  }
  if (resolved.source !== 'NONE' && resolved.source !== 'PLACEHOLDER_ATTR') return false;
  return dyn('title') || dyn('placeholder');
}

/** A label names its control only when it has text (static → LABELED, runtime → UNKNOWN, empty → NONE). */
function labelText(doc: MarkupDocument, labelIdx: number, lang: Lang): LabelState {
  const label = doc.tags[labelIdx]!;
  if (label.hasBinding('aria-label') || isRuntimeValue(label.attributes.get('aria-label'), lang)) return 'UNKNOWN';
  if (label.has('v-text') || label.has('v-html') || label.has('[innertext]') || label.has('[innerhtml]') || label.hasSpread) return 'UNKNOWN';
  if (label.attr('aria-label') !== null) return 'LABELED';
  const [text, truncated] = doc.visibleTextBounded(labelIdx);
  const staticText = lang !== 'HTML' && text.indexOf('{') >= 0 ? text.replace(JSX_EXPRESSION, ' ').trim() : text;
  if (staticText.length > 0) return 'LABELED';
  if (truncated || (lang !== 'HTML' && (doc.hasDynamicContent(labelIdx) || doc.hasDynamicNameSource(labelIdx)))) return 'UNKNOWN';
  return 'NONE';
}

const forIsDynamic = (t: MarkupTag, lang: Lang): boolean =>
  t.hasBinding('for') || t.hasBinding('htmlfor') ||
  isRuntimeValue(t.attributes.get('for'), lang) || isRuntimeValue(t.attributes.get('htmlfor'), lang);

/** Resolves `<label for>` / wrapping `<label>` for an element the resolver could not name. */
function labelAssociation(
  doc: MarkupDocument,
  idx: number | undefined,
  tag: MarkupTag | undefined,
  labelFor: Map<string, number[]>,
  dynamicLabelFor: boolean,
  anyLabel: boolean,
  ancestorCache: Map<number, number>,
  lang: Lang,
): LabelState {
  if (idx === undefined || tag === undefined || !anyLabel) return 'NONE';
  if (!LABELABLE.has(tag.lowerName)) return 'NONE';
  const id = tag.attr('id');
  const idDynamic = tag.hasBinding('id') || isRuntimeValue(tag.attributes.get('id'), lang);

  if (id !== null && !idDynamic) {
    const labels = labelFor.get(id);
    if (labels) {
      const states = labels.map((l) => labelText(doc, l, lang));
      if (states.includes('LABELED')) return 'LABELED';
      if (states.includes('UNKNOWN')) return 'UNKNOWN';
      return 'NONE';
    }
  }
  if ((id !== null || tag.hasBinding('id')) && (idDynamic || dynamicLabelFor)) return 'UNKNOWN';

  const wrapper = doc.nearestAncestor(idx, 'label', ancestorCache);
  if (wrapper >= 0) {
    const w = doc.tags[wrapper]!;
    const wFor = w.attr('for') ?? w.attr('htmlfor');
    if (forIsDynamic(w, lang)) return 'UNKNOWN';
    if (wFor === null || (id !== null && wFor === id)) return labelText(doc, wrapper, lang);
  }
  return 'NONE';
}

function typeOf(el: InteractiveElement): string {
  return el.attributes.get('type')?.trim().toLowerCase() ?? 'text';
}

function missingReasonFor(el: InteractiveElement): string {
  const lower = el.tag.toLowerCase();
  switch (lower) {
    case 'button': return '<button> has no aria-label, aria-labelledby, title, or visible text content.';
    case 'a': return '<a href> has no aria-label, aria-labelledby, title, or visible text content.';
    case 'input': {
      const type = typeOf(el);
      if (type === 'button' || type === 'submit' || type === 'reset') return `<input type="${type}"> has no value, aria-label, aria-labelledby or title.`;
      if (type === 'image') return '<input type="image"> has no alt, aria-label, aria-labelledby or title.';
      return `<input type="${type}"> has no associated <label>, aria-label, aria-labelledby or title.`;
    }
    case 'textarea': return '<textarea> has no associated <label>, aria-label, aria-labelledby or title.';
    case 'select': return '<select> has no associated <label>, aria-label, aria-labelledby or title.';
    case 'summary': return '<summary> has no aria-label, aria-labelledby, title or visible text content.';
    default:
      return el.role !== null ? `Element with role="${el.role}" has no accessible name.` : 'Interactive element has no accessible name.';
  }
}

function suggestionFor(el: InteractiveElement): string {
  const lower = el.tag.toLowerCase();
  switch (lower) {
    case 'button': return 'Provide visible text content inside <button>…</button>, or add aria-label="…".';
    case 'a': return 'Provide visible link text between <a href>…</a>, or add aria-label="…" for icon-only links.';
    case 'input': {
      const type = typeOf(el);
      if (type === 'button' || type === 'submit' || type === 'reset') return `Add value="…" or aria-label="…" to the <input type="${type}">.`;
      if (type === 'image') return 'Add alt="…" describing the button action to <input type="image">.';
      return 'Associate a <label for="id"> with this input, or add aria-label="…".';
    }
    case 'textarea': return 'Associate a <label for="id"> with this <textarea>, or add aria-label="…".';
    case 'select': return 'Associate a <label for="id"> with this <select>, or add aria-label="…".';
    case 'summary': return 'Provide visible text content inside <summary>…</summary>.';
    default: return 'Add aria-label="…" (or aria-labelledby pointing at a visible element).';
  }
}

function makeIssue(el: InteractiveElement, source: NameSource, missingReason: string, suggestion: string): LabelIssue {
  return { element: el, line: el.line, column: el.column, tagName: el.tag, role: el.role, source, missingReason, suggestion };
}

/**
 * Screen Reader Label Coverage audit of one file (WAI-ARIA 1.2 accessible
 * name, WCAG 4.1.2). Understands `<label for>` / `htmlFor` and wrapping
 * labels, skips hidden subtrees, and neither counts nor reports elements
 * whose name is decided at runtime — an unknown name is not a missing one.
 * Which values are runtime expressions depends on `filePath`'s extension.
 */
export function auditLabels(source: string, filePath: string): LabelCoverageReport {
  const elements = scanInteractiveElements(source);
  const issues: LabelIssue[] = [];
  const occurrences: LabeledOccurrence[] = [];
  let labeled = 0;
  let placeholderWarnings = 0;
  let considered = 0;

  const doc = parseMarkup(source);
  const indexByOffset = new Map<number, number>();
  doc.tags.forEach((t, i) => { if (!t.isClose) indexByOffset.set(t.startOffset, i); });
  const lang = langOf(filePath);
  const labelFor = new Map<string, number[]>();
  let dynamicLabelFor = false;
  let anyLabel = false;
  doc.tags.forEach((t, i) => {
    if (t.isClose || t.lowerName !== 'label') return;
    anyLabel = true;
    if (forIsDynamic(t, lang)) { dynamicLabelFor = true; return; }
    const target = t.attr('for') ?? t.attr('htmlfor');
    if (target === null) return;
    const list = labelFor.get(target);
    if (list) list.push(i); else labelFor.set(target, [i]);
  });
  const labelAncestorCache = new Map<number, number>();

  for (const el of elements) {
    const idx = indexByOffset.get(el.startOffset);
    const tag = idx !== undefined ? doc.tags[idx] : undefined;
    if (idx !== undefined && doc.isHidden(idx)) continue;
    if (tag && tag.hasSpread && !tag.staticAttributeAfterSpread('aria-label', 'aria-labelledby')) continue;
    let res = resolveAccessibleName(el, source);
    const resolvedDynamic = res.source !== 'TEXT_CONTENT' && isRuntimeValue(res.value, lang);
    if (tag && idx !== undefined && (resolvedDynamic || nameIsDynamic(doc, idx, tag, res, lang))) continue;
    if (res.source === 'NONE' || res.source === 'PLACEHOLDER_ATTR') {
      const state = labelAssociation(doc, idx, tag, labelFor, dynamicLabelFor, anyLabel, labelAncestorCache, lang);
      if (state === 'LABELED') res = { source: 'LABEL_ELEMENT', value: tag?.attr('id') ?? 'label', isEmpty: false };
      else if (state === 'UNKNOWN') continue;
    }
    considered++;
    if (res.source === 'NONE') {
      issues.push(makeIssue(el, 'NONE', missingReasonFor(el), suggestionFor(el)));
    } else if (res.source === 'PLACEHOLDER_ATTR') {
      placeholderWarnings++;
      issues.push(makeIssue(
        el,
        'PLACEHOLDER_ATTR',
        'Accessible name relies solely on the `placeholder` attribute.',
        'Add a real <label for="…"> or aria-label — placeholders are not a substitute for a label (WCAG 3.3.2).',
      ));
      occurrences.push({ element: el, source: res.source, value: res.value });
    } else {
      labeled++;
      occurrences.push({ element: el, source: res.source, value: res.value });
    }
  }

  const total = considered;
  const raw = total === 0 ? 100 : (labeled / total) * 100;
  return {
    filePath,
    total,
    labeled,
    unlabeled: total - labeled - placeholderWarnings,
    placeholderOnlyWarnings: placeholderWarnings,
    coveragePercent: Math.round(raw * 10) / 10,
    issues,
    occurrences,
  };
}

/** Aggregates per-file reports; coverage is recomputed from project totals (micro-average). */
export function aggregateLabelReports(reports: readonly LabelCoverageReport[]): ProjectLabelCoverageReport {
  const sum = (f: (r: LabelCoverageReport) => number): number => reports.reduce((a, r) => a + f(r), 0);
  const total = sum((r) => r.total);
  const labeled = sum((r) => r.labeled);
  return {
    perFile: reports,
    total,
    labeled,
    unlabeled: sum((r) => r.unlabeled),
    placeholderOnlyWarnings: sum((r) => r.placeholderOnlyWarnings),
    coveragePercent: total === 0 ? 100 : Math.round((labeled / total) * 1000) / 10,
  };
}
