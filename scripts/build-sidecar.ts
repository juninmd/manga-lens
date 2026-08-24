import { mkdir } from 'node:fs/promises';

/** O Tauri exige o binario externo com sufixo do target triple do Rust. */
async function targetTriple(): Promise<string> {
  const proc = Bun.spawn(['rustc', '-vV'], { stdout: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const host = /^host:\s*(.+)$/m.exec(out)?.[1]?.trim();
  if (!host) throw new Error('nao consegui ler o target triple do rustc');
  return host;
}

const triple = await targetTriple();
const ext = process.platform === 'win32' ? '.exe' : '';
const outfile = `src-tauri/binaries/manga-lens-server-${triple}${ext}`;

await mkdir('src-tauri/binaries', { recursive: true });

const proc = Bun.spawn(
  ['bun', 'build', '--compile', '--minify', '--target', 'bun', 'src/server/index.ts', '--outfile', outfile],
  { stdout: 'inherit', stderr: 'inherit' },
);
const code = await proc.exited;
if (code !== 0) process.exit(code);

const size = (await Bun.file(outfile).stat()).size;
console.log(`sidecar: ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
