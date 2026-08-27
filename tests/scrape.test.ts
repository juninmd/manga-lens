import { describe, expect, test } from 'bun:test';
import { all, chunks, decodeEntities, first, stripTags } from '../src/server/scrape.ts';

describe('decodeEntities', () => {
  test('entidades nomeadas', () => {
    expect(decodeEntities('Tom &amp; Jerry &lt;b&gt; &quot;x&quot; &apos;y&apos;&nbsp;z')).toBe(
      `Tom & Jerry <b> "x" 'y' z`,
    );
  });

  test('entidades numericas decimais e hexadecimais', () => {
    expect(decodeEntities('&#65;&#x42;&#X43;')).toBe('ABC');
    expect(decodeEntities('&#8217;')).toBe('’');
  });

  test('entidade desconhecida fica literal', () => {
    expect(decodeEntities('&naoexiste; &amp')).toBe('&naoexiste; &amp');
  });

  test('entidade numerica invalida nao derruba o parser', () => {
    // HTML de provider vem quebrado; String.fromCodePoint lanca RangeError fora
    // do intervalo Unicode e isso levaria a busca inteira a 500
    expect(() => decodeEntities('&#x110000;')).not.toThrow();
    expect(() => decodeEntities('&#999999999;')).not.toThrow();
    expect(decodeEntities('ok &#x110000; fim')).toContain('ok');
  });
});

describe('stripTags', () => {
  test('remove marcacao, decodifica e apara', () => {
    expect(stripTags('  <p class="a">Naruto &amp; Sasuke</p>  ')).toBe('Naruto & Sasuke');
  });

  test('tag sem fechamento nao come o texto seguinte', () => {
    expect(stripTags('<span>oi</span> < mundo')).toBe('oi < mundo');
  });
});

describe('all', () => {
  test('coleta todas as ocorrencias mesmo sem a flag g', () => {
    const ms = all('<a>1</a><a>2</a><a>3</a>', /<a>(\d)<\/a>/);
    expect(ms.map((m) => m[1])).toEqual(['1', '2', '3']);
  });

  test('regex de casamento vazio nao entra em laco infinito', () => {
    const ms = all('abc', /x?/g);
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.length).toBeLessThan(10);
  });

  test('sem casamento devolve lista vazia', () => {
    expect(all('abc', /<a>/)).toEqual([]);
  });
});

describe('first', () => {
  test('devolve o primeiro grupo aparado', () => {
    expect(first('<h1>  Naruto  </h1>', /<h1>([^<]*)<\/h1>/)).toBe('Naruto');
  });

  test('sem casamento devolve indefinido', () => {
    expect(first('<h1>x</h1>', /<h2>([^<]*)<\/h2>/)).toBeUndefined();
  });
});

describe('chunks', () => {
  test('fatia um bloco por marcador, ate o fim do html', () => {
    const html = 'lixo<card>A</card><card>B</card>';
    const out = chunks(html, /<card>/g);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('<card>A</card>');
    expect(out[1]).toBe('<card>B</card>');
  });

  test('sem marcador devolve lista vazia (nao o html inteiro)', () => {
    expect(chunks('<div>A</div>', /<card>/g)).toEqual([]);
  });
});
