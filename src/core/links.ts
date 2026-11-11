/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

import { collapse, decodeEntities, MarkupDocument, MarkupTag, MAX_NAME_LENGTH, MAX_NAME_TAGS, parseMarkup } from './markup';
import { AuditRule, IssueSeverity, MarkupAuditReport, MarkupIssue, reportOf } from './markupAudit';

const LINK_PURPOSE = 'https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html';
const LINK_ONLY = 'https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-link-only.html';

/** Rules reported by {@link auditLinks}. */
export const LinkRules = {
  EMPTY: { id: 'link-empty', title: 'Link without accessible name', wcag: 'WCAG 2.4.4 / 4.1.2', helpUri: LINK_PURPOSE },
  GENERIC_TEXT: { id: 'link-generic-text', title: 'Generic link text', wcag: 'WCAG 2.4.9 (AAA) / 2.4.4 advisory', helpUri: LINK_ONLY },
  URL_AS_TEXT: { id: 'link-url-as-text', title: 'Raw URL used as link text', wcag: 'WCAG 2.4.4 advisory', helpUri: LINK_PURPOSE },
  PLACEHOLDER_HREF: {
    id: 'link-placeholder-href', title: 'Link used as a button', wcag: 'WCAG 4.1.2 / 2.1.1',
    helpUri: 'https://www.w3.org/WAI/ARIA/apg/patterns/button/',
  },
  NO_HREF_CLICKABLE: {
    id: 'link-no-href-clickable', title: 'Clickable <a> without href is not keyboard reachable', wcag: 'WCAG 2.1.1',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html',
  },
  NEW_WINDOW: {
    id: 'link-new-window-unannounced', title: 'Link opens a new window without warning', wcag: 'WCAG 3.2.5 (G201)',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Techniques/general/G201',
  },
  AMBIGUOUS_DUPLICATE: {
    id: 'link-ambiguous-duplicate', title: 'Same link text points to different targets', wcag: 'WCAG 2.4.9 (AAA) / 2.4.4 advisory', helpUri: LINK_ONLY,
  },
} as const satisfies Record<string, AuditRule>;

export const LINK_RULES: readonly AuditRule[] = Object.values(LinkRules);

/** Link texts that carry no purpose out of context (compared after punctuation stripping). */
export const GENERIC_LINK_TEXTS: ReadonlySet<string> = new Set([
  'click here', 'click', 'here', 'read more', 'more', 'learn more', 'link', 'this', 'this link',
  'this page', 'more info', 'more information', 'info', 'details', 'continue', 'go', 'see more',
  'view more', 'find out more', 'download', 'open', 'start', 'next', 'previous', 'back', 'page',
]);

const NAVIGATION_ATTRIBUTES = [
  'asp-action', 'asp-controller', 'asp-page', 'asp-route', 'asp-area', 'routerlink', '[routerlink]', 'ng-href', 'xlink:href',
];

const CLICK_HANDLER_ATTRIBUTES: ReadonlySet<string> = new Set([
  'onclick', '@click', 'v-on:click', 'on:click', '(click)', 'onclick.prevent', '@click.prevent', '@click.stop', '@onclick',
]);

interface LinkInfo {
  index: number;
  tag: MarkupTag;
  text: string;
  /** `null` when the name is decided at runtime. */
  accessibleName: string | null;
}

/**
 * Audits `<a>` elements for WCAG 2.4.4 *Link Purpose (In Context)* and the
 * keyboard / semantics problems that most often accompany misused anchors.
 *
 * Failing rules: empty link (ERROR), placeholder href (WARNING), clickable
 * `<a>` without href (WARNING). Advisory (INFO, never lowers the score):
 * generic text, raw URL as text, new window without warning, ambiguous
 * duplicates. Links in hidden subtrees and PascalCase components are ignored.
 */
export function auditLinks(doc: MarkupDocument, filePath: string): MarkupAuditReport {
  const tags = doc.tags;
  const issues: MarkupIssue[] = [];
  const links: LinkInfo[] = [];

  tags.forEach((tag, index) => {
    if (tag.isClose || tag.isComponent || tag.lowerName !== 'a') return;
    if (doc.isHidden(index)) return;
    if (tag.hasSpread && !tag.staticAttributeAfterSpread('aria-label', 'aria-labelledby')) return;
    const hasHref = hasNavigation(tag);
    const actsAsControl = hasHref || hasClickHandler(tag) || tag.role !== null || tag.has('tabindex') || tag.hasBinding('tabindex');
    if (!actsAsControl) return;
    const [text, truncated] = doc.visibleTextBounded(index);
    const name = text.length === 0 && truncated ? null : accessibleName(doc, index, tag, text);
    links.push({ index, tag, text, accessibleName: name });
  });

  const failing = new Set<number>();
  const report = (link: LinkInfo, rule: AuditRule, severity: IssueSeverity, message: string, suggestion: string): void => {
    if (severity !== 'INFO') failing.add(link.tag.startOffset);
    issues.push({ rule, severity, line: link.tag.line, column: link.tag.column, message, suggestion });
  };

  for (const link of links) {
    const tag = link.tag;
    const href = tag.attr('href');
    const hasHref = hasNavigation(tag);
    const name = link.accessibleName;

    if (name !== null) {
      if (name.length === 0) {
        report(
          link, LinkRules.EMPTY, 'ERROR',
          '<a> has no accessible name — screen readers announce it as "link" with no purpose.',
          'Add visible link text, or aria-label when the link contains only an icon/image.',
        );
      } else if (isGeneric(name)) {
        report(
          link, LinkRules.GENERIC_TEXT, 'INFO',
          `Link text "${display(name)}" does not describe the destination on its own (fine only when the surrounding sentence or heading supplies it).`,
          'Make the text self-explanatory (e.g. "Read the pricing guide") or add aria-label with the full purpose.',
        );
      } else if (looksLikeUrl(link.text) && tag.attr('aria-label') === null) {
        report(
          link, LinkRules.URL_AS_TEXT, 'INFO',
          'Link text is a raw URL; screen readers read it character by character.',
          'Use the page title or a short description as the link text.',
        );
      }
    }

    const hrefDefinite = tag.attributeDefinite('href');
    const targetDefinite = tag.attributeDefinite('target');
    if (hrefDefinite && href !== null && !tag.isDynamic('href') && isPlaceholderHref(href) && tag.role !== 'button') {
      report(
        link, LinkRules.PLACEHOLDER_HREF, 'WARNING',
        `href="${display(href)}" — the anchor triggers an action instead of navigating.`,
        'Use <button type="button"> for actions; reserve <a href> for navigation.',
      );
    }

    const tabRaw = tag.attr('tabindex');
    const tabindex = tabRaw === null ? null : parseIntLoose(tabRaw);
    const focusable = tag.hasBinding('tabindex') || (tabindex !== null && tabindex >= 0) || (tag.has('tabindex') && tag.isDynamic('tabindex'));
    if (!tag.hasSpread && !hasHref && hasClickHandler(tag) && !focusable) {
      report(
        link, LinkRules.NO_HREF_CLICKABLE, 'WARNING',
        '<a> without href has a click handler but cannot receive keyboard focus.',
        'Replace with <button>, or add href — keyboard users cannot reach this control.',
      );
    }

    if (targetDefinite && tag.attr('target')?.toLowerCase() === '_blank' && name !== null &&
      !mentionsNewWindow(name) && !mentionsNewWindow(tag.attr('title') ?? '')) {
      report(
        link, LinkRules.NEW_WINDOW, 'INFO',
        'Link opens in a new window/tab without telling the user in advance.',
        'Append "(opens in new tab)" to the text, a visually hidden span, or the aria-label.',
      );
    }
  }

  // Ambiguous duplicates: same accessible name, different static href.
  const byName = new Map<string, Map<string, LinkInfo>>();
  for (const link of links) {
    const name = link.accessibleName;
    if (name === null) continue;
    if (name.length === 0 || isGeneric(name)) continue;
    if (name.length >= MAX_NAME_LENGTH) continue;
    const href = link.tag.attr('href');
    if (href === null) continue;
    if (link.tag.isDynamic('href') || isPlaceholderHref(href) || !link.tag.attributeDefinite('href')) continue;
    const key = name.toLowerCase();
    let targets = byName.get(key);
    if (!targets) { targets = new Map(); byName.set(key, targets); }
    if (!targets.has(href)) {
      targets.set(href, link);
      if (targets.size > 1) {
        report(
          link, LinkRules.AMBIGUOUS_DUPLICATE, 'INFO',
          `Link text "${display(name)}" is also used for a different destination (${display(targets.keys().next().value as string)}).`,
          'Give each destination a distinct link text, or extend it with aria-label.',
        );
      }
    }
  }

  issues.sort((a, b) => a.line - b.line || a.column - b.column);
  return reportOf(filePath, links.length, failing.size, issues);
}

/** Convenience overload: parses `source` first. */
export function auditLinksSource(source: string, filePath: string): MarkupAuditReport {
  return auditLinks(parseMarkup(source), filePath);
}

/** Accessible name per the statically evaluable subset of the ARIA name computation; `null` = unknown. */
function accessibleName(doc: MarkupDocument, index: number, tag: MarkupTag, text: string): string | null {
  if (tag.hasBinding('aria-labelledby') || tag.hasBinding('aria-label')) return null;
  if (tag.has('aria-labelledby')) {
    if (tag.isDynamic('aria-labelledby')) return null;
    const ids = tag.attr('aria-labelledby');
    if (ids === null) return null;
    const resolved = doc.textByIds(ids);
    if (resolved === null) return null;
    if (resolved.length > 0) return resolved;
  }
  if (tag.hasBinding('aria-label') || tag.isDynamic('aria-label')) return null;
  const label = tag.attr('aria-label');
  if (label !== null) return collapse(decodeEntities(label));
  if (text.length > 0) return text;
  if (doc.hasDynamicContent(index) || doc.hasDynamicNameSource(index)) return null;
  const lookup = descendantLabelledByText(doc, index);
  if (lookup.sawReference) {
    if (lookup.text === null) return null;
    if (lookup.text.length > 0) return lookup.text;
  }
  if (tag.has('v-text') || tag.has('v-html') || tag.has('[innertext]') || tag.has('[innerhtml]')) return null;
  if (tag.hasBinding('title') || tag.isDynamic('title')) return null;
  return tag.attr('title') ?? '';
}

/** Diagnostics quote at most 120 characters of user text. */
function display(text: string): string {
  return text.length > 120 ? text.slice(0, 117) + '…' : text;
}

/** Text contributed by descendants carrying a static `aria-labelledby`; `text: null` with a reference = unknown. */
function descendantLabelledByText(doc: MarkupDocument, index: number): { sawReference: boolean; text: string | null } {
  const end = Math.min(doc.contentEndIndex[index]!, Math.min(doc.tags.length, index + 1 + MAX_NAME_TAGS));
  let sawReference = false;
  let sb = '';
  for (let i = index + 1; i < end; i++) {
    const t = doc.tags[i]!;
    if (t.isClose) continue;
    if (!t.has('aria-labelledby')) continue;
    sawReference = true;
    if (t.isDynamic('aria-labelledby')) return { sawReference: true, text: null };
    const ids = t.attr('aria-labelledby');
    if (ids === null) continue;
    const resolved = doc.textByIds(ids);
    if (resolved === null) return { sawReference: true, text: null };
    if (resolved.length > 0) sb += ' ' + resolved;
  }
  return { sawReference, text: collapse(sb) };
}

// Java's \p{Punct} (ASCII punctuation) plus … » « › →
const PUNCT = /[!-/:-@[-`{-~…»«›→]+/g;

export function isGeneric(name: string): boolean {
  const normalized = name.toLowerCase().replace(PUNCT, ' ').replace(/\s+/g, ' ').trim();
  return GENERIC_LINK_TEXTS.has(normalized);
}

function looksLikeUrl(text: string): boolean {
  const t = text.toLowerCase();
  return !text.includes(' ') && (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('www.'));
}

function isPlaceholderHref(href: string): boolean {
  const h = href.trim().toLowerCase();
  return h === '#' || h === '#!' || h.startsWith('javascript:');
}

function hasNavigation(tag: MarkupTag): boolean {
  return tag.has('href') || tag.hasBinding('href') || NAVIGATION_ATTRIBUTES.some((a) => tag.has(a));
}

function hasClickHandler(tag: MarkupTag): boolean {
  for (const k of tag.attributes.keys()) if (CLICK_HANDLER_ATTRIBUTES.has(k)) return true;
  return false;
}

/** Parses `0`, `{0}`, `{"0"}`, `-1` … like Kotlin's `toIntOrNull` after unwrapping. */
function parseIntLoose(raw: string): number | null {
  let s = raw.trim();
  if (s.startsWith('{')) s = s.substring(1);
  if (s.endsWith('}')) s = s.substring(0, s.length - 1);
  s = s.trim().replace(/^["']+|["']+$/g, '');
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
}

function mentionsNewWindow(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes('new window') || t.includes('new tab') || t.includes('opens in') || t.includes('external');
}
