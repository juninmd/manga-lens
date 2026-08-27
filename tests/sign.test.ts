import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSecret, signUrl, verifyUrl } from '../src/server/sign.ts';

/** Extrai u/r/s da URL assinada — o mesmo que o handler /api/img faz. */
const parts = (signed: string): { u: string; r: string; s: string } => {
  const q = new URLSearchParams(signed.slice(signed.indexOf('?') + 1));
  return { u: q.get('u') ?? '', r: q.get('r') ?? '', s: q.get('s') ?? '' };
};

describe('assinatura do proxy de imagem', () => {
  test('ida e volta preserva URL e referer', () => {
    const signed = signUrl('https://uploads.mangadex.org/data/abc/1.jpg', 'https://mangadex.org/');
    const { u, r, s } = parts(signed);
    expect(verifyUrl(u, r, s)).toEqual({
      url: 'https://uploads.mangadex.org/data/abc/1.jpg',
      referer: 'https://mangadex.org/',
    });
  });

  test('sem referer o campo volta indefinido, nao string vazia', () => {
    const { u, r, s } = parts(signUrl('https://uploads.mangadex.org/a.jpg'));
    expect(r).toBe('');
    expect(verifyUrl(u, r, s).referer).toBeUndefined();
  });

  test('URL trocada com a mesma assinatura e recusada', () => {
    const { r, s } = parts(signUrl('https://uploads.mangadex.org/a.jpg'));
    const evil = Buffer.from('https://attacker.example/steal', 'utf8').toString('base64url');
    expect(() => verifyUrl(evil, r, s)).toThrow('assinatura invalida');
  });

  test('referer trocado com a mesma assinatura e recusado', () => {
    const { u, s } = parts(signUrl('https://uploads.mangadex.org/a.jpg', 'https://mangadex.org/'));
    const other = Buffer.from('https://attacker.example/', 'utf8').toString('base64url');
    expect(() => verifyUrl(u, other, s)).toThrow('assinatura invalida');
  });

  test('assinatura de tamanho diferente nao explode em timingSafeEqual', () => {
    const { u, r } = parts(signUrl('https://uploads.mangadex.org/a.jpg'));
    // timingSafeEqual lanca TypeError com buffers de tamanhos diferentes;
    // o guarda de comprimento tem de transformar isso em recusa normal
    for (const forged of ['', 'x', 'a'.repeat(1000)]) {
      expect(() => verifyUrl(u, r, forged)).toThrow('assinatura invalida');
    }
  });

  test('assinatura nao vaza no formato: sempre base64url sem padding', () => {
    const { s } = parts(signUrl('https://uploads.mangadex.org/a.jpg'));
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('mesma entrada gera a mesma assinatura dentro do processo', () => {
    const a = signUrl('https://uploads.mangadex.org/a.jpg', 'https://mangadex.org/');
    const b = signUrl('https://uploads.mangadex.org/a.jpg', 'https://mangadex.org/');
    expect(a).toBe(b);
  });
});

describe('segredo do HMAC', () => {
  const boxes: string[] = [];
  const box = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'manga-lens-secret-'));
    boxes.push(dir);
    return dir;
  };
  afterAll(() => Promise.all(boxes.map((d) => rm(d, { recursive: true, force: true }))));

  test('sobrevive ao reinicio do processo', async () => {
    // o cliente guarda a URL JA assinada no localStorage (favoritos, "continuar
    // lendo", marcadores). Segredo sorteado a cada processo fazia toda capa
    // guardada responder 403 depois de reiniciar o servidor.
    const dir = await box();
    const first = resolveSecret(dir);
    expect(resolveSecret(dir)).toBe(first);
    expect(first.length).toBeGreaterThanOrEqual(32);
  });

  test('cada instalacao tem o seu', async () => {
    expect(resolveSecret(await box())).not.toBe(resolveSecret(await box()));
  });

  test('MANGA_LENS_SECRET tem prioridade (varias replicas compartilham a chave)', async () => {
    const dir = await box();
    process.env['MANGA_LENS_SECRET'] = 'chave-fixada-pelo-operador';
    try {
      expect(resolveSecret(dir)).toBe('chave-fixada-pelo-operador');
    } finally {
      delete process.env['MANGA_LENS_SECRET'];
    }
  });

  test('diretorio nao gravavel nao derruba o servidor', () => {
    expect(() => resolveSecret('\0caminho invalido')).not.toThrow();
  });
});
