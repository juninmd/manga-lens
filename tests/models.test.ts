import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { MODELS } from '../src/server/models.ts';
import server from '../src/server/index.ts';

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-models-'));
config.cacheDir = dir;
afterAll(() => rm(dir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GOOD = new TextEncoder().encode('modelo de teste');
let hits = 0;
function serve(bytes: Uint8Array<ArrayBuffer>): void {
  hits = 0;
  globalThis.fetch = (async () => {
    hits++;
    return new Response(bytes);
  }) as unknown as typeof fetch;
}
const spec = (name: string): void => {
  MODELS[name] = {
    url: 'https://huggingface.co/x/resolve/abc/m.onnx',
    sha256: createHash('sha256').update(GOOD).digest('hex'),
    bytes: GOOD.byteLength,
  };
};
const get = (name: string): Promise<Response> => Promise.resolve(server.fetch(new Request(`http://127.0.0.1/api/models/${name}.onnx`)));

describe('GET /api/models/:name', () => {
  test('arquivo adulterado (hash diferente, mesmo tamanho) e recusado e nada vai para o disco', async () => {
    spec('adulterado');
    serve(new TextEncoder().encode('modelo de TESTE'));
    const res = await get('adulterado');
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('hash nao confere');
    expect(await readdir(join(dir, 'models')).catch(() => [])).not.toContainEqual(expect.stringContaining('adulterado'));
  });

  test('tamanho diferente do esperado e recusado', async () => {
    spec('truncado');
    serve(GOOD.slice(0, 3));
    expect((await get('truncado')).status).toBe(502);
  });

  test('modelo conferido e servido e fica em cache: segundo pedido nao baixa de novo', async () => {
    spec('bom');
    serve(GOOD);
    const first = await get('bom');
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(GOOD);
    expect((await get('bom')).status).toBe(200);
    expect(hits).toBe(1);
  });

  test('nome fora da lista (inclusive propriedade do prototipo) da 404 sem tocar a rede', async () => {
    serve(GOOD);
    for (const name of ['nao-existe', 'constructor', '__proto__']) expect((await get(name)).status).toBe(404);
    expect(hits).toBe(0);
  });
});
