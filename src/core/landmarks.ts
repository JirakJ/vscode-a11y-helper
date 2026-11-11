/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ARIA landmark coverage analysis for HTML / JSX / TSX documents.
 *
 * Detection rules (WAI-ARIA 1.2 + common a11y tooling):
 *
 * 1. Implicit roles only apply to lowercase HTML element names.
 * 2. `<header>` / `<footer>` expose `banner` / `contentinfo` only when they
 *    are NOT nested inside `<main>`, `<article>`, `<section>`, `<aside>`, `<nav>`.
 * 3. `<section>` exposes `region` only when it has an accessible name.
 * 4. `<form>` exposes `form` only when it has an accessible name.
 * 5. An explicit `role="…"` attribute always overrides the implicit role.
 * 6. Required landmark set (WCAG 1.3.1 / 2.4.1): main, navigation, banner, contentinfo.
 */

/** Landmark role names, in canonical (ordinal) order. */
export const LANDMARK_KINDS = [
  'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'form', 'region',
] as const;

export type LandmarkKind = (typeof LANDMARK_KINDS)[number];
export type LandmarkSource = 'IMPLICIT_HTML' | 'EXPLICIT_ROLE';
export type LandmarkIssueSeverity = 'ERROR' | 'WARNING';

/** One detected landmark. `line` and `column` are both 1-based. */
export interface LandmarkOccurrence {
  readonly kind: LandmarkKind;
  readonly tagName: string;
  readonly source: LandmarkSource;
  readonly line: number;
  readonly column: number;
  readonly accessibleName: string | null;
}

export interface LandmarkIssue {
  readonly kind: LandmarkKind;
  /** Same as `kind` — the WAI-ARIA role name. */
  readonly roleName: string;
  readonly severity: LandmarkIssueSeverity;
  readonly message: string;
}

export interface LandmarkCoverageReport {
  readonly fileName: string;
  readonly occurrences: readonly LandmarkOccurrence[];
  /** Only kinds with at least one occurrence are present. */
  readonly countsByKind: ReadonlyMap<LandmarkKind, number>;
  readonly missingRequired: readonly LandmarkKind[];
  readonly duplicateTopLevel: readonly LandmarkKind[];
  readonly issues: readonly LandmarkIssue[];
  readonly score: number;
  readonly totalLandmarkCount: number;
}

/** Returns the landmark kind whose role name equals `role` (case-insensitive), or `null`. */
export function landmarkKindFromRoleName(role: string | null | undefined): LandmarkKind | null {
  if (role === null || role === undefined || role.trim().length === 0) return null;
  const lower = role.trim().toLowerCase();
  return (LANDMARK_KINDS as readonly string[]).includes(lower) ? (lower as LandmarkKind) : null;
}

const SECTIONING_ANCESTORS = new Set(['main', 'article', 'section', 'aside', 'nav']);

const IMPLICIT_ROLES = new Map<string, LandmarkKind>([
  ['main', 'main'],
  ['nav', 'navigation'],
  ['aside', 'complementary'],
  ['header', 'banner'],
  ['footer', 'contentinfo'],
  ['section', 'region'],
  ['form', 'form'],
]);

const REQUIRED_LANDMARKS: readonly LandmarkKind[] = ['main', 'navigation', 'banner', 'contentinfo'];
const UNIQUE_LANDMARKS: readonly LandmarkKind[] = ['main', 'banner', 'contentinfo'];

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

type TagKind = 'OPEN' | 'CLOSE' | 'SELF_CLOSING';

interface RawTag {
  name: string;
  attributes: Map<string, string | null>;
  kind: TagKind;
  line: number;
  column: number;
}

/** Analyses `content` and returns its landmark coverage report. */
export function analyzeLandmarks(content: string, fileName: string): LandmarkCoverageReport {
  const tags = tokenizeLandmarkTags(content);
  const occurrences: LandmarkOccurrence[] = [];
  const openStack: string[] = [];

  for (const tag of tags) {
    if (tag.kind === 'CLOSE') {
      const lower = tag.name.toLowerCase();
      const idx = openStack.lastIndexOf(lower);
      if (idx >= 0) openStack.length = idx;
      continue;
    }
    const occ = buildOccurrence(tag, openStack);
    if (occ) occurrences.push(occ);
    if (tag.kind === 'OPEN' && !VOID.has(tag.name.toLowerCase())) openStack.push(tag.name.toLowerCase());
  }

  const counts = new Map<LandmarkKind, number>();
  for (const o of occurrences) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  const missing = REQUIRED_LANDMARKS.filter((k) => (counts.get(k) ?? 0) === 0);
  const duplicates = UNIQUE_LANDMARKS
    .filter((k) => (counts.get(k) ?? 0) > 1)
    .filter((k) => occurrences.some((o) => o.kind === k && (o.accessibleName === null || o.accessibleName.trim().length === 0)))
    .sort((a, b) => LANDMARK_KINDS.indexOf(a) - LANDMARK_KINDS.indexOf(b));

  return {
    fileName,
    occurrences,
    countsByKind: counts,
    missingRequired: missing,
    duplicateTopLevel: duplicates,
    issues: buildIssues(missing, duplicates, occurrences),
    score: computeScore(counts, missing, duplicates, occurrences),
    totalLandmarkCount: occurrences.length,
  };
}

function buildOccurrence(tag: RawTag, ancestors: readonly string[]): LandmarkOccurrence | null {
  const rawName = tag.name;
  const first = rawName[0];
  const isJsxComponent = first !== undefined && first !== first.toLowerCase() && first === first.toUpperCase();
  const explicitKind = landmarkKindFromRoleName(tag.attributes.get('role'));
  const accessibleName = computeAccessibleName(tag.attributes);

  if (explicitKind !== null) {
    return { kind: explicitKind, tagName: rawName, source: 'EXPLICIT_ROLE', line: tag.line, column: tag.column, accessibleName };
  }
  if (isJsxComponent) return null;
  const lowerName = rawName.toLowerCase();
  const implicit = IMPLICIT_ROLES.get(lowerName);
  if (implicit === undefined) return null;
  if (!shouldEmitImplicit(lowerName, tag.attributes, ancestors, accessibleName)) return null;
  return { kind: implicit, tagName: rawName, source: 'IMPLICIT_HTML', line: tag.line, column: tag.column, accessibleName };
}

function shouldEmitImplicit(
  lowerName: string,
  attrs: Map<string, string | null>,
  ancestors: readonly string[],
  accessibleName: string | null,
): boolean {
  if (lowerName === 'header' || lowerName === 'footer') {
    return !ancestors.some((a) => SECTIONING_ANCESTORS.has(a));
  }
  if (lowerName === 'section' || lowerName === 'form') {
    return accessibleName !== null && accessibleName.trim().length > 0;
  }
  const role = attrs.get('role')?.trim().toLowerCase();
  return !(role === 'presentation' || role === 'none');
}

function computeAccessibleName(attrs: Map<string, string | null>): string | null {
  for (const key of ['aria-label', 'aria-labelledby', 'title']) {
    const v = attrs.get(key)?.trim();
    if (v) return v;
  }
  return null;
}

function buildIssues(
  missing: readonly LandmarkKind[],
  duplicates: readonly LandmarkKind[],
  occurrences: readonly LandmarkOccurrence[],
): LandmarkIssue[] {
  const issues: LandmarkIssue[] = [];
  for (const k of missing) {
    issues.push({ kind: k, roleName: k, severity: 'ERROR', message: `Required landmark \`${k}\` is missing.` });
  }
  for (const k of duplicates) {
    const lines = occurrences.filter((o) => o.kind === k).map((o) => `${o.line}:${o.column}`).join(', ');
    issues.push({
      kind: k,
      roleName: k,
      severity: 'WARNING',
      message: `Multiple \`${k}\` landmarks without unique accessible names (at ${lines}).`,
    });
  }
  return issues;
}

function computeScore(
  counts: ReadonlyMap<LandmarkKind, number>,
  missing: readonly LandmarkKind[],
  duplicates: readonly LandmarkKind[],
  occurrences: readonly LandmarkOccurrence[],
): number {
  if (occurrences.length === 0) return 0;
  const required = REQUIRED_LANDMARKS.length;
  const present = required - missing.length;
  let score = (present / required) * 80;
  if ((counts.get('complementary') ?? 0) > 0) score += 5;
  if ((counts.get('search') ?? 0) > 0) score += 5;
  if ((counts.get('region') ?? 0) > 0 || (counts.get('form') ?? 0) > 0) score += 5;
  score -= duplicates.length * 10;
  score += 5;
  return Math.trunc(Math.min(100, Math.max(0, score)));
}

/** Renders a landmark report as Markdown. */
export function landmarkReportToMarkdown(r: LandmarkCoverageReport): string {
  let sb = '# ARIA Landmark Coverage Report\n\n';
  sb += `**File:** \`${r.fileName}\`  \n`;
  sb += `**Score:** ${r.score}/100  \n`;
  sb += `**Total landmarks:** ${r.totalLandmarkCount}\n\n`;
  sb += '## Counts per role\n\n';
  if (r.countsByKind.size === 0) {
    sb += '_No landmarks detected._\n\n';
  } else {
    sb += '| Role | Count |\n|---|---|\n';
    for (const k of LANDMARK_KINDS) {
      const n = r.countsByKind.get(k) ?? 0;
      if (n > 0) sb += `| ${k} | ${n} |\n`;
    }
    sb += '\n';
  }
  sb += '## Occurrences\n\n';
  if (r.occurrences.length === 0) {
    sb += '_None._\n\n';
  } else {
    for (const o of r.occurrences) {
      sb += `- \`${o.kind}\` via \`<${o.tagName}>\` (${o.source === 'EXPLICIT_ROLE' ? 'role' : 'implicit'}) at ${r.fileName}:${o.line}:${o.column}`;
      if (o.accessibleName !== null) sb += ` — name: "${o.accessibleName}"`;
      sb += '\n';
    }
    sb += '\n';
  }
  sb += '## Issues\n\n';
  if (r.issues.length === 0) {
    sb += '_No issues._\n';
  } else {
    for (const i of r.issues) sb += `- **${i.severity}** (${i.roleName}): ${i.message}\n`;
  }
  return sb;
}

// ── Tokenizer ────────────────────────────────────────────────────────────

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

/**
 * Walks `content` once and returns tags in source order. Comments, CDATA,
 * doctype declarations, processing instructions and `<script>` / `<style>`
 * bodies are skipped. Columns are 1-based.
 */
function tokenizeLandmarkTags(content: string): RawTag[] {
  const out: RawTag[] = [];
  const n = content.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const col = (pos: number): number => pos - lineStart + 1;
  const advance = (to: number): void => {
    for (let p = i; p < to; p++) {
      if (content[p] === '\n') { line++; lineStart = p + 1; }
    }
    i = to;
  };

  while (i < n) {
    const c = content[i];
    if (c === '\n') { line++; lineStart = i + 1; i++; continue; }
    if (c !== '<') { i++; continue; }

    if (content.startsWith('<!--', i)) {
      const end = content.indexOf('-->', i + 4);
      if (end < 0) { advance(n); break; }
      advance(end + 3); continue;
    }
    if (content.startsWith('<![CDATA[', i)) {
      const end = content.indexOf(']]>', i + 9);
      if (end < 0) { advance(n); break; }
      advance(end + 3); continue;
    }
    if (content.startsWith('<!', i) || content.startsWith('<?', i)) {
      const end = content.indexOf('>', i + 2);
      if (end < 0) { advance(n); break; }
      advance(end + 1); continue;
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

    const attrs = new Map<string, string | null>();
    let selfClosing = false;
    let closed = false;
    while (p < n) {
      const ch = content[p]!;
      if (ch === '\n') { line++; lineStart = p + 1; p++; continue; }
      if (isWs(ch)) { p++; continue; }
      if (ch === '>') { p++; closed = true; break; }
      if (ch === '/' && p + 1 < n && content[p + 1] === '>') { selfClosing = true; p += 2; closed = true; break; }
      const an = p;
      while (p < n && !isWs(content[p]) && content[p] !== '=' && content[p] !== '>' && content[p] !== '/') p++;
      if (p === an) { p++; continue; }
      const attrName = content.substring(an, p).toLowerCase();
      let q = p;
      while (q < n && isWs(content[q]) && content[q] !== '\n') q++;
      if (q < n && content[q] === '=') {
        q++;
        while (q < n && isWs(content[q]) && content[q] !== '\n') q++;
        if (q >= n) { p = q; break; }
        const vc = content[q];
        let value: string;
        if (vc === '"' || vc === "'") {
          const end = content.indexOf(vc, q + 1);
          if (end < 0) { advance(n); return out; }
          value = content.substring(q + 1, end);
          for (let k = q + 1; k < end; k++) if (content[k] === '\n') { line++; lineStart = k + 1; }
          p = end + 1;
        } else if (vc === '{') {
          let depth = 1;
          let k = q + 1;
          while (k < n && depth > 0) {
            const kc = content[k];
            if (kc === '\n') { line++; lineStart = k + 1; } else if (kc === '{') depth++; else if (kc === '}') depth--;
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
        attrs.set(attrName, null);
        p = q;
      }
    }

    if (!closed) { advance(n); break; }

    const kind: TagKind = isClose ? 'CLOSE' : selfClosing ? 'SELF_CLOSING' : 'OPEN';
    out.push({ name, attributes: attrs, kind, line: startLine, column: startCol });
    i = p;

    if (kind === 'OPEN') {
      const lname = name.toLowerCase();
      if (lname === 'script' || lname === 'style') {
        const endIdx = indexOfIgnoreCase(content, '</' + lname, i);
        if (endIdx >= 0) advance(endIdx);
        else { advance(n); break; }
      }
    }
  }
  return out;
}
