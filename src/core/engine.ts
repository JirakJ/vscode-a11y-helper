/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

import { auditAltText } from './altText';
import { scanContrast } from './contrast';
import { auditDocument } from './document';
import { auditFocusCss, auditFocusMarkup } from './focus';
import { auditHeadings } from './headings';
import { auditLabels } from './labels';
import { analyzeLandmarks } from './landmarks';
import { auditLinks } from './links';
import { parseMarkup, isFullDocument, type MarkupDocument } from './markup';
import { type MarkupAuditReport, emptyReport } from './markupAudit';
import { auditMedia } from './media';
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  type CategoryCounters,
  type CategoryStat,
  gradeFor,
  newCounters,
  passRate,
  type ProjectAuditResult,
  type UnifiedFinding,
} from './types';

/** Rule id of the INFO finding emitted when an auditor could not process a file. */
export const PARSE_FAILURE_RULE = 'audit-analysis-incomplete';

export const HTML_LIKE_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml', 'vue', 'svelte', 'razor', 'cshtml']);
export const JSX_EXTENSIONS: ReadonlySet<string> = new Set(['jsx', 'tsx']);
export const CSS_EXTENSIONS: ReadonlySet<string> = new Set(['css', 'scss', 'sass', 'less']);
export const AUDITABLE_EXTENSIONS: readonly string[] = [...HTML_LIKE_EXTENSIONS, ...JSX_EXTENSIONS, ...CSS_EXTENSIONS];

/** Directories never descended into during a workspace audit. */
export const SKIPPED_DIRECTORIES: readonly string[] = [
  '.git', '.svn', '.hg', 'node_modules', 'bower_components', 'vendor',
  'build', 'dist', 'out', 'target', 'coverage', '.gradle', '.idea',
  '.next', '.nuxt', '.output', '.svelte-kit', '__pycache__', '.venv',
];

const HELP = {
  contrast: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
  labels: 'https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html',
  landmarks: 'https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/',
  headings: 'https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html',
  altText: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html',
};

/** Lower-case extension of a path (`''` when none). */
export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
}

export function isAuditablePath(path: string): boolean {
  return AUDITABLE_EXTENSIONS.includes(extensionOf(path));
}

/** `true` when any directory segment of the (relative) path is a skipped directory. */
export function isInSkippedDirectory(relativePath: string): boolean {
  const segments = relativePath.replace(/\\/g, '/').split('/');
  segments.pop();
  return segments.some((s) => SKIPPED_DIRECTORIES.includes(s));
}

export interface AuditOptions {
  /** Categories to run; all when omitted. */
  readonly categories?: ReadonlySet<AuditCategory>;
}

export interface FileAuditResult {
  readonly findings: UnifiedFinding[];
  readonly counters: Record<AuditCategory, CategoryCounters>;
}

function newCounterMap(): Record<AuditCategory, CategoryCounters> {
  const out = {} as Record<AuditCategory, CategoryCounters>;
  for (const c of AUDIT_CATEGORIES) out[c] = newCounters();
  return out;
}

function parseFailure(relative: string, component: string): UnifiedFinding {
  return {
    category: 'DOCUMENT',
    ruleId: PARSE_FAILURE_RULE,
    ruleName: 'Analysis incomplete',
    severity: 'INFO',
    filePath: relative,
    line: 1,
    column: 0,
    message: `The ${component} could not process this file; its checks were skipped here.`,
    suggestion: 'The file may be malformed or use syntax the analyzer does not understand. Please report it with a sample.',
  };
}

/**
 * Audits one file's content with every enabled auditor. The file type is
 * derived from the extension of `relativePath`; unknown types yield nothing.
 * One pathological file can never throw: a failing auditor contributes an
 * INFO `audit-analysis-incomplete` finding instead.
 */
export function auditFile(content: string, relativePath: string, options: AuditOptions = {}): FileAuditResult {
  const enabled = (c: AuditCategory): boolean => !options.categories || options.categories.has(c);
  const findings: UnifiedFinding[] = [];
  const counters = newCounterMap();
  const ext = extensionOf(relativePath);
  const isCss = CSS_EXTENSIONS.has(ext);
  const isHtmlLike = HTML_LIKE_EXTENSIONS.has(ext);
  const isJsx = JSX_EXTENSIONS.has(ext);

  const safely = (component: string, block: () => void): void => {
    try {
      block();
    } catch {
      findings.push(parseFailure(relativePath, component));
      counters.DOCUMENT.infos++;
    }
  };

  if ((isCss || isHtmlLike) && enabled('CONTRAST')) {
    safely('Color Contrast scanner', () => auditContrast(content, relativePath, findings, counters.CONTRAST));
  }
  if (isCss && enabled('FOCUS')) {
    safely('Keyboard & Focus auditor', () => record(auditFocusCss(content, relativePath), 'FOCUS', relativePath, findings, counters.FOCUS));
  }
  if (isHtmlLike || isJsx) {
    if (enabled('LABELS')) safely('Screen Reader Labels auditor', () => auditLabelsInto(content, relativePath, findings, counters.LABELS));
    if (enabled('HEADINGS')) safely('Heading Structure auditor', () => auditHeadingsInto(content, relativePath, findings, counters.HEADINGS));
    if (enabled('ALT_TEXT')) safely('Alt Text Quality auditor', () => auditAltTextInto(content, relativePath, findings, counters.ALT_TEXT));
    if (enabled('LANDMARKS') && isFullDocument(content)) {
      safely('ARIA Landmarks analyzer', () => auditLandmarksInto(content, relativePath, findings, counters.LANDMARKS));
    }
    const needsDoc = enabled('LINKS') || enabled('MEDIA') || enabled('DOCUMENT') || enabled('FOCUS');
    if (needsDoc) {
      let doc: MarkupDocument | null = null;
      try {
        doc = parseMarkup(content);
      } catch {
        findings.push(parseFailure(relativePath, 'markup tokenizer'));
        counters.DOCUMENT.infos++;
      }
      if (doc) {
        const d = doc;
        const run = (cat: AuditCategory, name: string, fn: () => MarkupAuditReport): void => {
          if (!enabled(cat)) return;
          let report: MarkupAuditReport;
          try {
            report = fn();
          } catch {
            findings.push(parseFailure(relativePath, name));
            counters.DOCUMENT.infos++;
            report = emptyReport(relativePath);
          }
          record(report, cat, relativePath, findings, counters[cat]);
        };
        run('LINKS', 'Link Purpose', () => auditLinks(d, relativePath));
        run('MEDIA', 'Media & Embeds', () => auditMedia(d, relativePath));
        run('DOCUMENT', 'Page Metadata', () => auditDocument(d, relativePath));
        run('FOCUS', 'Keyboard & Focus', () => auditFocusMarkup(d, relativePath));
      }
    }
  }
  return { findings, counters };
}

function record(report: MarkupAuditReport, category: AuditCategory, relative: string, findings: UnifiedFinding[], c: CategoryCounters): void {
  c.checked += report.checked;
  c.passed += report.passed;
  for (const issue of report.issues) {
    if (issue.severity === 'ERROR') c.errors++;
    else if (issue.severity === 'WARNING') c.warnings++;
    else c.infos++;
    findings.push({
      category,
      ruleId: issue.rule.id,
      ruleName: `${issue.rule.title} (${issue.rule.wcag})`,
      severity: issue.severity,
      filePath: relative,
      line: issue.line,
      column: issue.column,
      message: issue.message,
      suggestion: issue.suggestion,
      helpUri: issue.rule.helpUri,
    });
  }
}

function auditContrast(content: string, relative: string, findings: UnifiedFinding[], c: CategoryCounters): void {
  for (const f of scanContrast(content, relative)) {
    c.checked++;
    if (f.passesAA) { c.passed++; continue; }
    if (f.wcagLevel !== 'FAIL') continue;
    c.errors++;
    const text = f.issueType === 'TEXT_CONTRAST';
    findings.push({
      category: 'CONTRAST',
      ruleId: text ? 'contrast-text' : 'contrast-non-text',
      ruleName: text ? 'Text contrast below WCAG AA' : 'Non-text contrast below WCAG 1.4.11',
      severity: 'ERROR',
      filePath: relative,
      line: f.line,
      column: 0,
      message: `Contrast ratio ${f.ratio.toFixed(2)}:1 for \`${f.selector}\` (fg ${f.foreground} on bg ${f.background}) fails WCAG AA.`,
      suggestion: `Adjust colors to reach at least ${f.largeText ? '3.0' : '4.5'}:1.`,
      helpUri: HELP.contrast,
    });
  }
}

function auditLabelsInto(content: string, relative: string, findings: UnifiedFinding[], c: CategoryCounters): void {
  const report = auditLabels(content, relative);
  c.checked += report.total;
  c.passed += report.labeled;
  for (const issue of report.issues) {
    const isWarning = issue.source === 'PLACEHOLDER_ATTR';
    if (isWarning) c.warnings++; else c.errors++;
    findings.push({
      category: 'LABELS',
      ruleId: isWarning ? 'label-placeholder-only' : 'label-missing',
      ruleName: isWarning ? 'Accessible name relies on placeholder' : 'Interactive element without accessible name',
      severity: isWarning ? 'WARNING' : 'ERROR',
      filePath: relative,
      line: issue.line,
      column: issue.column,
      message: issue.missingReason,
      suggestion: issue.suggestion,
      helpUri: HELP.labels,
    });
  }
}

function auditLandmarksInto(content: string, relative: string, findings: UnifiedFinding[], c: CategoryCounters): void {
  const report = analyzeLandmarks(content, relative);
  c.checked++;
  if (!report.issues.some((i) => i.severity === 'ERROR')) c.passed++;
  for (const issue of report.issues) {
    if (issue.severity === 'ERROR') c.errors++; else c.warnings++;
    findings.push({
      category: 'LANDMARKS',
      ruleId: `landmark-${issue.roleName}`,
      ruleName: `ARIA landmark: ${issue.roleName}`,
      severity: issue.severity,
      filePath: relative,
      line: 1,
      column: 0,
      message: issue.message,
      helpUri: HELP.landmarks,
    });
  }
}

function auditHeadingsInto(content: string, relative: string, findings: UnifiedFinding[], c: CategoryCounters): void {
  const report = auditHeadings(content, relative);
  if (report.headings.length === 0 && !report.fullDocument) return;
  const checks = report.headings.length + 1; // +1 for the document-level outline check
  c.checked += checks;
  const failing = report.issues.filter((i) => i.severity !== 'INFO').length;
  c.passed += Math.max(0, checks - failing);
  for (const issue of report.issues) {
    if (issue.severity === 'ERROR') c.errors++;
    else if (issue.severity === 'WARNING') c.warnings++;
    else c.infos++;
    findings.push({
      category: 'HEADINGS',
      ruleId: issue.rule.id,
      ruleName: `Heading structure (${issue.rule.wcag})`,
      severity: issue.severity,
      filePath: relative,
      line: issue.line,
      column: issue.column,
      message: issue.message,
      suggestion: issue.suggestion,
      helpUri: HELP.headings,
    });
  }
}

function auditAltTextInto(content: string, relative: string, findings: UnifiedFinding[], c: CategoryCounters): void {
  const report = auditAltText(content, relative);
  c.checked += report.total;
  const failing = new Set<unknown>();
  for (const issue of report.issues) if (issue.severity !== 'INFO') failing.add(issue.element);
  c.passed += Math.max(0, report.total - failing.size);
  for (const issue of report.issues) {
    if (issue.severity === 'ERROR') c.errors++;
    else if (issue.severity === 'WARNING') c.warnings++;
    else c.infos++;
    findings.push({
      category: 'ALT_TEXT',
      ruleId: issue.rule.id,
      ruleName: `Alt text quality (${issue.rule.wcag})`,
      severity: issue.severity,
      filePath: relative,
      line: issue.line,
      column: issue.column,
      message: issue.message,
      suggestion: issue.suggestion,
      helpUri: HELP.altText,
    });
  }
}

/** Folds per-file results into one {@link ProjectAuditResult}. */
export class AuditAccumulator {
  private readonly findings: UnifiedFinding[] = [];
  private readonly counters = newCounterMap();
  private files = 0;

  add(result: FileAuditResult): void {
    this.files++;
    this.findings.push(...result.findings);
    for (const cat of AUDIT_CATEGORIES) {
      const src = result.counters[cat];
      const dst = this.counters[cat];
      dst.checked += src.checked;
      dst.passed += src.passed;
      dst.errors += src.errors;
      dst.warnings += src.warnings;
      dst.infos += src.infos;
    }
  }

  result(rootLabel: string, generatedAt: string): ProjectAuditResult {
    const stats: CategoryStat[] = AUDIT_CATEGORIES.map((category) => {
      const c = this.counters[category];
      return { category, ...c, passRate: passRate(c) };
    });
    const score = healthScore(stats);
    const count = (s: string): number => this.findings.filter((f) => f.severity === s).length;
    return {
      rootLabel,
      filesScanned: this.files,
      findings: [...this.findings],
      categoryStats: stats,
      healthScore: score,
      grade: gradeFor(score),
      generatedAt,
      errorCount: count('ERROR'),
      warningCount: count('WARNING'),
      infoCount: count('INFO'),
    };
  }
}

/** Rounded mean of the pass rates of every category that had something to check (100 when nothing was checked). */
export function healthScore(stats: readonly CategoryStat[]): number {
  const active = stats.filter((s) => s.checked > 0);
  if (active.length === 0) return 100;
  const mean = active.reduce((sum, s) => sum + s.passRate, 0) / active.length;
  return Math.min(100, Math.max(0, Math.round(mean * 100)));
}

/** Convenience: audits a set of in-memory files (path → content) into a full result. */
export function auditFiles(
  files: Iterable<readonly [string, string]>,
  rootLabel: string,
  generatedAt: string,
  options: AuditOptions = {},
): ProjectAuditResult {
  const acc = new AuditAccumulator();
  for (const [path, content] of files) {
    if (!isAuditablePath(path) || isInSkippedDirectory(path)) continue;
    acc.add(auditFile(content, path, options));
  }
  return acc.result(rootLabel, generatedAt);
}

/** `yyyy-MM-dd HH:mm` in local time. */
export function formatTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
