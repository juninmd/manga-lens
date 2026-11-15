import { describe, expect, test } from 'bun:test';
import { buildChapters, decodeText, isHeading, linesToParagraphs, parseFb2, parseMarkdown, parsePdfRange, parseTxt, PART_SIZE, pdfSections, textFormatOf } from '../src/server/text-book.ts';

describe('titulo de capitulo em texto puro', () => {
  test('numero e obrigatorio: frase que comeca com "Parte" nao e titulo', () => {
    for (const line of ['CHAPTER I. Down the Rabbit-Hole', 'Capítulo 3', 'Chapter 12 The End', 'Parte II — A volta', 'Livro Primeiro', 'Prólogo', 'Act 2:']) {
      expect(isHeading(line)).toBe(true);
    }
    for (const line of ['Part of the problem is this.', 'Part I have seen', 'Book reviews are fun.', 'Capítulo']) {
      expect(isHeading(line)).toBe(false);
    }
  });
});

describe('parseTxt', () => {
  test('corta nos titulos e desfaz a quebra dura da coluna', () => {
    const book = parseTxt('Abertura do livro.\n\nCapítulo 1\n\nPrimeira linha\nsegunda linha.\n\nOutro paragrafo.\n\nCapítulo 2\n\nFim.');
    expect(book.chapters.map((c) => c.title)).toEqual(['Inicio', 'Capítulo 1', 'Capítulo 2']);
    // a quebra no meio do paragrafo era so' a largura da coluna do arquivo
    expect(book.chapters[1]!.paragraphs).toEqual(['Primeira linha segunda linha.', 'Outro paragrafo.']);
  });

  test('sem titulo nenhum, vira partes de tamanho fixo', () => {
    const body = Array.from({ length: PART_SIZE * 2 + 5 }, (_, i) => `Paragrafo ${i}.`).join('\n\n');
    const book = parseTxt(body);
    expect(book.chapters.map((c) => c.title)).toEqual(['Parte 1', 'Parte 2', 'Parte 3']);
    expect(book.chapters[0]!.paragraphs).toHaveLength(PART_SIZE);
    expect(book.chapters[2]!.paragraphs).toHaveLength(5);
  });

  test('um titulo solto nao divide o livro em dois capitulos tortos', () => {
    const book = parseTxt('Texto antes.\n\nCapítulo 1\n\nTexto depois.');
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0]!.paragraphs).toEqual(['Texto antes.', 'Texto depois.']);
  });
});

describe('buildChapters', () => {
  test('titulos seguidos viram um so: vale o par final, o resto e folha de rosto', () => {
    const h = (text: string) => ({ text, heading: true });
    const p = (text: string) => ({ text, heading: false });
    const chapters = buildChapters([h('DOM CASMURRO'), h('MACHADO DE ASSIS'), h('1899'), h('I'), h('Do titulo.'), p('Uma noite destas...'), h('II'), h('Do livro.'), p('Agora que expliquei o titulo...')]);
    expect(chapters.map((c) => c.title)).toEqual(['I — Do titulo.', 'II — Do livro.']);
  });
});

describe('parseMarkdown', () => {
  test('# e ## dividem em capitulos e a marcacao some do texto', () => {
    const book = parseMarkdown('# O Livro\nIntroducao **forte**.\n\n## Um\nTexto com [link](http://x.test) e `codigo`.\n\n## Dois\n- item da lista');
    expect(book.title).toBe('O Livro');
    // o `#` e' o titulo do livro; o texto solto antes do primeiro `##` vira a abertura
    expect(book.chapters.map((c) => c.title)).toEqual(['Inicio', 'Um', 'Dois']);
    expect(book.chapters[0]!.paragraphs).toEqual(['Introducao forte.']);
    expect(book.chapters[1]!.paragraphs).toEqual(['Texto com link e codigo.']);
    expect(book.chapters[2]!.paragraphs).toEqual(['item da lista']);
  });
});

describe('parseFb2', () => {
  const FB2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook><description><title-info>
  <author><first-name>Anton</first-name><last-name>Tchekhov</last-name></author>
  <book-title>A Dama &amp; o Cachorrinho</book-title><lang>RU</lang>
  <annotation><p>Um conto de 1899.</p></annotation>
</title-info></description>
<body>
  <section><title><p>I</p></title><p>Diziam que <emphasis>havia</emphasis> aparecido alguem novo.</p><p>Segundo paragrafo.</p></section>
  <section><title><p>II</p></title><p>Passou uma semana.</p></section>
</body>
<body name="notes"><section><title><p>Notas</p></title><p>nota de rodape que nao e texto do livro</p></section></body>
</FictionBook>`;

  test('le titulo, autor, idioma e uma secao por capitulo', () => {
    const book = parseFb2(FB2);
    expect(book.title).toBe('A Dama & o Cachorrinho');
    expect(book.author).toBe('Anton Tchekhov');
    expect(book.lang).toBe('ru');
    expect(book.description).toBe('Um conto de 1899.');
    expect(book.chapters.map((c) => c.title)).toEqual(['I', 'II']);
    expect(book.chapters[0]!.paragraphs).toEqual(['Diziam que havia aparecido alguem novo.', 'Segundo paragrafo.']);
  });

  test('o corpo de notas fica fora do livro', () => {
    expect(JSON.stringify(parseFb2(FB2).chapters)).not.toContain('rodape');
  });
});

describe('decodeText', () => {
  test('TXT antigo em Latin-1 nao vira caracteres de substituicao', () => {
    // "Capítulo" em windows-1252: 0xED nao e' UTF-8 valido
    const latin1 = Uint8Array.from([0x43, 0x61, 0x70, 0xed, 0x74, 0x75, 0x6c, 0x6f]);
    expect(decodeText(latin1)).toBe('Capítulo');
    expect(decodeText(new TextEncoder().encode('﻿Capítulo\r\nfim'))).toBe('Capítulo\nfim');
  });
});

describe('linesToParagraphs (PDF de texto)', () => {
  test('paragrafo fecha em fim de frase numa linha curta; titulo curto fica sozinho', () => {
    const lines = [
      'Parte 1',
      'Paragrafo um do livro de teste. Este texto existe so para o leitor de',
      'livro ter o que mostrar, e ocupa mais de uma linha.',
      'Paragrafo dois, que tambem quebra de linha na largura da coluna do',
      'arquivo e termina aqui.',
    ];
    expect(linesToParagraphs(lines)).toEqual([
      'Parte 1',
      'Paragrafo um do livro de teste. Este texto existe so para o leitor de livro ter o que mostrar, e ocupa mais de uma linha.',
      'Paragrafo dois, que tambem quebra de linha na largura da coluna do arquivo e termina aqui.',
    ]);
  });

  test('hifen de fim de linha e desfeito', () => {
    expect(linesToParagraphs(['Uma palavra muito comprida que foi separada no fim da li-', 'nha e continua aqui.'])).toEqual([
      'Uma palavra muito comprida que foi separada no fim da linha e continua aqui.',
    ]);
  });
});

describe('textFormatOf', () => {
  test('so os formatos de texto que o leitor de livro abre', () => {
    expect(textFormatOf('/a/Livro.TXT')).toBe('txt');
    expect(textFormatOf('/a/notas.markdown')).toBe('md');
    expect(textFormatOf('/a/conto.fb2')).toBe('fb2');
    expect(textFormatOf('/a/capa.png')).toBeNull();
  });
});

describe('pdfSections', () => {
  test('cada marcador vai ate o seguinte; o que vem antes do primeiro e "Inicio"', () => {
    const out = pdfSections([{ title: 'Um', page: 2 }, { title: 'Dois', page: 5 }], 9);
    expect(out).toEqual([
      { title: 'Inicio', first: 0, end: 2 },
      { title: 'Um', first: 2, end: 5 },
      { title: 'Dois', first: 5, end: 9 },
    ]);
  });

  test('secao longa e fatiada; marcador repetido, fora do PDF ou sem titulo e ignorado', () => {
    const out = pdfSections(
      [
        { title: 'Longo', page: 0 },
        { title: 'Mesmo lugar', page: 0 },
        { title: 'Fim', page: 70 },
        { title: 'Fantasma', page: 500 },
        { title: '  ', page: 71 },
      ],
      75,
      10,
      30,
    );
    expect(out.map((s) => s.title)).toEqual(['Longo (1/3)', 'Longo (2/3)', 'Longo (3/3)', 'Fim']);
    expect(out[2]).toMatchObject({ first: 60, end: 70 });
  });

  test('sem sumario (ou com um marcador so), blocos de paginas', () => {
    expect(pdfSections([], 23, 10).map((s) => s.title)).toEqual(['Paginas 1–10', 'Paginas 11–20', 'Paginas 21–23']);
    expect(pdfSections([{ title: 'Unico', page: 0 }], 1, 10)).toEqual([{ title: 'Pagina 1', first: 0, end: 1 }]);
  });
});

describe('parsePdfRange', () => {
  test('faixa valida, formato antigo e limites', () => {
    expect(parsePdfRange('3-7', 20)).toEqual({ first: 3, end: 7 });
    expect(parsePdfRange('15', 20, 10)).toEqual({ first: 15, end: 20 });
    expect(parsePdfRange('0-61', 100)).toBeNull();
    expect(parsePdfRange('5-5', 20)).toBeNull();
    expect(parsePdfRange('20', 20)).toBeNull();
    expect(parsePdfRange('-1', 20)).toBeNull();
    expect(parsePdfRange('1-2x', 20)).toBeNull();
  });
});
