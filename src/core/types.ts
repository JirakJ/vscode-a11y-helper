/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/** Audit category a finding belongs to (order = report order). */
export type AuditCategory =
  | 'CONTRAST'
  | 'LABELS'
  | 'LANDMARKS'
  | 'HEADINGS'
  | 'ALT_TEXT'
  | 'LINKS'
  | 'MEDIA'
  | 'DOCUMENT'
  | 'FOCUS';

export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  'CONTRAST', 'LABELS', 'LANDMARKS', 'HEADINGS', 'ALT_TEXT', 'LINKS', 'MEDIA', 'DOCUMENT', 'FOCUS',
];

export const CATEGORY_DISPLAY_NAMES: Readonly<Record<AuditCategory, string>> = {
  CONTRAST: 'Color Contrast',
  LABELS: 'Screen Reader Labels',
  LANDMARKS: 'ARIA Landmarks',
  HEADINGS: 'Heading Structure',
  ALT_TEXT: 'Alt Text Quality',
  LINKS: 'Link Purpose',
  MEDIA: 'Media & Embeds',
  DOCUMENT: 'Page Metadata',
  FOCUS: 'Keyboard & Focus',
};

/** Settings key (`a11yHelper.rules.<key>`) per category. */
export const CATEGORY_SETTING_KEYS: Readonly<Record<AuditCategory, string>> = {
  CONTRAST: 'contrast',
  LABELS: 'labels',
  LANDMARKS: 'landmarks',
  HEADINGS: 'headings',
  ALT_TEXT: 'altText',
  LINKS: 'links',
  MEDIA: 'media',
  DOCUMENT: 'document',
  FOCUS: 'focus',
};

export type AuditSeverity = 'ERROR' | 'WARNING' | 'INFO';

export const SEVERITY_ORDER: Readonly<Record<AuditSeverity, number>> = { ERROR: 0, WARNING: 1, INFO: 2 };

/**
 * Category-agnostic finding. `line` is 1-based, `column` 0-based.
 * `ruleId` is stable (`alt-filename`, `contrast-text`) and doubles as the
 * diagnostic code and SARIF rule id.
 */
export interface UnifiedFinding {
  readonly category: AuditCategory;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: AuditSeverity;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly suggestion?: string;
  readonly helpUri?: string;
}

/** Mutable per-category counters. */
export interface CategoryCounters {
  checked: number;
  passed: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface CategoryStat extends Readonly<CategoryCounters> {
  readonly category: AuditCategory;
  /** `0..1`; categories with nothing to check score 1. */
  readonly passRate: number;
}

export interface ProjectAuditResult {
  readonly rootLabel: string;
  readonly filesScanned: number;
  readonly findings: readonly UnifiedFinding[];
  readonly categoryStats: readonly CategoryStat[];
  /** Rounded mean of the pass rates of every category that had something to check. */
  readonly healthScore: number;
  readonly grade: string;
  readonly generatedAt: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
}

export function newCounters(): CategoryCounters {
  return { checked: 0, passed: 0, errors: 0, warnings: 0, infos: 0 };
}

export function passRate(c: CategoryCounters): number {
  return c.checked <= 0 ? 1 : c.passed / c.checked;
}

/** `A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60`. */
export function gradeFor(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
