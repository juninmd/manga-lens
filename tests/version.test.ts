import { afterEach, describe, expect, test } from 'bun:test';
import { checkForUpdate, compareVersions, parseVersion, resetUpdateCache } from '../src/server/version.ts';

afterEach(() => {
  resetUpdateCache();
  delete process.env['UPDATE_CHECK'];
});

const release = (tag: string, extra: Record<string, unknown> = {}) => async () =>
  new Response(
    JSON.stringify({
      tag_name: tag,
      html_url: `https://github.com/x/y/releases/tag/${tag}`,
      body: '### Novidades\n- coisa',
      published_at: '2026-01-01T00:00:00Z',
      assets: [{ name: 'MangaLens_0.2.0_x64-setup.exe', browser_download_url: 'https://example/setup.exe' }],
      ...extra,
    }),
    { status: 200 },
  );

describe('comparacao de versao', () => {
  test('compara por numero, nao por texto', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
  });
  test('lixo nao vira atualizacao', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(compareVersions('latest', '0.1.0')).toBe(0);
  });
});

describe('checkForUpdate', () => {
  test('avisa quando a release publicada e mais nova', async () => {
    const info = await checkForUpdate({ fetcher: release('v0.2.0'), current: '0.1.0' });
    expect(info.available).toBe(true);
    expect(info.latest).toBe('0.2.0');
    expect(info.downloadUrl).toBe('https://example/setup.exe');
    expect(info.notes).toContain('Novidades');
  });

  test('mesma versao ou mais nova local nao avisa', async () => {
    expect((await checkForUpdate({ fetcher: release('v0.1.0'), current: '0.1.0' })).available).toBe(false);
    resetUpdateCache();
    expect((await checkForUpdate({ fetcher: release('v0.1.0'), current: '0.3.0' })).available).toBe(false);
  });

  test('falha de rede devolve a versao atual sem estourar', async () => {
    const info = await checkForUpdate({
      fetcher: async () => {
        throw new Error('offline');
      },
      current: '0.1.0',
    });
    expect(info.available).toBe(false);
    expect(info.latest).toBeNull();
    expect(info.error).toBe('offline');
  });

  test('pre-release e rascunho sao ignorados', async () => {
    const info = await checkForUpdate({ fetcher: release('v9.0.0', { prerelease: true }), current: '0.1.0' });
    expect(info.available).toBe(false);
  });

  test('guarda em cache e respeita o intervalo minimo do "verificar agora"', async () => {
    let calls = 0;
    const f = async () => {
      calls++;
      return release('v0.2.0')();
    };
    await checkForUpdate({ fetcher: f, current: '0.1.0', now: 1_000 });
    await checkForUpdate({ fetcher: f, current: '0.1.0', now: 2_000 });
    await checkForUpdate({ fetcher: f, current: '0.1.0', now: 10_000, force: true });
    expect(calls).toBe(1);
    await checkForUpdate({ fetcher: f, current: '0.1.0', now: 40_000, force: true });
    expect(calls).toBe(2);
  });

  test('build sem versao carimbada (dev) nao compara nem consulta', async () => {
    let called = false;
    const info = await checkForUpdate({
      fetcher: async () => {
        called = true;
        return new Response('{}');
      },
      current: 'dev',
    });
    expect(called).toBe(false);
    expect(info.devBuild).toBe(true);
    expect(info.available).toBe(false);
  });

  test('UPDATE_CHECK=off nao consulta a rede', async () => {
    process.env['UPDATE_CHECK'] = 'off';
    let called = false;
    const info = await checkForUpdate({
      fetcher: async () => {
        called = true;
        return new Response('{}');
      },
      current: '0.1.0',
    });
    expect(called).toBe(false);
    expect(info.disabled).toBe(true);
  });
});

describe('checagem desligada pelo usuario', () => {
  test('`offline` devolve a versao instalada sem consultar o GitHub', async () => {
    let calls = 0;
    const info = await checkForUpdate({
      current: '0.4.0',
      offline: true,
      fetcher: async () => {
        calls++;
        return new Response('{}');
      },
    });
    expect(calls).toBe(0);
    expect(info).toMatchObject({ current: '0.4.0', latest: null, available: false });
    expect(info.error).toBeUndefined();
  });
});

describe('instalador da release', () => {
  const asset = (over: Record<string, unknown>) => ({ name: 'MangaLens_0.2.0_x64-setup.exe', browser_download_url: 'https://example/setup.exe', ...over });
  const HEX = 'ab'.repeat(32);

  test('tamanho e SHA-256 vem do que o GitHub publica para o arquivo', async () => {
    const info = await checkForUpdate({ fetcher: release('v0.2.0', { assets: [asset({ size: 37955988, digest: `sha256:${HEX.toUpperCase()}` })] }), current: '0.1.0' });
    expect(info.installerSize).toBe(37955988);
    // hex em minusculas: e' assim que o hash calculado e' comparado
    expect(info.installerSha256).toBe(HEX);
  });

  test('release sem digest, ou com digest que nao e sha256, nao autoriza instalar', async () => {
    for (const digest of [undefined, null, 'md5:abc', `sha256:${HEX.slice(2)}`, `sha256:${HEX}zz`]) {
      resetUpdateCache();
      const info = await checkForUpdate({ fetcher: release('v0.2.0', { assets: [asset({ size: 10, digest })] }), current: '0.1.0' });
      expect(info.installerSha256).toBeNull();
      expect(info.available).toBe(true);
    }
    resetUpdateCache();
    const noSize = await checkForUpdate({ fetcher: release('v0.2.0', { assets: [asset({ size: 'x' })] }), current: '0.1.0' });
    expect(noSize.installerSize).toBeNull();
  });
});
