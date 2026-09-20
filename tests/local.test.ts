import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { config } from '../src/server/config.ts';
import { assertInsideLibrary, decodePath, encodePath, local, localBookBlocks, localPagePaths } from '../src/server/providers/local.ts';
import { enabledProviders } from '../src/server/providers/index.ts';
import { readRarEntry, readRarIndex } from '../src/server/rar.ts';
import { pdfPageImage, pdfPageText } from '../src/server/pdf.ts';

const box = await mkdtemp(join(tmpdir(), 'manga-lens-local-'));
const root = join(box, 'biblioteca');
const solta = join(root, 'HQ Solta', 'Capitulo 01');
const cbz = join(root, 'Manga Teste', 'Capitulo 01.cbz');
const cbr = join(root, 'HQ Em Cbr', 'Capitulo 01.cbr');
const pdf = join(root, 'Livro Em Pdf.pdf');
const epub = join(root, 'Livro Em Epub.epub');
const saved = [...config.localRoots];

/** CBZ minimo: uma entrada de imagem, uma de lixo e uma pasta. */
function buildCbz(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const raw = Buffer.from(`dados de ${name}`, 'utf8');
    const payload = deflateRawSync(raw);
    const nb = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nb.length, 26);
    locals.push(local, nb, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nb.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nb);
    offset += 30 + nb.length + payload.length;
  }
  const cen = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, eocd]);
}

beforeAll(async () => {
  await mkdir(solta, { recursive: true });
  await mkdir(join(root, 'Manga Teste'), { recursive: true });
  // ordem natural: "10" tem de vir depois de "2", nao antes como no ASCII
  for (const n of ['1.png', '2.jpg', '10.webp']) await writeFile(join(solta, n), 'x');
  await writeFile(join(solta, 'leiame.txt'), 'nao e pagina');
  await writeFile(cbz, buildCbz(['cap/', '001.jpg', '010.png', '002.jpeg', 'ComicInfo.xml']));
  // CBR de verdade (RAR5 store, 3 PNGs) — CBR nao da' para forjar com zlib como o CBZ
  await mkdir(join(root, 'HQ Em Cbr'), { recursive: true });
  await copyFile(join(import.meta.dir, 'fixtures', 'comic.cbr'), cbr);
  await copyFile(join(import.meta.dir, 'fixtures', 'livro.pdf'), pdf);
  await copyFile(join(import.meta.dir, 'fixtures', 'livro.epub'), epub);
  // vizinho com o mesmo prefixo do root: nao pode ser considerado "dentro"
  await mkdir(join(box, 'biblioteca-alheia'), { recursive: true });
  await writeFile(join(box, 'segredo.txt'), 'top secret');
  config.localRoots.splice(0, config.localRoots.length, root);
});

afterAll(async () => {
  config.localRoots.splice(0, config.localRoots.length, ...saved);
  await rm(box, { recursive: true, force: true });
});

describe('token de caminho', () => {
  test('ida e volta preserva acento e separador', () => {
    const p = join(root, 'Coleção — nº 3', 'Capítulo 01.cbz');
    expect(decodePath(encodePath(p))).toBe(p);
  });

  test('token e base64url (cabe na query sem escape)', () => {
    expect(encodePath(root)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('assertInsideLibrary', () => {
  test('caminho dentro da biblioteca passa e volta absoluto', () => {
    expect(assertInsideLibrary(join(solta, '1.png'))).toBe(resolve(solta, '1.png'));
  });

  test('a propria raiz e permitida', () => {
    expect(assertInsideLibrary(root)).toBe(resolve(root));
  });

  test('travessia com .. e recusada', () => {
    expect(() => assertInsideLibrary(join(root, '..', 'segredo.txt'))).toThrow('fora da biblioteca');
    expect(() => assertInsideLibrary(join(root, 'a', '..', '..', 'segredo.txt'))).toThrow('fora da biblioteca');
  });

  test('caminho absoluto de fora e recusado', () => {
    expect(() => assertInsideLibrary('C:\\Windows\\win.ini')).toThrow('fora da biblioteca');
    expect(() => assertInsideLibrary('/etc/passwd')).toThrow('fora da biblioteca');
  });

  test('pasta irma com a raiz como prefixo e recusada', () => {
    // "…/biblioteca-alheia" comeca com "…/biblioteca": sem exigir o separador
    // essa pasta entraria na biblioteca de graca
    expect(() => assertInsideLibrary(join(box, 'biblioteca-alheia', 'x.jpg'))).toThrow('fora da biblioteca');
  });

  test('sem LOCAL_LIBRARY configurada nada e liberado', () => {
    const backup = [...config.localRoots];
    config.localRoots.length = 0;
    try {
      expect(() => assertInsideLibrary(join(root, '1.png'))).toThrow('fora da biblioteca');
    } finally {
      config.localRoots.splice(0, config.localRoots.length, ...backup);
    }
  });
});

describe('localPagePaths', () => {
  test('pasta: so imagens, em ordem natural', async () => {
    const out = await localPagePaths(encodePath(solta));
    expect(out.kind).toBe('dir');
    expect(out.names).toEqual(['1.png', '2.jpg', '10.webp']);
  });

  test('CBZ: so imagens, em ordem natural, sem entrada de pasta nem metadados', async () => {
    const out = await localPagePaths(encodePath(cbz));
    expect(out.kind).toBe('zip');
    expect(out.names).toEqual(['001.jpg', '002.jpeg', '010.png']);
  });

  test('token apontando para fora da biblioteca e recusado antes de tocar o disco', async () => {
    expect(localPagePaths(encodePath(join(box, 'segredo.txt')))).rejects.toThrow('fora da biblioteca');
  });

  test('token com travessia e recusado', async () => {
    expect(localPagePaths(encodePath(join(root, '..', 'segredo.txt')))).rejects.toThrow('fora da biblioteca');
  });
});

describe('CBR (HQ em RAR)', () => {
  test('as paginas saem na ordem natural, so imagens', async () => {
    const { kind, names } = await localPagePaths(encodePath(cbr));
    expect(kind).toBe('rar');
    expect(names).toEqual(['p01.png', 'p02.png', 'p03.png']);
  });

  test('o indice ignora diretorio e informa entrada com senha', async () => {
    const entries = await readRarIndex(cbr);
    expect(entries.map((e) => e.name)).toEqual(['p01.png', 'p02.png', 'p03.png']);
    expect(entries.every((e) => !e.encrypted)).toBe(true);
  });

  test('extrair devolve o PNG inteiro e independente do heap do WASM', async () => {
    const um = await readRarEntry(cbr, 'p01.png');
    // assinatura PNG: extrair errado aqui daria pagina quebrada no leitor
    expect(Array.from(um.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const copia = [...um];
    // a segunda extracao reusa o heap do unrar: se a primeira fosse uma view, mudaria aqui
    await readRarEntry(cbr, 'p02.png');
    expect([...um]).toEqual(copia);
  });

  test('pagina que nao existe falha dizendo qual', async () => {
    await expect(readRarEntry(cbr, 'nao-existe.png')).rejects.toThrow('nao-existe.png');
  });

  test('arquivo trocado no disco nao continua servindo o antigo', async () => {
    // o CBR fica inteiro em memoria num slot: sem carimbo de mtime/tamanho, salvar
    // outra versao do capitulo na mesma pasta seguiria abrindo as paginas velhas
    expect((await readRarIndex(cbr)).map((e) => e.name)).toEqual(['p01.png', 'p02.png', 'p03.png']);
    await copyFile(join(import.meta.dir, 'fixtures', 'comic-trocado.cbr'), cbr);
    expect((await readRarIndex(cbr)).map((e) => e.name)).toEqual(['capa.png', 'fim.png']);
  });
});

describe('classificacao de HQ x manga na biblioteca local', () => {
  test('CBR sem ComicInfo entra como HQ e em LTR', async () => {
    // manga circula em CBZ, HQ ocidental em CBR: `type: 'comic'` e' o que o
    // leitor le para abrir da esquerda para a direita
    const detail = await local.series(encodePath(cbr));
    expect(detail.contentType).toBe('hq');
    expect(detail.type).toBe('comic');
    expect(detail.origin).toBe('en');
  });

  test('CBZ com ComicInfo incompleto NAO vira HQ', async () => {
    // a fixture tem um ComicInfo.xml que nao declara `Manga`: sem isso o CBZ
    // caia na aba de HQ e abria em LTR
    const detail = await local.series(encodePath(join(root, 'Manga Teste')));
    expect(detail.contentType ?? 'manga').toBe('manga');
    expect(detail.type).not.toBe('comic');
  });
});

describe('PDF na biblioteca local', () => {
  test('cada pagina do PDF vira uma pagina do leitor', async () => {
    const { kind, names } = await localPagePaths(encodePath(pdf));
    expect(kind).toBe('pdf');
    expect(names).toEqual(['1.png']);
  });

  test('a pagina sai como PNG com os pixels do PDF', async () => {
    const png = await pdfPageImage(pdf, 0);
    expect(png).not.toBeNull();
    // assinatura PNG: sem canvas no servidor, a codificacao e' nossa e precisa provar que fecha
    expect(Array.from(png!.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR: 40x60, 8 bits, tipo 2 (RGB) — o mesmo bitmap embutido no PDF
    const view = new DataView(png!.buffer, png!.byteOffset);
    expect(view.getUint32(16)).toBe(40);
    expect(view.getUint32(20)).toBe(60);
    expect(png![24]).toBe(8);
    expect(png![25]).toBe(2);
  });

  test('pagina fora do intervalo devolve null, nao estoura', async () => {
    expect(await pdfPageImage(pdf, 99)).toBeNull();
    expect(await pdfPageText(pdf, 99)).toBe('');
  });

  test('o texto nativo da pagina sai legivel (base do leitor de livro)', async () => {
    expect(await pdfPageText(pdf, 0)).toContain('Pagina de teste');
  });

  test('PDF entra na aba Livro e em LTR', async () => {
    const detail = await local.series(encodePath(pdf));
    expect(detail.contentType).toBe('livro');
    expect(detail.type).toBe('comic');
    expect(detail.chapters).toHaveLength(1);
  });
});

describe('EPUB na biblioteca local', () => {
  test('o spine vira a lista de capitulos, com titulo e autor do proprio arquivo', async () => {
    const detail = await local.series(encodePath(epub));
    expect(detail.title).toBe('O Livro de Teste');
    expect(detail.authors).toEqual(['Maria Autora']);
    expect(detail.contentType).toBe('livro');
    // `type: 'book'` e' o que separa o EPUB do PDF: um abre no leitor de texto, o outro em paginas
    expect(detail.type).toBe('book');
    // o capitulo com linear="no" (notas da editora) fica fora do fio principal
    expect(detail.chapters).toHaveLength(2);
    expect(detail.chapters.every((c) => c.text)).toBe(true);
  });

  test('o capitulo devolve paragrafos prontos para o tradutor', async () => {
    const detail = await local.series(encodePath(epub));
    const blocks = await localBookBlocks(detail.chapters[0]!.id);
    expect(blocks[0]).toEqual({ id: 0, text: 'Chapter One' });
    expect(blocks.map((b) => b.text)).toContain('Café & jornal <velho>.');
    // <script> nao e' texto do livro; paragrafo vazio nao vira bloco
    expect(blocks.some((b) => b.text.includes('nao e texto'))).toBe(false);
  });

  test('capitulo de livro le apenas de dentro da biblioteca e apenas de EPUB', async () => {
    const fora = `${encodePath(join(box, 'segredo.txt'))}.${encodePath('x')}`;
    expect(localBookBlocks(fora)).rejects.toThrow('fora da biblioteca');
    // token de pagina (PDF) nao vira token de livro
    expect(localBookBlocks(`${encodePath(pdf)}.${encodePath('x')}`)).rejects.toThrow('nao pertence a um livro');
  });

  test('a capa do EPUB e a unica pagina que a grade pede', async () => {
    const { kind, names } = await localPagePaths(encodePath(epub));
    expect(kind).toBe('zip');
    expect(names).toEqual(['OEBPS/images/capa.png']);
  });
});

describe('abas do catalogo', () => {
  test('a biblioteca local nao sai da aba pelo tipo declarado do provider', () => {
    // o provider local se declara 'manga', mas o acervo e' misto: filtra-lo por
    // esse rotulo escondia CBR e PDF/EPUB das abas HQ e Livro, que ficavam vazias
    for (const tipo of ['manga', 'hq', 'livro'] as const) {
      expect(enabledProviders(tipo).map((p) => p.id)).toContain('local');
    }
  });

  test('numa aba especifica o corte por tipo vem antes da paginacao', async () => {
    const livros = await local.search({ contentType: 'livro', limit: 24 });
    // o EPUB entra na grade com o titulo do OPF, nao com o nome do arquivo
    expect(livros.items.map((c) => c.title).sort()).toEqual(['Livro Em Pdf', 'O Livro de Teste']);
    // `total` tem de contar o que a aba mostra, nao o acervo inteiro
    expect(livros.total).toBe(2);
    const hqs = await local.search({ contentType: 'hq', limit: 24 });
    expect(hqs.items.map((c) => c.title)).toEqual(['HQ Em Cbr']);
  });
});
