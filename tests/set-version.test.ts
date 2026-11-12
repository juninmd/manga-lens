import { describe, expect, test } from 'bun:test';
import { setBuildInfo, setCargoVersion, setJsonVersion } from '../scripts/set-version.ts';

describe('carimbo de versao', () => {
  test('json troca so a versao do pacote', () => {
    const src = '{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "a": "^1.0.0" }\n}';
    const out = setJsonVersion(src, '2.3.4');
    expect(out).toContain('"version": "2.3.4"');
    expect(out).toContain('"a": "^1.0.0"');
  });

  test('build-info guarda a versao carimbada', () => {
    expect(JSON.parse(setBuildInfo('{ "version": null }', '1.2.3'))).toEqual({ version: '1.2.3' });
  });

  test('cargo troca a versao de [package] e preserva a das dependencias', () => {
    const src = '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\ntauri = { version = "2" }\nserde = "1"\n';
    const out = setCargoVersion(src, '1.0.0');
    expect(out).toContain('[package]\nname = "x"\nversion = "1.0.0"');
    expect(out).toContain('tauri = { version = "2" }');
  });
});
