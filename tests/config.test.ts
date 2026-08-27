import { describe, expect, test } from 'bun:test';
import { hostAllowed, registerImageHost } from '../src/server/config.ts';

describe('allowlist de hosts do proxy (segunda barreira contra SSRF)', () => {
  test('host exato da lista passa', () => {
    expect(hostAllowed('uploads.mangadex.org')).toBe(true);
    expect(hostAllowed('mangadex.org')).toBe(true);
  });

  test('comparacao e case-insensitive', () => {
    expect(hostAllowed('UPLOADS.MangaDex.ORG')).toBe(true);
  });

  test('entrada com ponto casa subdominio, nao o dominio cru', () => {
    expect(hostAllowed('cmdxd98sb0x3yprd.mangadex.network')).toBe(true);
    expect(hostAllowed('mangadex.network')).toBe(false);
  });

  test('sufixo colado nao passa por subdominio', () => {
    // o classico: attacker registra "evilmangadex.network" e tenta casar com
    // a entrada ".mangadex.network" — o ponto exigido barra isso
    expect(hostAllowed('evilmangadex.network')).toBe(false);
  });

  test('dominio irmao com o permitido como prefixo nao passa', () => {
    expect(hostAllowed('mangadex.org.attacker.example')).toBe(false);
    expect(hostAllowed('uploads.mangadex.org.evil.com')).toBe(false);
  });

  test('host desconhecido e bloqueado', () => {
    expect(hostAllowed('169.254.169.254')).toBe(false);
    expect(hostAllowed('localhost')).toBe(false);
    expect(hostAllowed('')).toBe(false);
  });

  test('registerImageHost normaliza e nao duplica', () => {
    registerImageHost('Scans.Exemplo.Test');
    expect(hostAllowed('scans.exemplo.test')).toBe(true);
    registerImageHost('scans.exemplo.test');
    registerImageHost('');
    // registrar de novo nao pode criar entrada nova nem afrouxar o casamento
    expect(hostAllowed('x.scans.exemplo.test')).toBe(false);
  });
});
