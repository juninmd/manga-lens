import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readEpub, readEpubChapter, xhtmlToBlocks } from '../src/server/epub.ts';

const EPUB = join(import.meta.dir, 'fixtures', 'livro.epub');

describe('readEpub', () => {
  test('acha o OPF pelo container e le os metadados', async () => {
    const info = await readEpub(EPUB);
    expect(info.title).toBe('O Livro de Teste');
    expect(info.author).toBe('Maria Autora');
    // idioma normalizado: o OPF declara "EN" e o resto do app trabalha em minusculas
    expect(info.lang).toBe('en');
  });

  test('atributo com espaco em volta do = ainda casa', async () => {
    // a fixture escreve `full-path = "..."` e `href = "..."` de proposito: dentro
    // de template literal um `\s` com uma barra so vira um 's' literal, e o
    // parser passava a exigir que nao houvesse espaco — valido em XML
    const info = await readEpub(EPUB);
    expect(info.spine).not.toHaveLength(0);
    expect(info.cover).toBe('OEBPS/images/capa.png');
  });

  test('o spine da a ordem de leitura e exclui o que nao e linear', async () => {
    const info = await readEpub(EPUB);
    expect(info.spine.map((s) => s.href)).toEqual(['OEBPS/text/cap1.xhtml', 'OEBPS/text/cap2.xhtml']);
  });

  test('o href do manifesto e resolvido contra a pasta do OPF', async () => {
    // "text/cap1.xhtml" declarado em "OEBPS/content.opf" mora em "OEBPS/text/..."
    const info = await readEpub(EPUB);
    expect(info.cover).toBe('OEBPS/images/capa.png');
  });

  test('EPUB sem container.xml falha dizendo o que falta', async () => {
    await expect(readEpub(join(import.meta.dir, 'fixtures', 'comic.cbr'))).rejects.toThrow();
  });
});

describe('xhtmlToBlocks', () => {
  test('cada paragrafo vira um bloco numerado, na ordem', async () => {
    const blocks = await readEpubChapter(EPUB, 'OEBPS/text/cap1.xhtml');
    expect(blocks.map((b) => b.id)).toEqual([0, 1, 2, 3]);
    expect(blocks[1]!.text).toBe('It was a bright cold day in April—and the clocks were striking thirteen.');
  });

  test('script e style nao viram texto do livro', async () => {
    const blocks = await readEpubChapter(EPUB, 'OEBPS/text/cap1.xhtml');
    expect(blocks.some((b) => b.text.includes('nao e texto'))).toBe(false);
    expect(blocks.some((b) => b.text.includes('color:red'))).toBe(false);
  });

  test('entidades viram texto e paragrafo vazio some', async () => {
    const blocks = await readEpubChapter(EPUB, 'OEBPS/text/cap1.xhtml');
    expect(blocks[3]!.text).toBe('Café & jornal <velho>.');
    expect(blocks.every((b) => b.text.trim())).toBe(true);
  });

  test('bloco e a unidade que vai ao tradutor: um por linha logica', () => {
    const blocks = xhtmlToBlocks('<body><h1>T</h1><p>um<br/>dois</p><ul><li>tres</li></ul></body>');
    expect(blocks.map((b) => b.text)).toEqual(['T', 'um', 'dois', 'tres']);
  });
});
