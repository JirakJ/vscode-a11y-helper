/* Minimal in-memory stand-in for the `vscode` API, sufficient for the extension smoke test. */

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}
export class Range {
  constructor(readonly start: Position, readonly end: Position) {}
}
export class Selection extends Range {
  constructor(anchor: Position, active: Position) { super(anchor, active); }
}
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
export class Diagnostic {
  source?: string;
  code?: unknown;
  constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}
export class Uri {
  private constructor(readonly scheme: string, readonly path: string) {}
  static file(path: string): Uri { return new Uri('file', path); }
  static parse(value: string): Uri { return new Uri(value.split(':')[0] ?? 'file', value); }
  static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(base.scheme, [base.path, ...parts].join('/')); }
  toString(): string { return `${this.scheme}://${this.path}`; }
}
export const CodeActionKind = { QuickFix: 'quickfix' };
export class CodeAction {
  diagnostics?: Diagnostic[];
  edit?: WorkspaceEdit;
  isPreferred?: boolean;
  constructor(readonly title: string, readonly kind: string) {}
}
export class WorkspaceEdit {
  readonly edits: { uri: Uri; range: Range; text: string }[] = [];
  replace(uri: Uri, range: Range, text: string): void { this.edits.push({ uri, range, text }); }
}
export const ProgressLocation = { Notification: 15 };
export const ViewColumn = { Active: -1, Beside: -2 };
export const TextEditorRevealType = { InCenter: 2 };

export const state = {
  diagnostics: new Map<string, Diagnostic[]>(),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  codeActionProviders: [] as { provideCodeActions: (...a: unknown[]) => CodeAction[] }[],
  documents: [] as TextDocument[],
  config: {} as Record<string, unknown>,
};

export class TextDocument {
  constructor(readonly uri: Uri, readonly languageId: string, private readonly text: string) {}
  getText(): string { return this.text; }
  positionAt(offset: number): Position {
    const before = this.text.substring(0, offset).split('\n');
    return new Position(before.length - 1, before[before.length - 1]!.length);
  }
}

const noopDisposable = { dispose(): void {} };
const event = () => () => noopDisposable;

export const languages = {
  createDiagnosticCollection: () => ({
    set: (uri: Uri, d: Diagnostic[]) => { state.diagnostics.set(uri.toString(), d); },
    delete: (uri: Uri) => { state.diagnostics.delete(uri.toString()); },
    clear: () => state.diagnostics.clear(),
    dispose: () => undefined,
  }),
  registerCodeActionsProvider: (_sel: unknown, provider: { provideCodeActions: (...a: unknown[]) => CodeAction[] }) => {
    state.codeActionProviders.push(provider);
    return noopDisposable;
  },
};

export const workspace = {
  get textDocuments() { return state.documents; },
  workspaceFolders: undefined as unknown,
  getConfiguration: (section: string) => ({
    get: <T>(key: string, def: T): T => (state.config[`${section}.${key}`] as T | undefined) ?? def,
  }),
  onDidOpenTextDocument: event(),
  onDidSaveTextDocument: event(),
  onDidChangeTextDocument: event(),
  onDidCloseTextDocument: event(),
  onDidChangeConfiguration: event(),
  asRelativePath: (uri: Uri) => uri.path.replace(/^\/ws\//, ''),
};

export const window = {
  activeTextEditor: undefined as unknown,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
};

export const commands = {
  registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
    state.commands.set(id, fn);
    return noopDisposable;
  },
  executeCommand: async () => undefined,
};
