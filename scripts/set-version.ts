/**
 * Carimba a versao da release nos manifestos antes de compilar o instalador:
 * src/server/build-info.json (que o sidecar embute), tauri.conf.json (nome do instalador e
 * "Sobre") e Cargo.toml. O repositorio guarda `version: null` (build de desenvolvimento) e 0.1.0 nos manifestos do Tauri — quem manda e' a tag,
 * entao o carimbo vale so' para o build do CI e nunca e' commitado.
 */
import { parseVersion } from '../src/server/version.ts';

/** build-info.json: `{ "version": "X.Y.Z" }`; e' o que o servidor mostra como versao instalada. */
export const setBuildInfo = (_text: string, version: string): string => `${JSON.stringify({ version }, null, 2)}\n`;

/** Troca o primeiro `"version": "..."` — o do proprio pacote, que vem antes das dependencias. */
export const setJsonVersion = (text: string, version: string): string =>
  text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);

/** Troca o `version` da secao [package], sem tocar nas versoes das dependencias. */
export const setCargoVersion = (text: string, version: string): string =>
  text.replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]*(")/, `$1${version}$2`);

if (import.meta.main) {
  const version = (process.argv[2] ?? '').replace(/^v/, '');
  if (!parseVersion(version)) {
    console.error('uso: bun run scripts/set-version.ts <X.Y.Z>');
    process.exit(1);
  }
  const edits: [string, (t: string, v: string) => string][] = [
    ['src/server/build-info.json', setBuildInfo],
    ['src-tauri/tauri.conf.json', setJsonVersion],
    ['src-tauri/Cargo.toml', setCargoVersion],
  ];
  for (const [path, fn] of edits) {
    const file = Bun.file(path);
    const before = await file.text();
    const after = fn(before, version);
    if (after === before && !before.includes(version)) throw new Error(`nao achei a versao em ${path}`);
    await Bun.write(path, after);
    console.log(`${path} -> ${version}`);
  }
}
