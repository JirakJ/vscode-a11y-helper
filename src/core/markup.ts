/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dependency-free tag tokenizer for HTML / JSX / TSX / Vue / Svelte / Razor
 * sources, plus a lazily-structured {@link MarkupDocument}. Shared by every
 * markup-based auditor so each file is parsed once.
 *
 * - comments (`<!-- -->`, JSX `{/* *\/}`, Razor `@* *@`), `<!doctype>`, CDATA
 *   sections and processing instructions are skipped,
 * - `<script>` / `<style>` / `<textarea>` bodies are skipped (style bodies are recorded),
 * - attribute names are lower-cased; quoted, unquoted and JSX-brace values are
 *   supported — brace expressions are string-, template-, regex- and
 *   comment-aware, and an unterminated expression falls back to the next `}`,
 * - JSX spreads (`{...props}`) are kept as attributes,
 * - line and column of every tag are tracked (CRLF-safe).
 *
 * Every traversal is iterative — deeply nested input cannot overflow the stack.
 */

/** Longest accessible-name text retained per element. */
export const MAX_NAME_LENGTH = 2_000;
/** Longest attribute value returned by {@link MarkupTag.attr}. */
export const MAX_ATTR_VALUE = 8_000;
/** Most tags visited when computing one element's visible text. */
export const MAX_NAME_TAGS = 512;
/** Raw characters collected before whitespace collapsing. */
export const MAX_RAW_TEXT = 16_000;
/** How many open elements a stray end tag may look back through before being ignored. */
export const MAX_CLOSE_SCOPE = 64;
/** Nested `${…}` template substitutions followed before treating deeper ones as plain text. */
const MAX_TEMPLATE_DEPTH = 32;

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** HTML void elements — never have an end tag. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** Opening `key` implicitly closes open elements in `value` (HTML optional end tags), repeatedly. */
export const IMPLICIT_CLOSERS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ['li', new Set(['li'])], ['p', new Set(['p'])], ['dt', new Set(['dt', 'dd'])], ['dd', new Set(['dt', 'dd'])],
  ['tr', new Set(['tr', 'td', 'th'])], ['td', new Set(['td', 'th'])], ['th', new Set(['td', 'th'])],
  ['option', new Set(['option'])], ['optgroup', new Set(['optgroup', 'option'])],
  ['a', new Set(['a'])], ['button', new Set(['button'])], ['video', new Set(['video', 'audio'])], ['audio', new Set(['audio', 'video'])],
  ['select', new Set(['select'])], ['form', new Set(['form'])],
  ['thead', new Set(['tbody', 'tfoot', 'tr', 'td', 'th'])], ['tbody', new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])],
  ['tfoot', new Set(['thead', 'tbody', 'tr', 'td', 'th'])],
]);

/** Block-level elements whose start tag implicitly closes an open `<p>`. */
export const BLOCK_LEVEL: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu',
  'nav', 'ol', 'pre', 'section', 'table', 'ul',
]);

const WS = /\s/;
export function isWhitespace(c: string | undefined): boolean {
  return c !== undefined && WS.test(c);
}

const LETTER = /\p{L}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
function isNameStart(c: string): boolean {
  return c === '_' || LETTER.test(c);
}
function isNameChar(c: string): boolean {
  return c === '-' || c === '_' || c === ':' || c === '.' || LETTER_OR_DIGIT.test(c);
}
function isUpper(c: string): boolean {
  return c !== c.toLowerCase() && c === c.toUpperCase();
}
function isLower(c: string): boolean {
  return c !== c.toUpperCase() && c === c.toLowerCase();
}

/** `{...props}` (JSX / Svelte), `v-bind="obj"` (Vue) or `@attributes` (Razor); a Svelte shorthand `{disabled}` is NOT a spread. */
function isSpreadKey(k: string): boolean {
  return k.startsWith('{...') || k === 'v-bind' || k === '@attributes';
}

/**
 * A start or end tag. `attributes` keys are lower-cased and keep source order
 * (a repeated attribute takes its last position). JSX expression values keep
 * their braces (`{expr}`); boolean attributes map to `""`; spreads are stored
 * under their literal text (`{...props}`). `line` is 1-based, `column` 0-based.
 */
export class MarkupTag {
  readonly lowerName: string;
  /** `true` for PascalCase JSX components (`<Button>`, `<Card.Header>`); all-uppercase names are legacy HTML. */
  readonly isComponent: boolean;
  private bindingNamesCache: Set<string> | undefined;
  private hasSpreadCache: boolean | undefined;

  constructor(
    readonly name: string,
    readonly attributes: ReadonlyMap<string, string>,
    readonly isClose: boolean,
    readonly selfClosing: boolean,
    readonly line: number,
    readonly column: number,
    readonly startOffset: number,
    readonly endOffset: number,
  ) {
    this.lowerName = name.toLowerCase();
    this.isComponent = name.length > 0 && isUpper(name[0]!) && [...name].some(isLower);
  }

  /** Trimmed attribute value, or `null` when absent or blank. Values longer than {@link MAX_ATTR_VALUE} are cut. */
  attr(name: string): string | null {
    const raw = this.attributes.get(name);
    if (raw === undefined) return null;
    const t = raw.trim();
    if (t.length === 0) return null;
    return t.length > MAX_ATTR_VALUE ? t.slice(0, MAX_ATTR_VALUE) : t;
  }

  has(name: string): boolean {
    return this.attributes.has(name);
  }

  /** `true` when the attribute value is computed at runtime — `{…}`, `@…`, `{{…}}` or any `{` inside quotes. */
  isDynamic(name: string): boolean {
    const v = this.attributes.get(name);
    if (v === undefined) return false;
    if (v.length <= 32) return MarkupTag.isDynamicValue(v);
    // long values are scanned once per tag and remembered — name computation revisits tags many times
    const cache = (this.dynamicCache ??= new Map<string, boolean>());
    let cached = cache.get(name);
    if (cached === undefined) {
      cached = MarkupTag.isDynamicValue(v);
      cache.set(name, cached);
    }
    return cached;
  }

  private dynamicCache: Map<string, boolean> | undefined;

  private static isDynamicValue(v: string): boolean {
    let i = 0;
    while (i < v.length && isWhitespace(v[i])) i++;
    if (i < v.length && (v[i] === '{' || v[i] === '@')) return true;
    return v.indexOf('{') >= 0;
  }

  /** Base names that have a framework binding (`:name`, `v-bind:name`, `[name]`, `bind:name`, `[attr.name]`). */
  private get bindingNames(): Set<string> {
    if (this.bindingNamesCache) return this.bindingNamesCache;
    const out = new Set<string>();
    for (const k of this.attributes.keys()) {
      if (k.startsWith('v-bind:')) out.add(k.substring(7));
      else if (k.startsWith('bind:')) out.add(k.substring(5));
      else if (k.startsWith('[attr.') && k.endsWith(']')) out.add(k.substring(6, k.length - 1));
      else if (k.startsWith('[') && k.endsWith(']')) out.add(k.substring(1, k.length - 1));
      else if (k.startsWith(':')) out.add(k.substring(1));
    }
    this.bindingNamesCache = out;
    return out;
  }

  /** `true` when a framework binding for `name` exists. */
  hasBinding(name: string): boolean {
    const b = this.bindingNames;
    return b.size > 0 && b.has(name);
  }

  /**
   * Three-valued boolean attribute: `true` for `muted`, `muted=""`,
   * `muted="muted"`, `muted="true"`, `muted={true}`; `false` when absent or
   * literally false; `null` when decided at runtime (`muted={isMuted}`, `:muted="x"`).
   */
  boolAttr(name: string): boolean | null {
    if (this.hasBinding(name)) return null;
    const raw = this.attributes.get(name);
    if (raw === undefined) return false;
    if (raw.length > 64) return this.isDynamic(name) ? null : true;
    const v = raw.trim().toLowerCase();
    if (v.length === 0 || v === name || v === 'true' || v === '{true}') return true;
    if (v === 'false' || v === '{false}') return false;
    if (v.startsWith('{') || v.startsWith('@') || v.includes('{{')) return null;
    return true;
  }

  /** `true` when unknown attributes may arrive at runtime — a JSX spread or a Vue object binding. */
  get hasSpread(): boolean {
    if (this.hasSpreadCache === undefined) {
      this.hasSpreadCache = [...this.attributes.keys()].some(isSpreadKey);
    }
    return this.hasSpreadCache;
  }

  /** `true` when a spread is present but a static `names` attribute is written after the last spread. */
  staticAttributeAfterSpread(...names: string[]): boolean {
    if (!this.hasSpread) return false;
    let afterSpread = false;
    let found = false;
    for (const k of this.attributes.keys()) {
      if (isSpreadKey(k)) { afterSpread = true; found = false; continue; }
      if (afterSpread && names.includes(k) && !this.isDynamic(k) && this.attr(k) !== null) found = true;
    }
    return found;
  }

  /** `true` when `name` is not subject to a later spread. */
  attributeDefinite(name: string): boolean {
    if (!this.hasSpread) return true;
    let afterSpread = false;
    let found = false;
    for (const k of this.attributes.keys()) {
      if (isSpreadKey(k)) { afterSpread = true; found = false; continue; }
      if (afterSpread && k === name) found = true;
    }
    return found;
  }

  /** `aria-hidden="true"` or JSX `aria-hidden={true}`. */
  get ariaHidden(): boolean {
    if (!this.attributes.has('aria-hidden')) return false;
    const v = this.attr('aria-hidden')?.toLowerCase();
    return v === 'true' || v === '{true}';
  }

  /** `hidden` attribute present and not literally false. */
  get hidden(): boolean {
    return (this.attributes.has('hidden') || this.bindingNames.has('hidden')) && this.boolAttr('hidden') === true;
  }

  get role(): string | null {
    return this.attr('role')?.toLowerCase() ?? null;
  }
}

/** A `<style>` body found in a markup file. */
export interface StyleBlock {
  readonly css: string;
  /** Absolute offset of the first CSS character. */
  readonly offset: number;
  /** 1-based line of the first CSS character. */
  readonly line: number;
  /** 0-based column of the first CSS character. */
  readonly column: number;
}

interface GapSummary {
  text: Int32Array;
  jsx: Int32Array;
  component: Int32Array;
}

/**
 * A tokenized markup file: the source, its tags, and lazily computed
 * structure (matching end tags, parents, hidden subtrees, style bodies).
 */
export class MarkupDocument {
  private closeArr: Int32Array | undefined;
  private parentArr: Int32Array | undefined;
  private endArr: Int32Array | undefined;
  private readonly hiddenCache: (boolean | undefined)[];
  private gapsCache: GapSummary | undefined;
  private dynamicNamePrefixCache: Int32Array | undefined;
  private idIndexCache: Map<string, number> | undefined;
  private readonly labelCache = new Map<number, string | null>();
  private fullDocumentCache: boolean | undefined;

  constructor(
    readonly source: string,
    readonly tags: readonly MarkupTag[],
    private readonly styleRanges: readonly [number, number, number, number][],
  ) {
    this.hiddenCache = new Array<boolean | undefined>(tags.length);
  }

  /** Index of the end tag matching each start tag, `-1` when none (void, self-closing, unclosed). */
  get closeIndex(): Int32Array {
    this.computeStructure();
    return this.closeArr!;
  }

  /** Index of the enclosing start tag for each tag, `-1` at the top level. */
  get parentIndex(): Int32Array {
    this.computeStructure();
    return this.parentArr!;
  }

  /**
   * Index of the tag at which each element's content ends: its matching end
   * tag, the end tag of an ancestor that forced it closed, or the sibling
   * that implicitly closed it; `tags.length` at EOF.
   */
  get contentEndIndex(): Int32Array {
    this.computeStructure();
    return this.endArr!;
  }

  private computeStructure(): void {
    if (this.closeArr) return;
    const tags = this.tags;
    const n = tags.length;
    const closeArr = new Int32Array(n).fill(-1);
    const parentArr = new Int32Array(n).fill(-1);
    const endArr = new Int32Array(n).fill(n);
    const stack: number[] = [];
    const pop = (endAt: number): void => { endArr[stack.pop()!] = endAt; };
    for (let i = 0; i < n; i++) {
      const t = tags[i]!;
      if (!t.isClose) {
        const implicit = IMPLICIT_CLOSERS.get(t.lowerName);
        if (implicit) {
          while (stack.length > 0 && implicit.has(tags[stack[stack.length - 1]!]!.lowerName)) pop(i);
        } else if (BLOCK_LEVEL.has(t.lowerName)) {
          while (stack.length > 0 && tags[stack[stack.length - 1]!]!.lowerName === 'p') pop(i);
        }
      }
      parentArr[i] = stack.length === 0 ? -1 : stack[stack.length - 1]!;
      if (t.isClose) {
        let k = stack.length - 1;
        const floor = Math.max(0, stack.length - MAX_CLOSE_SCOPE);
        while (k >= floor && tags[stack[k]!]!.lowerName !== t.lowerName) k--;
        if (k >= floor) {
          closeArr[stack[k]!] = i;
          parentArr[i] = k === 0 ? -1 : stack[k - 1]!;
          while (stack.length > k) pop(i);
        }
      } else if (!t.selfClosing && !VOID_ELEMENTS.has(t.lowerName)) {
        stack.push(i);
      } else {
        endArr[i] = i + 1;
      }
    }
    this.closeArr = closeArr;
    this.parentArr = parentArr;
    this.endArr = endArr;
  }

  /** `true` when the tag at `index` is hidden itself or sits inside a hidden ancestor. */
  isHidden(index: number): boolean {
    const cachedSelf = this.hiddenCache[index];
    if (cachedSelf !== undefined) return cachedSelf;
    const parents = this.parentIndex;
    const chain: number[] = [];
    let p = index;
    let result: boolean | undefined;
    while (p >= 0) {
      const cached = this.hiddenCache[p];
      if (cached !== undefined) { result = cached; break; }
      chain.push(p);
      const t = this.tags[p]!;
      if (!t.isClose && (t.hidden || t.ariaHidden)) { result = true; break; }
      p = parents[p]!;
    }
    const r = result ?? false;
    for (const c of chain) this.hiddenCache[c] = r;
    return r;
  }

  private contentEndOffset(openIndex: number): number {
    const end = this.contentEndIndex[openIndex]!;
    return end >= this.tags.length ? this.source.length : this.tags[end]!.startOffset;
  }

  private isEmptyElement(t: MarkupTag): boolean {
    return t.selfClosing || VOID_ELEMENTS.has(t.lowerName);
  }

  /** Source text between the start tag at `openIndex` and the end of its content (`""` for void / self-closing). */
  innerContent(openIndex: number): string {
    const open = this.tags[openIndex]!;
    if (this.isEmptyElement(open)) return '';
    return this.source.substring(open.endOffset, Math.max(open.endOffset, this.contentEndOffset(openIndex)));
  }

  private get gaps(): GapSummary {
    if (this.gapsCache) return this.gapsCache;
    const tags = this.tags;
    const source = this.source;
    const n = tags.length;
    const text = new Int32Array(n + 1);
    const jsx = new Int32Array(n + 1);
    const component = new Int32Array(n + 1);
    for (let k = 0; k < n; k++) {
      const t = tags[k]!;
      const from = t.endOffset;
      const to = k + 1 < n ? tags[k + 1]!.startOffset : source.length;
      let hasText = false;
      let hasJsx = false;
      let i = from;
      while (i < to) {
        const c = source[i]!;
        if (c === '<' && source.startsWith('<!--', i)) { const e = source.indexOf('-->', i + 4); i = e < 0 || e + 3 > to ? to : e + 3; continue; }
        if (c === '{' && source.startsWith('{/*', i)) { const e = source.indexOf('*/}', i + 3); i = e < 0 || e + 3 > to ? to : e + 3; continue; }
        if (c === '@' && source.startsWith('@*', i)) { const e = source.indexOf('*@', i + 2); i = e < 0 || e + 2 > to ? to : e + 2; continue; }
        if (c === '{') hasJsx = true;
        else if (!isWhitespace(c) && !hasText) hasText = true;
        if (hasText && hasJsx) break;
        i++;
      }
      const tagText = !t.isClose && (t.attr('alt') !== null || t.attr('aria-label') !== null);
      text[k + 1] = text[k]! + (hasText || tagText ? 1 : 0);
      jsx[k + 1] = jsx[k]! + (hasJsx ? 1 : 0);
      component[k + 1] = component[k]! + (!t.isClose && t.isComponent ? 1 : 0);
    }
    this.gapsCache = { text, jsx, component };
    return this.gapsCache;
  }

  private gapsInside(openIndex: number, counts: Int32Array): number {
    const end = Math.min(this.contentEndIndex[openIndex]!, this.tags.length);
    return counts[end]! - counts[openIndex]!;
  }

  /** `true` when the element contains a JSX expression or a PascalCase component child — O(1). */
  hasDynamicContent(openIndex: number): boolean {
    const open = this.tags[openIndex]!;
    if (this.isEmptyElement(open)) return false;
    const end = Math.min(this.contentEndIndex[openIndex]!, this.tags.length);
    if (this.gapsInside(openIndex, this.gaps.jsx) > 0) return true;
    const comp = this.gaps.component;
    return comp[end]! - comp[openIndex + 1]! > 0;
  }

  /** `true` when any non-whitespace text (or a nested `alt` / `aria-label`) exists inside the element — O(1). */
  hasAnyText(openIndex: number): boolean {
    const open = this.tags[openIndex]!;
    if (this.isEmptyElement(open)) return false;
    return this.gapsInside(openIndex, this.gaps.text) > 0;
  }

  /** `true` when a descendant contributes a name only known at runtime (`<img alt={x}>`, `aria-label={x}`, `v-text`, a spread …). */
  hasDynamicNameSource(openIndex: number): boolean {
    const end = Math.min(Math.max(this.contentEndIndex[openIndex]!, openIndex + 1), this.tags.length);
    const prefix = this.dynamicNamePrefix;
    return prefix[end]! - prefix[openIndex + 1]! > 0;
  }

  private get dynamicNamePrefix(): Int32Array {
    if (this.dynamicNamePrefixCache) return this.dynamicNamePrefixCache;
    const n = this.tags.length;
    const out = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const t = this.tags[i]!;
      const dynamic = !t.isClose && (
        t.hasSpread ||
        ((t.lowerName === 'img' || t.lowerName === 'area') && (t.isDynamic('alt') || t.hasBinding('alt'))) ||
        t.isDynamic('aria-label') || t.hasBinding('aria-label') ||
        t.isDynamic('aria-labelledby') || t.hasBinding('aria-labelledby') ||
        t.has('v-text') || t.has('v-html') || t.has('[innertext]') || t.has('[innerhtml]')
      );
      out[i + 1] = out[i]! + (dynamic ? 1 : 0);
    }
    this.dynamicNamePrefixCache = out;
    return out;
  }

  /** Nearest ancestor (or self when `includeSelf`) named `name`, memoised along the chain; `-1` when none. */
  nearestAncestor(index: number, name: string, cache: Map<number, number>, includeSelf = false): number {
    const parents = this.parentIndex;
    const chain: number[] = [];
    let i = includeSelf ? index : parents[index]!;
    let result = -1;
    while (i >= 0) {
      const cached = cache.get(i);
      if (cached !== undefined) { result = cached; break; }
      chain.push(i);
      if (this.tags[i]!.lowerName === name) { result = i; break; }
      i = parents[i]!;
    }
    for (const c of chain) cache.set(c, result);
    return result;
  }

  /** Visible text: text nodes outside hidden subtrees, nested `alt` / `aria-label`, comment-free, entity-decoded, collapsed. */
  visibleText(openIndex: number): string {
    return this.visibleTextBounded(openIndex)[0];
  }

  /**
   * {@link visibleText} plus a flag telling whether the traversal stopped
   * early — callers must treat an empty, truncated result as *unknown*.
   */
  visibleTextBounded(openIndex: number): [string, boolean] {
    const tags = this.tags;
    const source = this.source;
    const open = tags[openIndex]!;
    if (this.isEmptyElement(open)) return ['', false];
    const fullEnd = this.contentEndIndex[openIndex]!;
    const truncated = fullEnd - openIndex > MAX_NAME_TAGS;
    const endTag = truncated ? openIndex + MAX_NAME_TAGS : fullEnd;
    const endOffset = truncated ? tags[endTag]!.startOffset : this.contentEndOffset(openIndex);
    const parts: string[] = [];
    let len = 0;
    let cursor = open.endOffset;
    let i = openIndex + 1;
    let cut = truncated;
    const appendBounded = (from: number, to: number): void => {
      const room = MAX_RAW_TEXT - len;
      const end = Math.max(to, from);
      if (room <= 0) { if (end > from) cut = true; return; }
      if (end - from > room) cut = true;
      const piece = source.substring(from, Math.min(end, from + room));
      parts.push(' ', piece);
      len += 1 + piece.length;
    };
    const closeIdx = this.closeIndex;
    const contentEnd = this.contentEndIndex;
    while (i < endTag && len < MAX_RAW_TEXT) {
      const t = tags[i]!;
      appendBounded(cursor, t.startOffset);
      cursor = t.endOffset;
      if (!t.isClose && (t.hidden || t.ariaHidden)) {
        const skipTo = contentEnd[i]!;
        if (skipTo > i + 1 || (skipTo === i + 1 && !this.isEmptyElement(t))) {
          const exact = closeIdx[i] === skipTo;
          if (skipTo >= tags.length) cursor = endOffset;
          else if (exact) cursor = tags[skipTo]!.endOffset;
          else cursor = tags[skipTo]!.startOffset;
          if (skipTo >= tags.length) i = endTag;
          else if (exact) i = skipTo + 1;
          else i = skipTo;
          continue;
        }
      } else if (!t.isClose) {
        const appendAttr = (name: string): void => {
          if (t.isDynamic(name)) return;
          const value = t.attributes.get(name);
          if (value === undefined) return;
          const room = MAX_RAW_TEXT - len;
          if (value.length > room) cut = true;
          if (room > 0) {
            const piece = value.substring(0, Math.min(value.length, room));
            parts.push(' ', piece);
            len += 1 + piece.length;
          }
        };
        if (t.lowerName === 'img' || t.lowerName === 'area') appendAttr('alt');
        appendAttr('aria-label');
      }
      i++;
    }
    appendBounded(cursor, endOffset);
    const text = collapse(decodeEntities(stripTextComments(parts.join(''))));
    return [text.length > MAX_NAME_LENGTH ? text.slice(0, MAX_NAME_LENGTH) : text, cut];
  }

  private get idIndex(): Map<string, number> {
    if (this.idIndexCache) return this.idIndexCache;
    const map = new Map<string, number>();
    this.tags.forEach((t, i) => {
      if (t.isClose) return;
      const id = t.attr('id');
      if (id === null) return;
      if (!t.isDynamic('id') && !map.has(id)) map.set(id, i);
    });
    this.idIndexCache = map;
    return map;
  }

  /** Index of the first element with the given static `id`, or `-1`. */
  indexOfId(id: string): number {
    return this.idIndex.get(id) ?? -1;
  }

  /** Resolves an `aria-labelledby` id list to text; `null` when any id is missing here or dynamic. */
  textByIds(ids: string): string | null {
    const parts = ids.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0) return null;
    let sb = '';
    for (const id of parts) {
      const idx = this.indexOfId(id);
      if (idx < 0) return null;
      if (!this.labelCache.has(idx)) {
        const t = this.tags[idx]!;
        let value: string | null;
        if (t.isDynamic('aria-label') || t.hasBinding('aria-label')) {
          value = null;
        } else {
          const label = t.attr('aria-label');
          const [raw, truncated] = label !== null ? [label, false] : this.visibleTextBounded(idx);
          value = raw.length === 0 && (truncated || this.hasDynamicContent(idx) || this.hasDynamicNameSource(idx))
            ? null
            : raw.slice(0, MAX_NAME_LENGTH);
        }
        this.labelCache.set(idx, value);
      }
      const text = this.labelCache.get(idx);
      if (text === null || text === undefined) return null;
      sb += ' ' + text;
      if (sb.length > MAX_NAME_LENGTH) break;
    }
    return collapse(sb).slice(0, MAX_NAME_LENGTH);
  }

  /** `true` when the tag at `index` has an ancestor named `name`. */
  hasAncestor(index: number, name: string): boolean {
    const parents = this.parentIndex;
    let p = parents[index]!;
    while (p >= 0) {
      if (this.tags[p]!.lowerName === name) return true;
      p = parents[p]!;
    }
    return false;
  }

  /** Bodies of `<style>` elements. */
  styleBlocks(): StyleBlock[] {
    return this.styleRanges.map(([start, end, line, column]) => ({
      css: this.source.substring(start, end), offset: start, line, column,
    }));
  }

  /** Whether the source looks like a complete HTML document (`<html>` or `<body>` present). */
  get isFullDocument(): boolean {
    if (this.fullDocumentCache === undefined) this.fullDocumentCache = isFullDocument(this.source);
    return this.fullDocumentCache;
  }
}

const FULL_DOCUMENT_REGEX = /<(html|body)[\s>]/i;

/** Whether `source` looks like a complete HTML document (`<html>` or `<body>` present). */
export function isFullDocument(source: string): boolean {
  return FULL_DOCUMENT_REGEX.test(source);
}

/** `true` when `inner` contains a JSX expression (`{…}`) outside of tags. */
export function containsJsxExpression(inner: string): boolean {
  let inTag = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '<') inTag = true;
    else if (c === '>') inTag = false;
    else if (c === '{' && !inTag) return !inner.startsWith('{/*', i);
  }
  return false;
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const TEXT_COMMENT_REGEX = /<!--[\s\S]*?(?:-->|$)|\{\/\*[\s\S]*?(?:\*\/\}|$)|@\*[\s\S]*?(?:\*@|$)/g;

/** Removes HTML, JSX and Razor comments from a text fragment. */
export function stripTextComments(s: string): string {
  if (s.indexOf('<!--') < 0 && s.indexOf('{/*') < 0 && s.indexOf('@*') < 0) return s;
  return s.replace(TEXT_COMMENT_REGEX, ' ');
}

const ENTITY_REGEX = /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g;
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  raquo: '»', laquo: '«', rarr: '→', larr: '←', hellip: '…', mdash: '—', ndash: '–',
  copy: '©', reg: '®', trade: '™', times: '×',
};

function codePointToString(cp: number): string | null {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  if (cp === 0xa0 || cp === 0x2002 || cp === 0x2003 || cp === 0x2009 || cp === 0xfeff) return ' ';
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d) return '';
  return String.fromCodePoint(cp);
}

/** Decodes the common named / numeric character references; non-breaking spaces become plain spaces. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY_REGEX, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const hex = body.substring(2);
      return /^[0-9a-fA-F]+$/.test(hex) ? codePointToString(parseInt(hex, 16)) ?? m : m;
    }
    if (body.startsWith('#')) {
      const dec = body.substring(1);
      return /^[0-9]+$/.test(dec) ? codePointToString(parseInt(dec, 10)) ?? m : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body]! : m;
  });
}

function indexOfIgnoreCase(src: string, needle: string, from: number): number {
  const lower = needle.toLowerCase();
  const n = src.length;
  const m = lower.length;
  for (let i = from; i <= n - m; i++) {
    let k = 0;
    while (k < m && src[i + k]!.toLowerCase() === lower[k]) k++;
    if (k === m) return i;
  }
  return -1;
}

/** Parses `content` into a {@link MarkupDocument}. Never throws on malformed input. */
export function parseMarkup(content: string): MarkupDocument {
  const out: MarkupTag[] = [];
  const styles: [number, number, number, number][] = [];
  const n = content.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const col = (p: number): number => p - lineStart;

  const advanceNewline = (pos: number): number => {
    if (content[pos] === '\r' && pos + 1 < n && content[pos + 1] === '\n') { line++; lineStart = pos + 2; return pos + 2; }
    line++; lineStart = pos + 1; return pos + 1;
  };

  const walk = (from: number, to: number): number => {
    let p = from;
    const end = Math.min(Math.max(to, Math.min(from, n)), n);
    while (p < end) {
      const c = content[p];
      if (c === '\r' || c === '\n') p = advanceNewline(p); else p++;
    }
    return end;
  };

  const skipTo = (to: number): void => { i = walk(i, to); };

  let templateDepth = 0;
  const eofFrom = new Map<string, number>();
  const knownEof = (key: string, from: number): boolean => {
    const v = eofFrom.get(key);
    return v !== undefined && from >= v;
  };
  const rememberEof = (key: string, from: number): void => {
    eofFrom.set(key, Math.min(eofFrom.get(key) ?? Number.MAX_SAFE_INTEGER, from));
  };

  const scanQuoted = (from: number): number => {
    const q = content[from]!;
    if (knownEof('q' + q, from)) return n;
    let k = from + 1;
    while (k < n && content[k] !== q) {
      const c = content[k];
      if (c === '\\') {
        if (k + 1 < n && (content[k + 1] === '\r' || content[k + 1] === '\n')) { k = advanceNewline(k + 1); continue; }
        k += 2; continue;
      }
      if (c === '\r' || c === '\n') { k = advanceNewline(k); continue; }
      k++;
    }
    if (k >= n) rememberEof('q' + q, from);
    return Math.min(k + 1, n);
  };

  const scanTemplate = (from: number): number => {
    if (knownEof('`', from)) return n;
    let k = from + 1;
    while (k < n) {
      const c = content[k];
      if (c === '\\') {
        if (k + 1 < n && (content[k + 1] === '\r' || content[k + 1] === '\n')) { k = advanceNewline(k + 1); continue; }
        k += 2; continue;
      }
      if (c === '`') return k + 1;
      if (c === '$' && k + 1 < n && content[k + 1] === '{' && templateDepth < MAX_TEMPLATE_DEPTH) {
        templateDepth++;
        const end = scanBrace(k + 1);
        templateDepth--;
        if (end >= n) { rememberEof('`', from); return n; }
        k = end; continue;
      }
      if (c === '\r' || c === '\n') { k = advanceNewline(k); continue; }
      k++;
    }
    rememberEof('`', from);
    return n;
  };

  const scanRegex = (from: number): number => {
    let k = from + 1;
    let inClass = false;
    while (k < n) {
      const c = content[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '\r' || c === '\n') return k;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) return k + 1;
      k++;
    }
    return n;
  };

  function scanBrace(from: number): number {
    if (knownEof('{', from)) return n;
    let depth = 0;
    let k = from;
    let prev = '{';
    while (k < n) {
      const c = content[k]!;
      if (c === '\r' || c === '\n') { k = advanceNewline(k); continue; }
      if (c === '"' || c === "'") {
        k = scanQuoted(k);
        if (k >= n) { rememberEof('{', from); return n; }
        prev = c; continue;
      }
      if (c === '`') {
        k = scanTemplate(k);
        if (k >= n) { rememberEof('{', from); return n; }
        prev = '`'; continue;
      }
      if (c === '/' && k + 1 < n && content[k + 1] === '*') {
        if (knownEof('/*', k)) { rememberEof('{', from); return n; }
        const end = content.indexOf('*/', k + 2);
        if (end < 0) { rememberEof('/*', k); rememberEof('{', from); return n; }
        k = walk(k, end + 2); continue;
      }
      if (c === '/' && k + 1 < n && content[k + 1] === '/') {
        while (k < n && content[k] !== '\n' && content[k] !== '\r') k++;
        continue;
      }
      if (c === '/' && REGEX_PRECEDERS.has(prev)) { k = scanRegex(k); prev = '/'; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth <= 0) return k + 1; }
      if (!isWhitespace(c)) prev = c;
      k++;
    }
    rememberEof('{', from);
    return n;
  }

  const scanBraceBounded = (from: number): number => {
    const savedLine = line;
    const savedLineStart = lineStart;
    const end = scanBrace(from);
    if (end < n) return end;
    line = savedLine; lineStart = savedLineStart;
    if (knownEof('}', from)) return walk(from, n);
    const naive = content.indexOf('}', from + 1);
    if (naive < 0) rememberEof('}', from);
    return walk(from, naive < 0 ? n : naive + 1);
  };

  const skipWs = (q: number): number => {
    while (q < n && isWhitespace(content[q])) {
      if (content[q] === '\r' || content[q] === '\n') q = advanceNewline(q); else q++;
    }
    return q;
  };

  while (i < n) {
    const c = content[i]!;
    if (c === '\r' || c === '\n') { i = advanceNewline(i); continue; }
    if (c === '{' && content.startsWith('{/*', i)) {
      const end = content.indexOf('*/}', i + 3);
      skipTo(end < 0 ? n : end + 3); continue;
    }
    if (c === '@' && content.startsWith('@*', i)) {
      const end = content.indexOf('*@', i + 2);
      skipTo(end < 0 ? n : end + 2); continue;
    }
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
    let aborted = false;

    while (p < n) {
      const ch = content[p]!;
      if (ch === '\r' || ch === '\n') { p = advanceNewline(p); continue; }
      if (isWhitespace(ch)) { p++; continue; }
      if (ch === '>') { tagEnd = p + 1; p++; closed = true; break; }
      if (ch === '/' && p + 1 < n && content[p + 1] === '>') {
        selfClosing = true; tagEnd = p + 2; p += 2; closed = true; break;
      }
      if (ch === '{') {
        const end = scanBraceBounded(p);
        let key = content.substring(p, end);
        if (attrs.has(key)) { let n2 = 2; while (attrs.has(`${key}#${n2}`)) n2++; key = `${key}#${n2}`; }
        attrs.set(key, '');
        p = end;
        continue;
      }
      const an = p;
      while (p < n) {
        const cc = content[p]!;
        if (isWhitespace(cc) || cc === '=' || cc === '>' || cc === '/' || cc === '{') break;
        p++;
      }
      if (p === an) { p++; continue; }
      const attrName = content.substring(an, p).toLowerCase();
      let q = skipWs(p);
      if (q < n && content[q] === '=') {
        q = skipWs(q + 1);
        if (q >= n) { p = q; break; }
        const vc = content[q];
        let value: string;
        if (vc === '"' || vc === "'") {
          const end = content.indexOf(vc, q + 1);
          if (end < 0) { aborted = true; break; }
          value = content.substring(q + 1, end);
          walk(q + 1, end);
          p = end + 1;
        } else if (vc === '{') {
          const end = scanBraceBounded(q);
          value = content.substring(q, end);
          p = end;
        } else {
          const vs = q;
          while (q < n && !isWhitespace(content[q]) && content[q] !== '>') q++;
          let ve = q;
          if (ve > vs && content[ve - 1] === '/' && q < n && content[q] === '>') ve--;
          value = content.substring(vs, ve);
          p = ve;
        }
        attrs.delete(attrName);
        attrs.set(attrName, value);
      } else {
        attrs.delete(attrName);
        attrs.set(attrName, '');
        p = q;
      }
    }
    if (aborted) return new MarkupDocument(content, out, styles);
    if (!closed) break;

    out.push(new MarkupTag(name, attrs, isClose, selfClosing, startLine, startCol, tagStart, tagEnd));
    i = p;

    if (!isClose && !selfClosing) {
      const lname = name.toLowerCase();
      if (lname === 'script' || lname === 'style' || lname === 'textarea') {
        const bodyStart = i;
        const bodyLine = line;
        const bodyColumn = col(i);
        const endIdx = indexOfIgnoreCase(content, '</' + lname, i);
        const bodyEnd = endIdx < 0 ? n : endIdx;
        if (lname === 'style') styles.push([bodyStart, bodyEnd, bodyLine, bodyColumn]);
        skipTo(bodyEnd);
      }
    }
  }
  return new MarkupDocument(content, out, styles);
}

/** Tokenizes `content` into start / end tags in source order. */
export function tokenize(content: string): readonly MarkupTag[] {
  return parseMarkup(content).tags;
}

/** Strips markup from an inner fragment and returns its visible text. */
export function visibleTextOf(inner: string): string {
  if (inner.length === 0) return '';
  return parseMarkup(`<x>${inner}</x>`).visibleText(0);
}
