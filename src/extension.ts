/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import {
  AuditAccumulator,
  AUDITABLE_EXTENSIONS,
  auditFile,
  extensionOf,
  formatTimestamp,
  isAuditablePath,
  isInSkippedDirectory,
  SKIPPED_DIRECTORIES,
} from './core/engine';
import { offsetAt, quickFixesFor, tagRangeAt } from './core/quickFixes';
import { renderHtml, renderJson, renderMarkdown, renderSarif } from './core/reports';
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  CATEGORY_SETTING_KEYS,
  type ProjectAuditResult,
  type UnifiedFinding,
} from './core/types';

const SECTION = 'a11yHelper';
const SOURCE = 'a11y';

/** Language id → virtual extension for untitled / unusually named documents. */
const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  html: 'html',
  javascriptreact: 'jsx',
  typescriptreact: 'tsx',
  vue: 'vue',
  svelte: 'svelte',
  razor: 'cshtml',
  aspnetcorerazor: 'cshtml',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
};

interface Settings {
  enable: boolean;
  run: 'onType' | 'onSave';
  showAdvisory: boolean;
  categories: Set<AuditCategory>;
  exclude: string[];
  maxFileBytes: number;
}

function readSettings(scope?: vscode.ConfigurationScope): Settings {
  const cfg = vscode.workspace.getConfiguration(SECTION, scope);
  const categories = new Set<AuditCategory>();
  for (const c of AUDIT_CATEGORIES) {
    if (cfg.get<boolean>(`rules.${CATEGORY_SETTING_KEYS[c]}`, true)) categories.add(c);
  }
  return {
    enable: cfg.get<boolean>('enable', true),
    run: cfg.get<'onType' | 'onSave'>('run', 'onType'),
    showAdvisory: cfg.get<boolean>('showAdvisory', true),
    categories,
    exclude: cfg.get<string[]>('audit.exclude', []),
    maxFileBytes: Math.max(1, cfg.get<number>('audit.maxFileSizeKB', 2000)) * 1024,
  };
}

/** Path whose extension decides the analysis — the file name, or a virtual one derived from the language id. */
function analysisPath(doc: vscode.TextDocument): string | null {
  const name = doc.uri.path;
  if (isAuditablePath(name)) return name;
  const ext = LANGUAGE_EXTENSIONS[doc.languageId];
  return ext ? `${name || 'untitled'}.${ext}` : null;
}

function toSeverity(s: UnifiedFinding['severity']): vscode.DiagnosticSeverity {
  if (s === 'ERROR') return vscode.DiagnosticSeverity.Error;
  if (s === 'WARNING') return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}

class A11yDiagnostic extends vscode.Diagnostic {
  constructor(range: vscode.Range, readonly finding: UnifiedFinding) {
    super(range, finding.suggestion ? `${finding.message}\n${finding.suggestion}` : finding.message, toSeverity(finding.severity));
    this.source = SOURCE;
    this.code = finding.helpUri
      ? { value: finding.ruleId, target: vscode.Uri.parse(finding.helpUri) }
      : finding.ruleId;
  }
}

function toDiagnostics(text: string, findings: readonly UnifiedFinding[], showAdvisory: boolean): vscode.Diagnostic[] {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const pos = (offset: number): vscode.Position => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    return new vscode.Position(lo, offset - lineStarts[lo]!);
  };
  const out: vscode.Diagnostic[] = [];
  for (const f of findings) {
    if (!showAdvisory && f.severity === 'INFO') continue;
    let offset = offsetAt(text, Math.max(1, f.line), Math.max(0, f.column));
    if (offset < 0) offset = 0;
    const [start, end] = tagRangeAt(text, offset);
    out.push(new A11yDiagnostic(new vscode.Range(pos(start), pos(end)), f));
  }
  return out;
}

class DiagnosticsController implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection(SOURCE);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  refresh(doc: vscode.TextDocument): void {
    const settings = readSettings(doc.uri);
    const path = analysisPath(doc);
    if (!settings.enable || !path || doc.uri.scheme === 'output' || doc.uri.scheme === 'vscode-scm') {
      this.collection.delete(doc.uri);
      return;
    }
    const text = doc.getText();
    if (text.length > settings.maxFileBytes) {
      this.collection.delete(doc.uri);
      return;
    }
    const result = auditFile(text, path, { categories: settings.categories });
    this.collection.set(doc.uri, toDiagnostics(text, result.findings, settings.showAdvisory));
  }

  schedule(doc: vscode.TextDocument, delayMs = 400): void {
    const key = doc.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.refresh(doc);
    }, delayMs));
  }

  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) this.refresh(doc);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.collection.dispose();
  }
}

class QuickFixProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const text = doc.getText();
    for (const d of context.diagnostics) {
      if (!(d instanceof A11yDiagnostic)) continue;
      const f = d.finding;
      for (const fix of quickFixesFor(f.ruleId, text, f.line, f.column)) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [d];
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(doc.uri, new vscode.Range(doc.positionAt(fix.edit.start), doc.positionAt(fix.edit.end)), fix.edit.text);
        action.isPreferred = true;
        actions.push(action);
      }
    }
    return actions;
  }
}

interface AuditRun {
  readonly result: ProjectAuditResult;
  /** Relative label → URI, for opening findings. */
  readonly uris: Map<string, vscode.Uri>;
}

function excludeGlob(extra: readonly string[]): string {
  const patterns = [...SKIPPED_DIRECTORIES.map((d) => `**/${d}/**`), ...extra];
  return `{${patterns.join(',')}}`;
}

async function runWorkspaceAudit(diagnostics: DiagnosticsController): Promise<AuditRun | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showWarningMessage('Open a folder or workspace to run the accessibility audit.');
    return undefined;
  }
  const settings = readSettings();
  const include = `**/*.{${AUDITABLE_EXTENSIONS.join(',')}}`;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Accessibility audit', cancellable: true },
    async (progress, token) => {
      const files = await vscode.workspace.findFiles(include, excludeGlob(settings.exclude), undefined, token);
      files.sort((a, b) => a.toString().localeCompare(b.toString()));
      const acc = new AuditAccumulator();
      const uris = new Map<string, vscode.Uri>();
      const decoder = new TextDecoder('utf-8');
      const openDocs = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
      let index = 0;
      for (const uri of files) {
        if (token.isCancellationRequested) break;
        index++;
        const relative = vscode.workspace.asRelativePath(uri, folders.length > 1);
        if (isInSkippedDirectory(relative)) continue;
        progress.report({ message: `${index}/${files.length} ${relative}`, increment: 100 / Math.max(1, files.length) });
        let content: string;
        try {
          const open = openDocs.get(uri.toString());
          if (open) {
            content = open.getText();
          } else {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > settings.maxFileBytes) continue;
            content = decoder.decode(await vscode.workspace.fs.readFile(uri));
          }
        } catch {
          continue;
        }
        if (content.length > settings.maxFileBytes) continue;
        const fileResult = auditFile(content, relative, { categories: settings.categories });
        acc.add(fileResult);
        uris.set(relative, uri);
        // Mirror the audit into the Problems panel.
        if (settings.enable) {
          diagnostics.collection.set(uri, toDiagnostics(content, fileResult.findings, settings.showAdvisory));
        }
      }
      const rootLabel = folders.length === 1 ? folders[0]!.name : folders.map((f) => f.name).join(', ');
      return { result: acc.result(rootLabel, formatTimestamp(new Date())), uris };
    },
  );
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

class ReportPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static uris = new Map<string, vscode.Uri>();

  static show(run: AuditRun, title: string): void {
    ReportPanel.uris = run.uris;
    if (!ReportPanel.panel) {
      const panel = vscode.window.createWebviewPanel('a11yHelper.report', title, vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [],
      });
      panel.onDidDispose(() => { ReportPanel.panel = undefined; });
      panel.webview.onDidReceiveMessage(async (msg: { type?: string; file?: string; line?: number; column?: number }) => {
        if (msg?.type !== 'open' || typeof msg.file !== 'string') return;
        const uri = ReportPanel.uris.get(msg.file);
        if (!uri) return;
        const line = Math.max(0, (msg.line ?? 1) - 1);
        const col = Math.max(0, msg.column ?? 0);
        const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        const p = new vscode.Position(line, col);
        editor.selection = new vscode.Selection(p, p);
        editor.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter);
      });
      ReportPanel.panel = panel;
    }
    ReportPanel.panel.title = title;
    ReportPanel.panel.webview.html = renderHtml(run.result, {
      webview: { nonce: nonce(), cspSource: ReportPanel.panel.webview.cspSource },
    });
    ReportPanel.panel.reveal();
  }
}

type ExportFormat = 'Markdown' | 'JSON' | 'HTML' | 'SARIF';
const EXPORT_EXTENSIONS: Readonly<Record<ExportFormat, string>> = { Markdown: 'md', JSON: 'json', HTML: 'html', SARIF: 'sarif' };

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = new DiagnosticsController();
  const version: string = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '1.0.0';
  let lastRun: AuditRun | undefined;

  context.subscriptions.push(
    diagnostics,
    vscode.languages.registerCodeActionsProvider({ scheme: '*' }, new QuickFixProvider(), {
      providedCodeActionKinds: QuickFixProvider.kinds,
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => diagnostics.refresh(doc)),
    vscode.workspace.onDidSaveTextDocument((doc) => diagnostics.refresh(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      if (readSettings(e.document.uri).run === 'onType') diagnostics.schedule(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      // Keep workspace-audit results for files that were never opened; drop live results on close.
      if (doc.uri.scheme === 'untitled') diagnostics.collection.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) diagnostics.refreshAll();
    }),
    vscode.commands.registerCommand('a11yHelper.auditWorkspace', async () => {
      const run = await runWorkspaceAudit(diagnostics);
      if (!run) return;
      lastRun = run;
      const r = run.result;
      ReportPanel.show(run, `A11y Audit — ${r.healthScore}/100 (${r.grade})`);
      void vscode.window.showInformationMessage(
        `Accessibility audit: health score ${r.healthScore}/100 (grade ${r.grade}) — ${r.errorCount} errors, ${r.warningCount} warnings, ${r.infoCount} advisory in ${r.filesScanned} files.`,
      );
    }),
    vscode.commands.registerCommand('a11yHelper.auditCurrentFile', () => {
      const editor = vscode.window.activeTextEditor;
      const doc = editor?.document;
      const path = doc ? analysisPath(doc) : null;
      if (!doc || !path) {
        void vscode.window.showWarningMessage(
          `Open an HTML, JSX/TSX, Vue, Svelte, Razor or CSS file (${AUDITABLE_EXTENSIONS.map((e) => '.' + e).join(' ')}) to audit it.`,
        );
        return;
      }
      const settings = readSettings(doc.uri);
      const label = vscode.workspace.asRelativePath(doc.uri, false);
      const acc = new AuditAccumulator();
      const fileResult = auditFile(doc.getText(), extensionOf(label) ? label : path, { categories: settings.categories });
      acc.add(fileResult);
      diagnostics.collection.set(doc.uri, toDiagnostics(doc.getText(), fileResult.findings, settings.showAdvisory));
      const uris = new Map<string, vscode.Uri>();
      for (const f of fileResult.findings) uris.set(f.filePath, doc.uri);
      const run = { result: acc.result(label, formatTimestamp(new Date())), uris };
      ReportPanel.show(run, `A11y Audit — ${label}`);
    }),
    vscode.commands.registerCommand('a11yHelper.exportReport', async () => {
      const run = lastRun ?? (await runWorkspaceAudit(diagnostics));
      if (!run) return;
      lastRun = run;
      const format = await vscode.window.showQuickPick(
        [
          { label: 'Markdown' as ExportFormat, description: 'PR / ticket friendly summary' },
          { label: 'HTML' as ExportFormat, description: 'Self-contained report with score ring and category cards' },
          { label: 'SARIF' as ExportFormat, description: 'SARIF 2.1.0 for GitHub Code Scanning / Azure DevOps' },
          { label: 'JSON' as ExportFormat, description: 'Stable machine-readable result' },
        ],
        { placeHolder: 'Export the last workspace audit as…' },
      );
      if (!format) return;
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const ext = EXPORT_EXTENSIONS[format.label];
      const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, `a11y-audit.${ext}`) : undefined,
        filters: { [format.label]: [ext] },
      });
      if (!target) return;
      let content: string;
      switch (format.label) {
        case 'Markdown': content = renderMarkdown(run.result); break;
        case 'HTML': content = renderHtml(run.result); break;
        case 'SARIF': content = renderSarif(run.result.findings, version); break;
        default: content = renderJson(run.result);
      }
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
      const open = await vscode.window.showInformationMessage(`Accessibility report saved to ${vscode.workspace.asRelativePath(target)}.`, 'Open');
      if (open) await vscode.commands.executeCommand('vscode.open', target);
    }),
    vscode.commands.registerCommand('a11yHelper.clearDiagnostics', () => diagnostics.collection.clear()),
  );

  diagnostics.refreshAll();
}

export function deactivate(): void {
  // Disposables registered in activate() are cleaned up by VS Code.
}

