/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

/** Severity shared by every auditor. */
export type IssueSeverity = 'ERROR' | 'WARNING' | 'INFO';

/**
 * Stable rule descriptor.
 *
 * `id` is the machine identifier (`link-empty`) used as diagnostic code and
 * SARIF rule id; `wcag` names the success criteria (`WCAG 2.4.4`).
 */
export interface AuditRule {
  readonly id: string;
  readonly title: string;
  readonly wcag: string;
  readonly helpUri: string;
}

/** One finding produced by a tokenizer-based auditor (line 1-based, column 0-based). */
export interface MarkupIssue {
  readonly rule: AuditRule;
  readonly severity: IssueSeverity;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly suggestion: string;
}

/**
 * Result of one auditor over one file. `checked` units were evaluated;
 * `passed` of them produced no ERROR / WARNING.
 */
export interface MarkupAuditReport {
  readonly filePath: string;
  readonly checked: number;
  readonly passed: number;
  readonly issues: readonly MarkupIssue[];
}

/** Builds a report where every distinct failing unit counts as not passed. */
export function reportOf(
  filePath: string,
  checked: number,
  failedUnits: number,
  issues: readonly MarkupIssue[],
): MarkupAuditReport {
  return { filePath, checked, passed: Math.max(0, checked - failedUnits), issues };
}

export function emptyReport(filePath: string): MarkupAuditReport {
  return { filePath, checked: 0, passed: 0, issues: [] };
}
