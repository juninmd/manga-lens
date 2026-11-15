import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { authorName, gutenberg, normalizeLanguage, searchQuery } from '../src/server/providers/gutenberg.ts';

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-gutenberg-'));
config.cacheDir = dir;
afterAll(() => rm(dir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const EPUB = await Bun.file(join(import.meta.dir, 'fixtures', 'livro.epub')).bytes();

interface Upstream {
  collection?: string;
  /** resposta do /download/: por padrao, redirect para o no' do Archive e depois o EPUB */
  download?: (url: string) => Response;
}

/** Archive falso: busca, metadados e download. Devolve as URLs pedidas, na ordem. */
function fakeArchive(opts: Upstream = {}): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/advancedsearch.php')) {
      return Promise.resolve(
        Response.json({
          response: {
            numFound: 2,
            docs: [
              { identifier: 'dracula45839gut', title: 'Dracula', creator: 'Stoker, Bram, 1847-1912', language: 'eng', subject: ['Horror tales', 'PR', 'Vampires -- Fiction'] },
              { identifier: 'romance00001gut', title: 'Um Romance', creator: ['Silva, Ana'], language: 'por', subject: 'Erotic stories' },
            ],
          },
        }),
      );
    }
    if (url.includes('/metadata/')) {
      return Promise.resolve(
        Response.json({
          metadata: { title: 'Dracula', creator: 'Stoker, Bram, 1847-1912', language: 'en', collection: opts.collection ?? 'gutenberg', subject: ['Horror tales'] },
          files: [
            { name: 'pg45839-images.epub', format: 'EPUB', size: '900000' },
            { name: 'pg45839.epub', format: 'EPUB', size: String(EPUB.length) },
            { name: 'pg45839.cover.medium.jpg', format: 'JPEG', size: '10460' },
          ],
        }),
      );
    }
    if (opts.download) return Promise.resolve(opts.download(url));
    if (url.startsWith('https://archive.org/download/')) {
      return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://ia800000.us.archive.org/0/items/x/pg45839.epub' } }));
    }
    return Promise.resolve(new Response(EPUB, { status: 200 }));
  }) as typeof fetch;
  return urls;
}

describe('busca no acervo', () => {
  test('so o espelho do Gutenberg com EPUB, e cada palavra vira prefixo', () => {
    const q = searchQuery({ q: 'alice wonderland' });
    expect(q).toContain('collection:gutenberg');
    expect(q).toContain('format:EPUB');
    // o indice guarda "alice's" inteiro: sem o `*`, "alice" nao achava Alice's Adventures
    expect(q).toContain('title:(alice* wonderland*)');
    expect(q).toContain('creator:(alice* wonderland*)');
  });

  test('caractere de sintaxe da busca nao escapa da consulta', () => {
    const q = searchQuery({ q: 'dracula") OR collection:(opensource' });
    expect(q).not.toContain('"');
    // minusculas: "OR" digitado pelo usuario nao vira operador
    expect(q).toContain('title:(dracula* or collection* opensource*)');
    expect(q.startsWith('collection:gutenberg AND mediatype:texts AND format:EPUB AND ')).toBe(true);
  });

  test('idioma pedido vira todos os apelidos que o Archive usa para ele', () => {
    expect(searchQuery({ langs: ['pt-br'] })).toContain('language:(por OR pt OR Portuguese)');
    // idioma que o acervo nao mapeia nao vira filtro vazio (que zeraria a busca)
    expect(searchQuery({ langs: ['xx'] })).not.toContain('language:');
  });

  test('literatura adulta so aparece para quem marcou a classificacao', () => {
    expect(searchQuery({ q: 'x' })).toContain('NOT subject:(erotic* OR pornograph*)');
    expect(searchQuery({ q: 'x', contentRating: ['safe', 'suggestive'] })).toContain('NOT subject:');
    expect(searchQuery({ q: 'x', contentRating: ['erotica'] })).not.toContain('NOT subject:');
  });

  test('sem busca a estante e de literatura; com busca nao ha recorte', () => {
    expect(searchQuery({})).toContain('subject:(fiction OR');
    expect(searchQuery({ q: 'torno mecanico' })).not.toContain('subject:(fiction OR');
  });

  test('card: autor legivel, idioma normalizado, sem capa generica e sem classe da LoC', async () => {
    fakeArchive();
    const { items, total } = await gutenberg.search({ q: 'dracula' });
    expect(total).toBe(2);
    expect(items[0]).toMatchObject({ id: 'dracula45839gut', provider: 'gutenberg', contentType: 'livro', type: 'book', origin: 'en', authors: ['Bram Stoker'], contentRating: 'safe' });
    // a miniatura do Archive para estes itens e' o logotipo do site: o card desenha a capa
    expect(items[0]!.cover).toBeUndefined();
    expect(items[0]!.tags).toEqual(['Horror tales', 'Vampires -- Fiction']);
    expect(items[1]).toMatchObject({ origin: 'pt', contentRating: 'erotica' });
  });
});

describe('nomes e idiomas do catalogo', () => {
  test('autor: sobrenome primeiro e datas viram nome corrido', () => {
    expect(authorName('Stoker, Bram, 1847-1912')).toBe('Bram Stoker');
    expect(authorName('Assis, Machado de, 1839-1908')).toBe('Machado de Assis');
    expect(authorName('Vieira, Afonso Lopes, 1878-1946 [Commentator]')).toBe('Afonso Lopes Vieira');
    expect(authorName('Homer')).toBe('Homer');
  });

  test('idioma: os tres jeitos de escrever viram o mesmo codigo', () => {
    expect(['por', 'pt', 'Portuguese'].map(normalizeLanguage)).toEqual(['pt', 'pt', 'pt']);
    expect(normalizeLanguage('English')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('unknown');
  });
});

describe('abrir um livro', () => {
  test('baixa o EPUB enxuto uma vez, corta em capitulos e devolve paragrafos', async () => {
    const urls = fakeArchive();
    const detail = await gutenberg.series('dracula45839gut');
    expect(detail.title).toBe('O Livro de Teste');
    expect(detail.authors).toEqual(['Bram Stoker']);
    expect(detail.cover).toBe('https://archive.org/download/dracula45839gut/pg45839.cover.medium.jpg');
    expect(detail.chapters.length).toBeGreaterThan(0);
    expect(detail.chapters.every((c) => c.text && c.provider === 'gutenberg')).toBe(true);
    // a versao sem ilustracoes: o leitor de texto nao mostra imagem, e ela baixa mais rapido
    expect(urls.some((u) => u.endsWith('/pg45839.epub'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/pg45839-images.epub'))).toBe(false);

    const blocks = await gutenberg.book!(detail.chapters[0]!.id);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.text.trim())).toBe(true);

    // reabrir nao baixa de novo: o livro em dominio publico nao muda
    const before = urls.length;
    await gutenberg.series('dracula45839gut');
    await gutenberg.book!(detail.chapters[0]!.id);
    expect(urls.slice(before).some((u) => u.includes('/download/') || u.includes('us.archive.org'))).toBe(false);
  });

  test('item fora do acervo do Gutenberg e recusado antes de qualquer download', async () => {
    // a colecao aberta do Archive tem EPUB protegido enviado por usuario: o id sozinho nao pode puxa-lo
    const urls = fakeArchive({ collection: 'opensource' });
    await expect(gutenberg.series('livrodeoutro00001')).rejects.toThrow('nao pertence ao acervo');
    expect(urls.some((u) => u.includes('/download/'))).toBe(false);
  });

  test('redirect do download para fora do Archive nao e seguido', async () => {
    const urls = fakeArchive({
      download: (url) =>
        url.startsWith('https://archive.org/download/')
          ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
          : new Response('segredo', { status: 200 }),
    });
    await expect(gutenberg.series('outrolivro00002gut')).rejects.toThrow('fora do acervo');
    expect(urls.some((u) => u.includes('169.254'))).toBe(false);
  });

  test('pagina de erro com status 200 nao vira EPUB no cache', async () => {
    fakeArchive({ download: () => new Response('<html>manutencao</html>', { status: 200 }) });
    await expect(gutenberg.series('maisumlivro00003gut')).rejects.toThrow('EPUB valido');
  });

  test('identificador com caminho ou capitulo com indice invalido sao recusados', async () => {
    fakeArchive();
    await expect(gutenberg.series('../../etc/passwd')).rejects.toThrow('invalido');
    await expect(gutenberg.book!('x.y')).rejects.toThrow();
    const detail = await gutenberg.series('dracula45839gut');
    const [id] = detail.chapters[0]!.id.split('.');
    await expect(gutenberg.book!(`${id}.${Buffer.from('999').toString('base64url')}`)).rejects.toThrow('inexistente');
  });
});
