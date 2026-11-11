/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CATEGORY_DISPLAY_NAMES,
  type AuditSeverity,
  type ProjectAuditResult,
  SEVERITY_ORDER,
  type UnifiedFinding,
} from './types';

export const TOOL_NAME = 'Accessibility Compliance Helper';
export const TOOL_INFORMATION_URI = 'https://github.com/JirakJ/vscode-a11y-helper';

function sortedBySeverity(findings: readonly UnifiedFinding[]): UnifiedFinding[] {
  // Array.prototype.sort is stable, so source order is kept within a severity.
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function percentOneDecimal(rate: number): string {
  return `${(Math.round(rate * 1000) / 10).toFixed(1)}%`;
}

function escapeTable(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r/g, ' ').replace(/\n/g, ' ');
}

/** Markdown rendering (PR / ticket friendly). */
export function renderMarkdown(result: ProjectAuditResult): string {
  const out: string[] = [];
  out.push('# Accessibility Project Audit\n\n');
  out.push('**Root:** `', result.rootLabel.replace(/`/g, '\\`'), '`  \n');
  out.push('**Generated:** ', result.generatedAt, '  \n');
  out.push('**Files scanned:** ', String(result.filesScanned), '\n\n');
  out.push('## Health score: ', String(result.healthScore), '/100 (grade ', result.grade, ')\n\n');
  out.push('Errors: **', String(result.errorCount), '** · Warnings: **', String(result.warningCount),
    '** · Info: **', String(result.infoCount), '**\n\n');

  out.push('## Categories\n\n');
  out.push('| Category | Checked | Passed | Pass rate | Errors | Warnings | Info |\n');
  out.push('|---|---|---|---|---|---|---|\n');
  for (const s of result.categoryStats) {
    const rate = s.checked === 0 ? '—' : percentOneDecimal(s.passRate);
    out.push(`| ${CATEGORY_DISPLAY_NAMES[s.category]} | ${s.checked} | ${s.passed} | ${rate} | ${s.errors} | ${s.warnings} | ${s.infos} |\n`);
  }
  out.push('\n## Findings\n\n');
  if (result.findings.length === 0) {
    out.push('_No findings — congratulations!_\n');
  } else {
    out.push('| Severity | Category | Rule | Location | Message |\n');
    out.push('|---|---|---|---|---|\n');
    for (const f of sortedBySeverity(result.findings)) {
      out.push(`| ${f.severity} | ${CATEGORY_DISPLAY_NAMES[f.category]} | ${f.ruleId} | ${escapeTable(`${f.filePath}:${f.line}:${f.column}`)} | ${escapeTable(f.message)} |\n`);
    }
  }
  return out.join('');
}

/** Stable JSON rendering. */
export function renderJson(result: ProjectAuditResult): string {
  const payload = {
    root: result.rootLabel,
    generatedAt: result.generatedAt,
    filesScanned: result.filesScanned,
    healthScore: result.healthScore,
    grade: result.grade,
    errors: result.errorCount,
    warnings: result.warningCount,
    infos: result.infoCount,
    categories: result.categoryStats.map((s) => ({
      category: s.category,
      displayName: CATEGORY_DISPLAY_NAMES[s.category],
      checked: s.checked,
      passed: s.passed,
      passRate: Math.round(s.passRate * 1000) / 1000,
      errors: s.errors,
      warnings: s.warnings,
      infos: s.infos,
    })),
    findings: result.findings.map((f) => ({
      category: f.category,
      ruleId: f.ruleId,
      severity: f.severity,
      filePath: f.filePath,
      line: f.line,
      column: f.column,
      message: f.message,
      suggestion: f.suggestion ?? null,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function scoreColor(score: number): string {
  if (score >= 90) return '#1a7f37';
  if (score >= 70) return '#9a6700';
  return '#cf222e';
}

/** Self-contained HTML report (inline CSS, no external assets) with a score ring, category cards and findings table. */
export interface HtmlRenderOptions {
  /** Webview mode: adds a CSP and makes finding locations clickable (posts `{ type: 'open', file, line, column }`). */
  readonly webview?: { readonly nonce: string; readonly cspSource: string };
}

export function renderHtml(result: ProjectAuditResult, options: HtmlRenderOptions = {}): string {
  const wv = options.webview;
  const ringColor = scoreColor(result.healthScore);
  const circumference = 2 * Math.PI * 52;
  const dash = (circumference * result.healthScore) / 100;
  const out: string[] = [];
  out.push(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${wv ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${wv.cspSource}; script-src 'nonce-${wv.nonce}';">` : ''}
<title>Accessibility Project Audit — ${escapeHtml(result.rootLabel)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; background: #f6f8fa; color: #1f2328; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
  header { display: flex; align-items: center; gap: 32px; background: #fff; border: 1px solid #d1d9e0; border-radius: 12px; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .meta { color: #59636e; font-size: 13px; }
  .ring { position: relative; width: 120px; height: 120px; flex: none; }
  .ring svg { transform: rotate(-90deg); }
  .ring .value { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .ring .value b { font-size: 28px; }
  .ring .value span { font-size: 12px; color: #59636e; }
  .grade { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 700; background: ${ringColor}; color: #fff; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin: 20px 0; }
  .card { background: #fff; border: 1px solid #d1d9e0; border-radius: 10px; padding: 14px 16px; }
  .card h3 { margin: 0 0 8px; font-size: 13px; color: #59636e; font-weight: 600; }
  .card .big { font-size: 20px; font-weight: 700; }
  .bar { height: 6px; background: #eaeef2; border-radius: 3px; margin-top: 10px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #1a7f37; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d1d9e0; border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eaeef2; vertical-align: top; }
  th { background: #f6f8fa; font-weight: 600; }
  .sev { font-weight: 700; padding: 1px 8px; border-radius: 999px; font-size: 11px; white-space: nowrap; }
  .sev.ERROR { background: #ffebe9; color: #cf222e; }
  .sev.WARNING { background: #fff8c5; color: #9a6700; }
  .sev.INFO { background: #ddf4ff; color: #0969da; }
  .loc { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #59636e; }
  button.loc { background: none; border: 0; padding: 0; cursor: pointer; text-align: left; color: #0969da; text-decoration: underline; }
  footer { margin-top: 28px; color: #59636e; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="ring" role="img" aria-label="Health score ${result.healthScore} out of 100">
    <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" r="52" fill="none" stroke="#eaeef2" stroke-width="12"/>
      <circle cx="60" cy="60" r="52" fill="none" stroke="${ringColor}" stroke-width="12" stroke-linecap="round"
              stroke-dasharray="${dash.toFixed(2)} ${circumference.toFixed(2)}"/>
    </svg>
    <div class="value"><b>${result.healthScore}</b><span>/ 100</span></div>
  </div>
  <div>
    <h1>Accessibility Project Audit <span class="grade">Grade ${result.grade}</span></h1>
    <div class="meta">Root: ${escapeHtml(result.rootLabel)}</div>
    <div class="meta">Generated: ${escapeHtml(result.generatedAt)} · Files scanned: ${result.filesScanned}
      · Errors: ${result.errorCount} · Warnings: ${result.warningCount} · Info: ${result.infoCount}</div>
  </div>
</header>
`);
  out.push('<div class="cards">\n');
  for (const s of result.categoryStats) {
    out.push(`<div class="card"><h3>${escapeHtml(CATEGORY_DISPLAY_NAMES[s.category])}</h3>`);
    if (s.checked === 0) {
      out.push('<div class="big">—</div><div class="meta">nothing to check</div>');
    } else {
      const pct = Math.round(s.passRate * 100);
      out.push(`<div class="big">${pct}%</div><div class="meta">${s.passed}/${s.checked} passed · ${s.errors} err · ${s.warnings} warn</div>`);
      out.push(`<div class="bar"><i style="width:${pct}%"></i></div>`);
    }
    out.push('</div>\n');
  }
  out.push('</div>\n');
  out.push(`<h2>Findings (${result.findings.length})</h2>\n`);
  out.push('<table>\n<thead><tr><th>Severity</th><th>Category</th><th>Rule</th><th>Location</th><th>Message</th><th>Suggestion</th></tr></thead>\n<tbody>\n');
  if (result.findings.length === 0) {
    out.push('<tr><td colspan="6">No findings — congratulations!</td></tr>\n');
  } else {
    for (const f of sortedBySeverity(result.findings)) {
      out.push('<tr>',
        `<td><span class="sev ${f.severity}">${f.severity}</span></td>`,
        `<td>${escapeHtml(CATEGORY_DISPLAY_NAMES[f.category])}</td>`,
        `<td>${escapeHtml(f.ruleId)}</td>`,
        wv
          ? `<td><button type="button" class="loc" data-file="${escapeHtml(f.filePath)}" data-line="${f.line}" data-column="${f.column}">${escapeHtml(`${f.filePath}:${f.line}:${f.column}`)}</button></td>`
          : `<td class="loc">${escapeHtml(`${f.filePath}:${f.line}:${f.column}`)}</td>`,
        `<td>${escapeHtml(f.message)}</td>`,
        `<td>${escapeHtml(f.suggestion ?? '')}</td>`,
        '</tr>\n');
    }
  }
  out.push('</tbody>\n</table>\n');
  out.push(`<footer>Generated by ${TOOL_NAME} — workspace accessibility audit.</footer>\n`);
  if (wv) {
    out.push(`<script nonce="${wv.nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('button.loc') : null;
  if (!b) return;
  vscode.postMessage({ type: 'open', file: b.dataset.file, line: Number(b.dataset.line), column: Number(b.dataset.column) });
});
</script>\n`);
  }
  out.push('</div>\n</body>\n</html>\n');
  return out.join('');
}

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const DEFAULT_HELP_URI = 'https://www.w3.org/WAI/WCAG22/quickref/';

export function sarifLevel(severity: AuditSeverity): 'error' | 'warning' | 'note' {
  if (severity === 'ERROR') return 'error';
  if (severity === 'WARNING') return 'warning';
  return 'note';
}

/** Relativizes `path` against `baseDir` when it is a prefix and returns a forward-slash, repository-relative URI. */
export function normalizeSarifUri(path: string, baseDir?: string): string {
  let p = path.replace(/\\/g, '/');
  if (baseDir !== undefined) {
    const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (base.length > 0 && p.startsWith(base)) p = p.substring(base.length);
  }
  return p.replace(/^\/+/, '');
}

/** SARIF 2.1.0 log for GitHub Code Scanning / Azure DevOps / SARIF viewers. */
export function renderSarif(findings: readonly UnifiedFinding[], toolVersion: string, baseDir?: string): string {
  const rules = new Map<string, Record<string, unknown>>();
  for (const f of findings) {
    if (!rules.has(f.ruleId)) {
      rules.set(f.ruleId, {
        id: f.ruleId,
        name: f.ruleName,
        shortDescription: { text: f.ruleName },
        helpUri: f.helpUri ?? DEFAULT_HELP_URI,
        properties: { category: CATEGORY_DISPLAY_NAMES[f.category] },
      });
    }
  }
  const ruleIndex = new Map<string, number>();
  [...rules.keys()].forEach((id, i) => ruleIndex.set(id, i));
  const results = findings.map((f) => ({
    ruleId: f.ruleId,
    ruleIndex: ruleIndex.get(f.ruleId) ?? 0,
    level: sarifLevel(f.severity),
    message: { text: f.suggestion && f.suggestion.trim() ? `${f.message} ${f.suggestion}` : f.message },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: normalizeSarifUri(f.filePath, baseDir) },
        region: { startLine: Math.max(1, f.line), startColumn: Math.max(0, f.column) + 1 },
      },
    }],
  }));
  const log = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: TOOL_NAME, version: toolVersion, informationUri: TOOL_INFORMATION_URI, rules: [...rules.values()] } },
      results,
    }],
  };
  return JSON.stringify(log, null, 2);
}
