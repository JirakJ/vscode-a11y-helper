// Renders the real workspace-audit HTML report for the demo/ fixture and
// captures it with headless Chrome into media/screenshot-report.png.
// Usage: node scripts/gen-screenshot.mjs [path-to-chrome]
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'a11y-shot-'));
const entry = join(work, 'entry.mjs');
await build({
  stdin: {
    contents: `export { auditFiles } from ${JSON.stringify(join(root, 'src/core/engine.ts'))};
export { renderHtml } from ${JSON.stringify(join(root, 'src/core/reports.ts'))};`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: entry,
  logLevel: 'silent',
});
const { auditFiles, renderHtml } = await import(pathToFileURL(entry).href);
const demo = join(root, 'demo');
const files = readdirSync(demo).map((name) => [name, readFileSync(join(demo, name), 'utf8')]);
const result = auditFiles(files, 'demo', '2026-11-12 09:00');
const htmlPath = join(work, 'report.html');
writeFileSync(htmlPath, renderHtml(result));

const chrome = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = join(root, 'media', 'screenshot-report.png');
execFileSync(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1280,1000', `--screenshot=${out}`, pathToFileURL(htmlPath).href,
], { stdio: 'ignore', timeout: 60_000 });
process.stdout.write(`screenshot written: ${out} (score ${result.healthScore}, ${result.findings.length} findings)\n`);
