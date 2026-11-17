import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import server from '../src/server/index.ts';
import { config } from '../src/server/config.ts';
import { providers } from '../src/server/providers/index.ts';
import type { Provider } from '../src/server/providers/types.ts';
import { readZipIndex } from '../src/server/zip.ts';

const realFetch = globalThis.fetch;
const realRoots = config.localRoots;
const lib = await mkdtemp(join(tmpdir(), 'manga-lens-dl-'));
afterEach(() => {
  globalThis.fetch = realFetch;
  config.localRoots = realRoots;
});
afterAll(() => rm(lib, { recursive: true, force: true }));

const fake = {
  id: 'fake-dl',
  name: 'Fake',
  pages: async () => [
    { url: 'https://uploads.mangadex.org/a.jpg' },
    { url: 'https://uploads.mangadex.org/b.png' },
  ],
} as unknown as Provider;
providers.push(fake);

const post = (body: unknown) =>
  server.fetch(
    new Request('http://127.0.0.1/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  );

function stubImages(): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    const png = String(input).endsWith('.png');
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': png ? 'image/png' : 'image/jpeg' } }));
  }) as typeof fetch;
}

describe('baixar capitulo como CBZ', () => {
  test('sem provider ou capitulo: 400', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ provider: 'local', chapter: 'x' })).status).toBe(400);
  });

  test('com biblioteca local: grava o CBZ na pasta da obra', async () => {
    stubImages();
    config.localRoots = [lib];
    const res = await post({ provider: 'fake-dl', chapter: 'c1', series: 'Minha: Obra', label: 'Cap. 1' });
    expect(res.status).toBe(200);
    const { saved, pages } = (await res.json()) as { saved: string; pages: number };
    expect(pages).toBe(2);
    expect(saved).toBe(join(lib, 'Minha Obra', 'Cap. 1.cbz'));
    expect((await readZipIndex(saved)).map((e) => e.name)).toEqual(['001.jpg', '002.png']);
  });

  test('sem biblioteca: devolve o arquivo para o navegador', async () => {
    stubImages();
    config.localRoots = [];
    const res = await post({ provider: 'fake-dl', chapter: 'c1', series: 'Obra', label: 'Cap 2' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.comicbook+zip');
    expect(res.headers.get('content-disposition')).toContain('Obra%20-%20Cap%202.cbz');
  });
});
