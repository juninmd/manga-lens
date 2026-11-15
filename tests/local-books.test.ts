import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { encodePath, local, localBookBlocks } from '../src/server/providers/local.ts';
import { junkTitle, pdfIsText, pdfPageCount } from '../src/server/pdf.ts';

const box = await mkdtemp(join(tmpdir(), 'manga-lens-books-'));
const root = join(box, 'biblioteca');
const txt = join(root, 'O Farol.txt');
const md = join(root, 'Caderno.md');
const fb2 = join(root, 'conto.fb2');
const textPdf = join(root, 'Livro de Texto.pdf');
const scanPdf = join(root, 'Livro Escaneado.pdf');
const outlinePdf = join(root, 'Livro Com Sumario.pdf');
const saved = [...config.localRoots];

beforeAll(async () => {
  await mkdir(join(root, 'Manga Com Leiame'), { recursive: true });
  await writeFile(txt, 'Abertura.\n\nCapítulo 1 — A torre\n\nThe lighthouse had been dark\nfor forty years.\n\nCapítulo 2 — A luz\n\nAnd it was never dark again.');
  await writeFile(md, '# Caderno\n\n## Primeira nota\nTexto **um**.\n\n## Segunda nota\nTexto dois.');
  await writeFile(
    fb2,
    '<FictionBook><description><title-info><author><first-name>Ana</first-name><last-name>Lima</last-name></author><book-title>O Conto</book-title><lang>pt</lang></title-info></description>' +
      '<body><section><title><p>Um</p></title><p>Era uma vez.</p></section><section><title><p>Dois</p></title><p>Fim.</p></section></body></FictionBook>',
  );
  await copyFile(join(import.meta.dir, 'fixtures', 'livro-texto.pdf'), textPdf);
  await copyFile(join(import.meta.dir, 'fixtures', 'livro.pdf'), scanPdf);
  await copyFile(join(import.meta.dir, 'fixtures', 'livro-sumario.pdf'), outlinePdf);
  // dentro da pasta de uma obra, TXT e' leia-me do scan, nao livro
  await writeFile(join(root, 'Manga Com Leiame', '001.png'), 'x');
  await writeFile(join(root, 'Manga Com Leiame', 'leiame.txt'), 'creditos do scan');
  config.localRoots.splice(0, config.localRoots.length, root);
});

afterAll(async () => {
  config.localRoots.splice(0, config.localRoots.length, ...saved);
  await rm(box, { recursive: true, force: true });
});

describe('livro em texto puro na biblioteca local', () => {
  test('TXT, Markdown e FB2 na raiz aparecem na aba Livro', async () => {
    const { items } = await local.search({ contentType: 'livro' });
    const titles = items.map((i) => i.title).sort();
    expect(titles).toEqual(['Caderno', 'Livro Com Sumario', 'Livro Escaneado', 'Livro de Texto', 'O Conto', 'O Farol']);
    expect(items.every((i) => i.contentType === 'livro')).toBe(true);
    // FB2 traz o titulo dentro do arquivo; o nome do arquivo ("conto") e' so' o slug
    expect(items.find((i) => i.title === 'O Conto')?.origin).toBe('pt');
  });

  test('TXT dentro da pasta de um manga nao vira capitulo nem livro', async () => {
    const { items } = await local.search({});
    const manga = items.find((i) => i.title === 'Manga Com Leiame')!;
    const detail = await local.series(manga.id);
    expect(detail.chapters).toHaveLength(1);
    expect(detail.chapters[0]!.text).toBeUndefined();
    expect(items.some((i) => i.title === 'leiame')).toBe(false);
  });

  test('TXT: os titulos do texto viram capitulos de leitor de livro', async () => {
    const detail = await local.series(encodePath(txt));
    expect(detail.type).toBe('book');
    expect(detail.chapters.map((c) => c.title)).toEqual(['Inicio', 'Capítulo 1 — A torre', 'Capítulo 2 — A luz']);
    expect(detail.chapters.every((c) => c.text)).toBe(true);
    const blocks = await localBookBlocks(detail.chapters[1]!.id);
    // a quebra dura do arquivo e' largura de coluna, nao paragrafo
    expect(blocks).toEqual([{ id: 0, text: 'The lighthouse had been dark for forty years.' }]);
  });

  test('Markdown e FB2 abrem com capitulos e metadados', async () => {
    const caderno = await local.series(encodePath(md));
    expect(caderno.title).toBe('Caderno');
    expect(caderno.chapters.map((c) => c.title)).toEqual(['Primeira nota', 'Segunda nota']);
    expect(await localBookBlocks(caderno.chapters[0]!.id)).toEqual([{ id: 0, text: 'Texto um.' }]);

    const conto = await local.series(encodePath(fb2));
    expect(conto.title).toBe('O Conto');
    expect(conto.authors).toEqual(['Ana Lima']);
    expect(conto.chapters.map((c) => c.title)).toEqual(['Um', 'Dois']);
  });

  test('o `book` do provider e o mesmo caminho que a rota /api/book usa', async () => {
    const detail = await local.series(encodePath(txt));
    expect(await local.book!(detail.chapters[2]!.id)).toEqual([{ id: 0, text: 'And it was never dark again.' }]);
  });

  test('indice de capitulo invalido ou arquivo fora da biblioteca sao recusados', async () => {
    const outside = join(box, 'fora.txt');
    await writeFile(outside, 'segredo');
    expect(localBookBlocks(`${encodePath(outside)}.${encodePath('0')}`)).rejects.toThrow('fora da biblioteca');
    expect(localBookBlocks(`${encodePath(txt)}.${encodePath('../x')}`)).rejects.toThrow('nao pertence a um livro');
    expect(localBookBlocks(`${encodePath(txt)}.${encodePath('-1')}`)).rejects.toThrow('nao pertence a um livro');
    // indice alem do fim: capitulo vazio, nunca leitura fora do arquivo
    expect(await localBookBlocks(`${encodePath(txt)}.${encodePath('99')}`)).toEqual([]);
  });
});

describe('PDF de texto', () => {
  test('PDF sem bitmap e reconhecido como texto; o escaneado nao', async () => {
    expect(await pdfIsText(textPdf)).toBe(true);
    expect(await pdfIsText(scanPdf)).toBe(false);
  });

  test('trocar de PDF na mesma sessao nao derruba o leitor', async () => {
    // fechava o documento por um metodo que o pdf.js 6 nao tem: o segundo PDF nunca abria
    expect(await pdfPageCount(scanPdf)).toBe(1);
    expect(await pdfPageCount(textPdf)).toBe(3);
    expect(await pdfPageCount(scanPdf)).toBe(1);
  });

  test('PDF de texto abre no leitor de livro, com paragrafos e sem numero de pagina', async () => {
    const detail = await local.series(encodePath(textPdf));
    expect(detail.type).toBe('book');
    expect(detail.chapters).toHaveLength(1);
    expect(detail.chapters[0]).toMatchObject({ title: 'Paginas 1–3', text: true });
    const blocks = await localBookBlocks(detail.chapters[0]!.id);
    const texts = blocks.map((b) => b.text);
    expect(texts[0]).toBe('Parte 1');
    // a linha quebrada pela largura da pagina voltou a ser um paragrafo so'
    expect(texts).toContain(
      'Paragrafo 1 do livro de teste. Este texto existe so para o leitor de livro ter o que mostrar, e ocupa mais de uma linha da pagina para a quebra de linha do PDF aparecer na extracao.',
    );
    expect(texts).toContain('Fim da pagina 3.');
    expect(texts.some((t) => /^\d+$/.test(t))).toBe(false);
  });

  test('PDF escaneado continua no leitor de paginas', async () => {
    const detail = await local.series(encodePath(scanPdf));
    expect(detail.type).toBe('comic');
    expect(detail.chapters[0]!.text).toBeUndefined();
  });
});

describe('PDF com sumario', () => {
  test('os marcadores do PDF viram os capitulos, cada um com as suas paginas', async () => {
    const detail = await local.series(encodePath(outlinePdf));
    expect(detail.chapters.map((c) => c.title)).toEqual(['Parte 1', 'Parte 2', 'Parte 3']);
    // o PDF de teste foi gerado pelo navegador e carimba "about:blank" como titulo: vale o nome do arquivo
    expect(detail.title).toBe('Livro Com Sumario');
    const blocks = await localBookBlocks(detail.chapters[1]!.id);
    const texts = blocks.map((b) => b.text);
    expect(texts[0]).toBe('Parte 2');
    expect(texts).toContain('Fim da pagina 2.');
    // so' a pagina do capitulo: nada da pagina seguinte
    expect(texts.join(' ')).not.toContain('pagina 3');
  });

  test('faixa de paginas forjada no id e recusada', async () => {
    const tok = (range: string) => `${encodePath(outlinePdf)}.${encodePath(range)}`;
    expect(localBookBlocks(tok('0-999999'))).rejects.toThrow('nao pertence a um livro');
    expect(localBookBlocks(tok('2-1'))).rejects.toThrow('nao pertence a um livro');
    expect(localBookBlocks(tok('../x'))).rejects.toThrow('nao pertence a um livro');
    // o formato antigo (so' a pagina inicial) continua abrindo
    expect((await localBookBlocks(tok('2'))).map((b) => b.text)).toContain('Fim da pagina 3.');
  });
});

describe('titulo carimbado pelo programa que gerou o PDF', () => {
  test('lixo e descartado; titulo de verdade passa', () => {
    for (const t of ['about:blank', 'Untitled', 'Microsoft Word - cap1.docx', 'relatorio final.pdf', 'Documento1']) expect(junkTitle(t)).toBe(true);
    for (const t of ['Dom Casmurro', 'O Guarani', 'Manual do Farol: Volume 2']) expect(junkTitle(t)).toBe(false);
  });
});
