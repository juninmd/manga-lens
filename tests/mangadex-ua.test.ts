import { describe, expect, test } from 'bun:test';
import { userAgentForUrl } from '../src/server/config.ts';
import '../src/server/providers/mangadex.ts';

describe('mangadex', () => {
  test('a API recebe UA identificado, nao de navegador (senao vem desafio anti-bot em HTML)', () => {
    expect(userAgentForUrl('https://api.mangadex.org/manga')).toBe('MangaLens/0.1.0');
    expect(userAgentForUrl('https://example.com/')).toContain('Mozilla');
  });
});
