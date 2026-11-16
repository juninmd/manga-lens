import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { cancelUpdateDownload, getUpdateState, isDesktopApp, resetUpdateState, startUpdateDownload, UpdateError, updatesDir } from '../src/server/updater.ts';
import type { UpdateInfo } from '../src/server/version.ts';
import server from '../src/server/index.ts';

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-updater-'));
const savedCache = config.cacheDir;
config.cacheDir = dir;
afterAll(async () => {
  config.cacheDir = savedCache;
  await rm(dir, { recursive: true, force: true });
});

const realFetch = globalThis.fetch;
beforeEach(() => resetUpdateState());
afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env['MANGA_LENS_DESKTOP'];
  resetUpdateState();
  await rm(updatesDir(), { recursive: true, force: true });
});

/** "instalador": comeca com MZ como todo executavel do Windows */
const EXE = new Uint8Array([0x4d, 0x5a, ...Array.from({ length: 4000 }, (_, i) => (i * 7) % 251)]);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const NAME = 'MangaLens_0.9.0_x64-setup.exe';
const URL_OK = `https://github.com/juninmd/manga-lens/releases/download/v0.9.0/${NAME}`;
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/abc/file';

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: '0.8.0',
  latest: '0.9.0',
  available: true,
  url: 'https://github.com/juninmd/manga-lens/releases/tag/v0.9.0',
  downloadUrl: URL_OK,
  installerSize: EXE.length,
  installerSha256: sha(EXE),
  notes: null,
  publishedAt: null,
  checkedAt: 0,
  ...over,
});

/** GitHub falso: o github.com responde 302 para a CDN, que entrega os bytes. */
function fakeGithub(body: Uint8Array = EXE, opts: { redirectTo?: string } = {}): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url === URL_OK) return Promise.resolve(new Response(null, { status: 302, headers: { location: opts.redirectTo ?? CDN } }));
    if (url === CDN) return Promise.resolve(new Response(body as BodyInit));
    return Promise.resolve(new Response('nao achei', { status: 404 }));
  }) as typeof fetch;
  return urls;
}

async function settle(): Promise<ReturnType<typeof getUpdateState>> {
  for (let i = 0; i < 200; i++) {
    const s = getUpdateState();
    if (s.phase !== 'downloading' && s.phase !== 'verifying') return s;
    await Bun.sleep(10);
  }
  throw new Error('o download nao terminou');
}

describe('download do instalador', () => {
  test('segue o redirect para a CDN do GitHub, confere o hash e deixa o arquivo pronto', async () => {
    const urls = fakeGithub();
    const first = await startUpdateDownload(info());
    expect(first).toMatchObject({ phase: 'downloading', version: '0.9.0', total: EXE.length });
    const done = await settle();
    expect(done).toMatchObject({ phase: 'ready', version: '0.9.0', received: EXE.length, error: null });
    expect(done.file).toBe(join(updatesDir(), NAME));
    expect(new Uint8Array(await Bun.file(done.file!).arrayBuffer())).toEqual(EXE);
    expect(urls).toEqual([URL_OK, CDN]);
    // nada de `.part` sobrando
    expect(await readdir(updatesDir())).toEqual([NAME]);
  });

  test('hash diferente do publicado: erro e nada fica no disco', async () => {
    fakeGithub(new Uint8Array([0x4d, 0x5a, ...Array.from({ length: 4000 }, () => 1)]));
    await startUpdateDownload(info());
    const s = await settle();
    expect(s.phase).toBe('error');
    expect(s.error).toContain('nao confere com o hash');
    expect(s.file).toBeNull();
    expect(await readdir(updatesDir())).toEqual([]);
  });

  test('download incompleto e recusado mesmo que o hash fosse "certo" para os bytes recebidos', async () => {
    const half = EXE.slice(0, 1000);
    fakeGithub(half);
    await startUpdateDownload(info({ installerSha256: sha(half) }));
    const s = await settle();
    expect(s.phase).toBe('error');
    expect(s.error).toContain('incompleto');
  });

  test('o que nao e executavel do Windows nao passa, nem com o hash batendo', async () => {
    const html = new TextEncoder().encode('<html>manutencao</html>');
    fakeGithub(html);
    await startUpdateDownload(info({ installerSha256: sha(html), installerSize: html.length }));
    const s = await settle();
    expect(s.phase).toBe('error');
    expect(s.error).toContain('nao e um instalador');
  });

  test('redirect para fora do GitHub nao e seguido', async () => {
    const urls = fakeGithub(EXE, { redirectTo: 'http://169.254.169.254/latest/meta-data' });
    await startUpdateDownload(info());
    const s = await settle();
    expect(s.phase).toBe('error');
    expect(s.error).toContain('fora do GitHub');
    expect(urls.some((u) => u.includes('169.254'))).toBe(false);
    // `githubusercontent.com.evil.test` termina diferente de `.githubusercontent.com`
    resetUpdateState();
    fakeGithub(EXE, { redirectTo: 'https://objects.githubusercontent.com.evil.test/x' });
    await startUpdateDownload(info());
    expect((await settle()).error).toContain('fora do GitHub');
  });

  test('so' + " baixa o instalador deste repositorio, da versao anunciada, com hash publicado", async () => {
    fakeGithub();
    const refuse = async (over: Partial<UpdateInfo>): Promise<UpdateError> => (await startUpdateDownload(info(over)).catch((e) => e)) as UpdateError;
    expect((await refuse({ available: false })).status).toBe(409);
    expect((await refuse({ downloadUrl: null })).status).toBe(409);
    // outro repositorio, outro host, outra versao, outro tipo de arquivo
    for (const downloadUrl of [
      'https://github.com/outro/repo/releases/download/v0.9.0/MangaLens_0.9.0_x64-setup.exe',
      'https://evil.test/juninmd/manga-lens/releases/download/v0.9.0/MangaLens_0.9.0_x64-setup.exe',
      'https://github.com/juninmd/manga-lens/releases/download/v0.8.0/MangaLens_0.8.0_x64-setup.exe',
      'http://github.com/juninmd/manga-lens/releases/download/v0.9.0/MangaLens_0.9.0_x64-setup.exe',
      'https://github.com/juninmd/manga-lens/releases/download/v0.9.0/malware.zip',
      'https://github.com/juninmd/manga-lens/releases/download/v0.9.0/../../../x.exe',
    ]) {
      const err = await refuse({ downloadUrl });
      expect(err).toBeInstanceOf(UpdateError);
      expect(err.message).toContain('nao esta no repositorio');
    }
    // sem hash publicado nao ha' como provar o arquivo: instalacao manual
    const noHash = await refuse({ installerSha256: null });
    expect(noHash.status).toBe(422);
    expect(noHash.message).toContain('hash');
    expect(getUpdateState().phase).toBe('idle');
  });

  test('pedir de novo enquanto baixa nao baixa duas vezes', async () => {
    const urls = fakeGithub();
    await startUpdateDownload(info());
    await startUpdateDownload(info());
    await settle();
    expect(urls.filter((u) => u === URL_OK)).toHaveLength(1);
  });

  test('instalador ja baixado e valido e reaproveitado sem tocar na rede', async () => {
    await mkdir(updatesDir(), { recursive: true });
    await writeFile(join(updatesDir(), NAME), EXE);
    const urls = fakeGithub();
    await startUpdateDownload(info());
    expect(await settle()).toMatchObject({ phase: 'ready', file: join(updatesDir(), NAME) });
    expect(urls).toEqual([]);
    // pedir de novo com o estado ja' pronto tambem nao baixa
    await startUpdateDownload(info());
    expect(urls).toEqual([]);
  });

  test('arquivo antigo corrompido no disco e baixado de novo; instalador de versao velha some', async () => {
    await mkdir(updatesDir(), { recursive: true });
    await writeFile(join(updatesDir(), NAME), new Uint8Array([0x4d, 0x5a, 9, 9, 9]));
    await writeFile(join(updatesDir(), 'MangaLens_0.8.0_x64-setup.exe'), EXE);
    fakeGithub();
    await startUpdateDownload(info());
    const s = await settle();
    expect(s.phase).toBe('ready');
    expect(new Uint8Array(await Bun.file(s.file!).arrayBuffer())).toEqual(EXE);
    expect(await readdir(updatesDir())).toEqual([NAME]);
  });

  test('cancelar no meio volta a ocioso e limpa o parcial', async () => {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (url === URL_OK) return Promise.resolve(new Response(null, { status: 302, headers: { location: CDN } }));
      // entrega um pedaco e trava: so' a abortagem encerra
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(EXE.slice(0, 500));
        },
        pull: () => new Promise(() => undefined),
      });
      return Promise.resolve(new Response(body));
    }) as typeof fetch;
    await startUpdateDownload(info());
    for (let i = 0; i < 100 && getUpdateState().received === 0; i++) await Bun.sleep(10);
    expect(getUpdateState().received).toBe(500);
    const after = await cancelUpdateDownload();
    expect(after).toMatchObject({ phase: 'idle', version: null, received: 0, file: null, error: null });
    expect(await readdir(updatesDir()).catch(() => [])).toEqual([]);
  });
});

describe('so existe no app desktop', () => {
  test('o shell avisa o sidecar por ambiente', () => {
    expect(isDesktopApp()).toBe(false);
    process.env['MANGA_LENS_DESKTOP'] = '1';
    expect(isDesktopApp()).toBe(true);
    process.env['MANGA_LENS_DESKTOP'] = 'true';
    expect(isDesktopApp()).toBe(false);
  });

  const post = (path: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }): Promise<Response> =>
    Promise.resolve(server.fetch(new Request(`http://127.0.0.1${path}`, { method: 'POST', headers, body: '{}' })));

  test('no navegador a rota de download recusa', async () => {
    const res = await post('/api/update/download');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('app desktop');
  });

  test('sem JSON a rota recusa antes de tudo: formulario de outra pagina nao dispara download', async () => {
    process.env['MANGA_LENS_DESKTOP'] = '1';
    expect((await post('/api/update/download', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post('/api/update/cancel', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
  });

  test('build de desenvolvimento nao tem o que baixar (409), e o estado e consultavel', async () => {
    process.env['MANGA_LENS_DESKTOP'] = '1';
    expect((await post('/api/update/download')).status).toBe(409);
    const state = (await (await server.fetch(new Request('http://127.0.0.1/api/update/state'))).json()) as { phase: string; canInstall: boolean };
    expect(state).toMatchObject({ phase: 'idle', canInstall: true });
  });

  test('/api/version diz se da para instalar de dentro do app', async () => {
    const info = (await (await server.fetch(new Request('http://127.0.0.1/api/version'))).json()) as { canInstall: boolean };
    expect(info.canInstall).toBe(false);
  });
});
