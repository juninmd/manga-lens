import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZipEntry, readZipIndex } from '../src/server/zip.ts';
import { buildStoredZip, imageExt, safeFileName } from '../src/server/zip-write.ts';

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-zipw-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('CBZ gerado pelo app', () => {
  test('o leitor de CBZ le de volta o que o escritor gravou', async () => {
    const a = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    const b = new Uint8Array(5000).fill(7);
    const path = join(dir, 'cap.cbz');
    await writeFile(path, buildStoredZip([{ name: '001.jpg', data: a }, { name: 'Capítulo/002.png', data: b }]));
    const entries = await readZipIndex(path);
    expect(entries.map((e) => e.name)).toEqual(['001.jpg', 'Capítulo/002.png']);
    expect([...(await readZipEntry(path, entries[0]!))]).toEqual([...a]);
    expect((await readZipEntry(path, entries[1]!)).length).toBe(5000);
  });

  test('crc32 confere com o zip do sistema', async () => {
    const zip = buildStoredZip([{ name: 'a.txt', data: new TextEncoder().encode('abc') }]);
    expect(new DataView(zip.buffer).getUint32(14, true)).toBe(0x352441c2);
  });

  test('nome de arquivo seguro', () => {
    expect(safeFileName('One Piece: Cap. 1/2?')).toBe('One Piece Cap. 1 2');
    expect(safeFileName('  ...  ')).toBe('sem titulo');
    expect(safeFileName('CON')).toBe('sem titulo');
    expect(safeFileName('x'.repeat(200)).length).toBe(80);
  });

  test('extensao pelo content-type', () => {
    expect(imageExt('image/webp')).toBe('.webp');
    expect(imageExt('image/jpeg; charset=binary')).toBe('.jpg');
  });
});
