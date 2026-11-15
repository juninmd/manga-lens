import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { epubChapters, epubToTextBook, readEpub, readEpubChapter, stripGutenbergBoilerplate, tocTitles, xhtmlToBlocks, xhtmlToItems } from '../src/server/epub.ts';

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

describe('sumario do EPUB', () => {
  test('NCX (EPUB 2): o titulo de cada arquivo, resolvido contra a pasta do sumario', () => {
    const ncx = `<ncx><navMap>
      <navPoint id="a"><navLabel><text>Capitulo &amp; Um</text></navLabel><content src="text/c1.xhtml"/></navPoint>
      <navPoint id="b"><navLabel><text> A  volta </text></navLabel><content src="text/c1.xhtml#parte2"/></navPoint>
      <navPoint id="c"><navLabel><text>Dois</text></navLabel><content src="text/c2.xhtml"/></navPoint>
    </navMap></ncx>`;
    const titles = tocTitles(ncx, 'OEBPS/toc.ncx');
    // duas entradas no mesmo arquivo (ancora): vale a primeira, que e' a que abre o arquivo
    expect([...titles]).toEqual([
      ['OEBPS/text/c1.xhtml', 'Capitulo & Um'],
      ['OEBPS/text/c2.xhtml', 'Dois'],
    ]);
  });

  test('nav (EPUB 3): so a lista `toc`, nao os landmarks do mesmo arquivo', () => {
    const nav = `<html><body>
      <nav epub:type="toc"><ol><li><a href="../text/c1.xhtml"><span>Primeiro</span> capitulo</a></li><li><a href="../text/c2.xhtml">Segundo</a></li></ol></nav>
      <nav epub:type="landmarks"><ol><li><a href="../text/capa.xhtml">Capa</a></li></ol></nav>
    </body></html>`;
    expect([...tocTitles(nav, 'OEBPS/nav/nav.xhtml')]).toEqual([
      ['OEBPS/text/c1.xhtml', 'Primeiro capitulo'],
      ['OEBPS/text/c2.xhtml', 'Segundo'],
    ]);
  });

  test('`%` solto no nome do arquivo nao derruba a leitura do livro', () => {
    expect([...tocTitles('<nav epub:type="toc"><a href="100%.xhtml">Cem</a></nav>', 'nav.xhtml')]).toEqual([['100%.xhtml', 'Cem']]);
  });

  test('capitulos: titulo vem do primeiro cabecalho quando o livro nao tem sumario', async () => {
    const chapters = await epubChapters(EPUB, await readEpub(EPUB));
    expect(chapters.map((c) => c.href)).toEqual(['OEBPS/text/cap1.xhtml', 'OEBPS/text/cap2.xhtml']);
    expect(chapters[0]!.title).toBe('Chapter One');
  });
});

describe('texto do EPUB', () => {
  test('quebra de linha do ARQUIVO nao e paragrafo (HTML antigo, coluna de 70)', () => {
    const blocks = xhtmlToBlocks('<body><p>Someone must have been telling lies about Josef K., he knew he had\ndone nothing wrong but, one morning,\n   he was arrested.</p><p>Outro.</p></body>');
    expect(blocks.map((b) => b.text)).toEqual(['Someone must have been telling lies about Josef K., he knew he had done nothing wrong but, one morning, he was arrested.', 'Outro.']);
  });

  test('itens marcam o que era titulo; titulo menor so vale colado em outro', () => {
    const items = xhtmlToItems('<body><h5>I</h5><h4>Do titulo.</h4><p>Uma noite destas.</p><h5>P. S.</h5><p>Carta.</p><h2>Capitulo\nDois</h2><p>Fim.</p></body>');
    expect(items).toEqual([
      { text: 'I', heading: true, minor: true },
      { text: 'Do titulo.', heading: true },
      { text: 'Uma noite destas.', heading: false },
      // <h5> sozinho antes de um paragrafo enfeita carta e poema: e' texto, nao capitulo
      { text: 'P. S.', heading: false },
      { text: 'Carta.', heading: false },
      { text: 'Capitulo Dois', heading: true },
      { text: 'Fim.', heading: false },
    ]);
  });

  test('cabecalho e licenca do Gutenberg ficam fora do livro', () => {
    const p = (text: string) => ({ text, heading: false });
    const items = [p('The Project Gutenberg eBook of Dracula'), p('*** START OF THE PROJECT GUTENBERG EBOOK DRACULA ***'), p('CHAPTER I'), p('Left Munich at 8:35 P. M.'), p('*** END OF THE PROJECT GUTENBERG EBOOK DRACULA ***'), p('Updated editions will replace the previous one.')];
    expect(stripGutenbergBoilerplate(items).map((i) => i.text)).toEqual(['CHAPTER I', 'Left Munich at 8:35 P. M.']);
    // livro sem os marcadores passa intacto
    expect(stripGutenbergBoilerplate([p('a'), p('b')])).toHaveLength(2);
  });

  test('livro inteiro cortado pelos titulos, nao pelos arquivos do spine', async () => {
    const book = await epubToTextBook(EPUB, await readEpub(EPUB));
    expect(book.title).toBe('O Livro de Teste');
    expect(book.chapters.length).toBeGreaterThan(0);
    expect(book.chapters.flatMap((c) => c.paragraphs)).toContain('Café & jornal <velho>.');
  });
});
