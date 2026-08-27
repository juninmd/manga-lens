import { afterAll, describe, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZipEntry, readZipIndex } from '../src/server/zip.ts';

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-zip-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

interface Item {
  name: string;
  data: Buffer;
  /** 0 = store, 8 = deflate; qualquer outro exercita o caminho nao suportado */
  method: number;
}

/**
 * Escreve um ZIP a mao. Nao usa biblioteca de proposito: o leitor sob teste e'
 * caseiro, entao o arquivo de entrada tem de ser montado por outro caminho.
 */
function buildZip(items: Item[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const item of items) {
    const payload = item.method === 8 ? deflateRawSync(item.data) : item.data;
    const name = Buffer.from(item.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(item.method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(item.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(item.method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(item.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + payload.length;
  }

  const cen = Buffer.concat(centrals);
  const tail = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(tail.length, 20);
  return Buffer.concat([...locals, cen, eocd, tail]);
}

const write = async (name: string, items: Item[], comment?: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, buildZip(items, comment));
  return path;
};

const PAGE_1 = Buffer.from('conteudo da pagina 1 '.repeat(40), 'utf8');
const PAGE_2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('leitor de CBZ', () => {
  test('indexa nome, tamanho e metodo de cada entrada', async () => {
    const path = await write('ok.cbz', [
      { name: '001.jpg', data: PAGE_1, method: 8 },
      { name: '002.png', data: PAGE_2, method: 0 },
    ]);
    const entries = await readZipIndex(path);
    expect(entries.map((e) => e.name)).toEqual(['001.jpg', '002.png']);
    expect(entries[0]!.size).toBe(PAGE_1.length);
    expect(entries[0]!.method).toBe(8);
    expect(entries[1]!.compressedSize).toBe(PAGE_2.length);
  });

  test('deflate volta byte a byte identico', async () => {
    const path = await write('deflate.cbz', [{ name: 'a.jpg', data: PAGE_1, method: 8 }]);
    const [entry] = await readZipIndex(path);
    expect(Buffer.compare(await readZipEntry(path, entry!), PAGE_1)).toBe(0);
  });

  test('store (sem compressao) volta byte a byte identico', async () => {
    const path = await write('store.cbz', [{ name: 'b.png', data: PAGE_2, method: 0 }]);
    const [entry] = await readZipIndex(path);
    expect(Buffer.compare(await readZipEntry(path, entry!), PAGE_2)).toBe(0);
  });

  test('entrada de diretorio nao vira pagina', async () => {
    const path = await write('dirs.cbz', [
      { name: 'cap01/', data: Buffer.alloc(0), method: 0 },
      { name: 'cap01/001.jpg', data: PAGE_1, method: 8 },
    ]);
    expect((await readZipIndex(path)).map((e) => e.name)).toEqual(['cap01/001.jpg']);
  });

  test('nome com acento e lido como UTF-8', async () => {
    const path = await write('utf8.cbz', [{ name: 'Capítulo 01 — pagina.jpg', data: PAGE_2, method: 0 }]);
    expect((await readZipIndex(path))[0]!.name).toBe('Capítulo 01 — pagina.jpg');
  });

  test('comentario no fim do arquivo nao esconde o EOCD', async () => {
    const path = await write('comment.cbz', [{ name: 'a.jpg', data: PAGE_2, method: 0 }], 'x'.repeat(500));
    expect(await readZipIndex(path)).toHaveLength(1);
  });

  test('arquivo que nao e zip acusa erro claro', async () => {
    const path = join(dir, 'nao-e-zip.cbz');
    await writeFile(path, Buffer.alloc(4096, 7));
    expect(readZipIndex(path)).rejects.toThrow('CBZ invalido');
  });

  test('metodo de compressao exotico e recusado, nao devolve lixo', async () => {
    const path = await write('lzma.cbz', [{ name: 'a.jpg', data: PAGE_2, method: 14 }]);
    const [entry] = await readZipIndex(path);
    expect(readZipEntry(path, entry!)).rejects.toThrow('nao suportado');
  });

  test('zip vazio devolve lista vazia sem estourar', async () => {
    const path = await write('vazio.cbz', []);
    expect(await readZipIndex(path)).toEqual([]);
  });
});
