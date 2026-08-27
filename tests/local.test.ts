import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { config } from '../src/server/config.ts';
import { assertInsideLibrary, decodePath, encodePath, localPagePaths } from '../src/server/providers/local.ts';

const box = await mkdtemp(join(tmpdir(), 'manga-lens-local-'));
const root = join(box, 'biblioteca');
const solta = join(root, 'HQ Solta', 'Capitulo 01');
const cbz = join(root, 'Manga Teste', 'Capitulo 01.cbz');
const saved = [...config.localRoots];

/** CBZ minimo: uma entrada de imagem, uma de lixo e uma pasta. */
function buildCbz(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const raw = Buffer.from(`dados de ${name}`, 'utf8');
    const payload = deflateRawSync(raw);
    const nb = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nb.length, 26);
    locals.push(local, nb, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nb.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nb);
    offset += 30 + nb.length + payload.length;
  }
  const cen = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, eocd]);
}

beforeAll(async () => {
  await mkdir(solta, { recursive: true });
  await mkdir(join(root, 'Manga Teste'), { recursive: true });
  // ordem natural: "10" tem de vir depois de "2", nao antes como no ASCII
  for (const n of ['1.png', '2.jpg', '10.webp']) await writeFile(join(solta, n), 'x');
  await writeFile(join(solta, 'leiame.txt'), 'nao e pagina');
  await writeFile(cbz, buildCbz(['cap/', '001.jpg', '010.png', '002.jpeg', 'ComicInfo.xml']));
  // vizinho com o mesmo prefixo do root: nao pode ser considerado "dentro"
  await mkdir(join(box, 'biblioteca-alheia'), { recursive: true });
  await writeFile(join(box, 'segredo.txt'), 'top secret');
  config.localRoots.splice(0, config.localRoots.length, root);
});

afterAll(async () => {
  config.localRoots.splice(0, config.localRoots.length, ...saved);
  await rm(box, { recursive: true, force: true });
});

describe('token de caminho', () => {
  test('ida e volta preserva acento e separador', () => {
    const p = join(root, 'Coleção — nº 3', 'Capítulo 01.cbz');
    expect(decodePath(encodePath(p))).toBe(p);
  });

  test('token e base64url (cabe na query sem escape)', () => {
    expect(encodePath(root)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('assertInsideLibrary', () => {
  test('caminho dentro da biblioteca passa e volta absoluto', () => {
    expect(assertInsideLibrary(join(solta, '1.png'))).toBe(resolve(solta, '1.png'));
  });

  test('a propria raiz e permitida', () => {
    expect(assertInsideLibrary(root)).toBe(resolve(root));
  });

  test('travessia com .. e recusada', () => {
    expect(() => assertInsideLibrary(join(root, '..', 'segredo.txt'))).toThrow('fora da biblioteca');
    expect(() => assertInsideLibrary(join(root, 'a', '..', '..', 'segredo.txt'))).toThrow('fora da biblioteca');
  });

  test('caminho absoluto de fora e recusado', () => {
    expect(() => assertInsideLibrary('C:\\Windows\\win.ini')).toThrow('fora da biblioteca');
    expect(() => assertInsideLibrary('/etc/passwd')).toThrow('fora da biblioteca');
  });

  test('pasta irma com a raiz como prefixo e recusada', () => {
    // "…/biblioteca-alheia" comeca com "…/biblioteca": sem exigir o separador
    // essa pasta entraria na biblioteca de graca
    expect(() => assertInsideLibrary(join(box, 'biblioteca-alheia', 'x.jpg'))).toThrow('fora da biblioteca');
  });

  test('sem LOCAL_LIBRARY configurada nada e liberado', () => {
    const backup = [...config.localRoots];
    config.localRoots.length = 0;
    try {
      expect(() => assertInsideLibrary(join(root, '1.png'))).toThrow('fora da biblioteca');
    } finally {
      config.localRoots.splice(0, config.localRoots.length, ...backup);
    }
  });
});

describe('localPagePaths', () => {
  test('pasta: so imagens, em ordem natural', async () => {
    const out = await localPagePaths(encodePath(solta));
    expect(out.kind).toBe('dir');
    expect(out.names).toEqual(['1.png', '2.jpg', '10.webp']);
  });

  test('CBZ: so imagens, em ordem natural, sem entrada de pasta nem metadados', async () => {
    const out = await localPagePaths(encodePath(cbz));
    expect(out.kind).toBe('zip');
    expect(out.names).toEqual(['001.jpg', '002.jpeg', '010.png']);
  });

  test('token apontando para fora da biblioteca e recusado antes de tocar o disco', async () => {
    expect(localPagePaths(encodePath(join(box, 'segredo.txt')))).rejects.toThrow('fora da biblioteca');
  });

  test('token com travessia e recusado', async () => {
    expect(localPagePaths(encodePath(join(root, '..', 'segredo.txt')))).rejects.toThrow('fora da biblioteca');
  });
});
