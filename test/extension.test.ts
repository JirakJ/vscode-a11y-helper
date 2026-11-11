import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from './mocks/vscode';
import { activate } from '../src/extension';

function activateWith(docs: vscode.TextDocument[], config: Record<string, unknown> = {}) {
  vscode.state.diagnostics.clear();
  vscode.state.commands.clear();
  vscode.state.codeActionProviders.length = 0;
  vscode.state.documents = docs;
  vscode.state.config = config;
  const subscriptions: unknown[] = [];
  activate({ subscriptions, extension: { packageJSON: { version: '1.0.0' } } } as never);
  return subscriptions;
}

describe('extension (mocked vscode)', () => {
  let doc: vscode.TextDocument;
  beforeEach(() => {
    doc = new vscode.TextDocument(vscode.Uri.file('/ws/index.html'), 'html', '<main>\n<img src="a.png">\n<button></button>\n<a href="/x">click here</a>\n</main>');
  });

  it('registers every contributed command', () => {
    activateWith([]);
    expect([...vscode.state.commands.keys()].sort()).toEqual([
      'a11yHelper.auditCurrentFile', 'a11yHelper.auditWorkspace', 'a11yHelper.clearDiagnostics', 'a11yHelper.exportReport',
    ]);
  });

  it('publishes diagnostics with rule codes and ranges for open documents', () => {
    activateWith([doc]);
    const diags = vscode.state.diagnostics.get(doc.uri.toString())!;
    const codes = diags.map((d) => (d.code as { value: string }).value);
    expect(codes).toEqual(expect.arrayContaining(['alt-missing', 'label-missing', 'link-generic-text']));
    const alt = diags.find((d) => (d.code as { value: string }).value === 'alt-missing')!;
    expect(alt.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(alt.source).toBe('a11y');
    expect(alt.range.start).toEqual(new vscode.Position(1, 0));
    expect(alt.range.end).toEqual(new vscode.Position(1, '<img src="a.png">'.length));
  });

  it('hides advisory findings and disabled categories per settings', () => {
    activateWith([doc], { 'a11yHelper.showAdvisory': false, 'a11yHelper.rules.altText': false });
    const codes = vscode.state.diagnostics.get(doc.uri.toString())!.map((d) => (d.code as { value: string }).value);
    expect(codes).not.toContain('link-generic-text');
    expect(codes).not.toContain('alt-missing');
    expect(codes).toContain('label-missing');
  });

  it('clears diagnostics when disabled and ignores unsupported files', () => {
    const txt = new vscode.TextDocument(vscode.Uri.file('/ws/readme.txt'), 'plaintext', '<img>');
    activateWith([doc, txt], { 'a11yHelper.enable': false });
    expect(vscode.state.diagnostics.size).toBe(0);
  });

  it('offers quick fixes for diagnostics', () => {
    activateWith([doc]);
    const diags = vscode.state.diagnostics.get(doc.uri.toString())!;
    const actions = vscode.state.codeActionProviders[0]!.provideCodeActions(doc, diags[0]!.range, { diagnostics: diags });
    const titles = actions.map((a) => a.title);
    expect(titles).toContain('Add alt="" (mark image as decorative)');
    expect(titles).toContain('Add aria-label attribute');
    const altFix = actions.find((a) => a.title.startsWith('Add alt'))!;
    expect(altFix.edit!.edits[0]!.text).toBe(' alt=""');
  });
});
