import { afterEach, describe, expect, test } from 'bun:test';
import { archive } from '../src/server/providers/archive.ts';
import { hostAllowed } from '../src/server/config.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Guarda a URL pedida e devolve os docs que o teste quiser. */
function stub(docs: { identifier: string; title: string }[]): { url: () => string } {
  let seen = '';
  globalThis.fetch = ((input: string | URL | Request) => {
    seen = String(input);
    return Promise.resolve(
      new Response(JSON.stringify({ response: { numFound: docs.length, docs } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { url: () => seen };
}

const queryOf = (url: string): string => decodeURIComponent(new URL(url).searchParams.get('q') ?? '');

describe('acervo de HQ em dominio publico', () => {
  test('a busca aceita apenas titulo da lista livre, e nunca franquia viva', async () => {
    const probe = stub([]);
    await archive.search({});
    const q = queryOf(probe.url());
    // o recorte de colecao sozinho devolve deposito aberto: o corte que importa
    // e' o titulo casar com uma serie sabidamente livre
    expect(q).toContain('collection:(comics OR folkscanomy OR fawcett-comics OR ace-comics)');
    expect(q).toContain('"Whiz Comics"');
    expect(q).toContain('"Adventures into the Unknown"');
    expect(q).toContain('NOT title:("spider-man"');
    // Pep Comics e Black Cat ficaram de fora de proposito (marca viva / colisao de nome)
    expect(q).not.toContain('"Pep Comics"');
    expect(q).not.toContain('"Black Cat"');
  });

  test('titulo protegido que o Archive devolve mesmo assim e descartado aqui', async () => {
    stub([
      { identifier: 'ok', title: 'Whiz Comics 022' },
      // o parser do Archive as vezes afrouxa o NOT; sem o corte final este card
      // entrava no catalogo
      { identifier: 'nao', title: 'Amazing Spider-Man 001' },
    ]);
    const { items } = await archive.search({});
    expect(items.map((i) => i.title)).toEqual(['Whiz Comics 022']);
  });

  test('a busca do usuario restringe a lista, nunca a substitui', async () => {
    const probe = stub([]);
    await archive.search({ q: 'batman' });
    const q = queryOf(probe.url());
    // termo do usuario entra como AND depois do recorte: procurar "batman" no
    // acervo livre tem de voltar vazio, nao abrir o deposito inteiro
    expect(q).toContain('"Whiz Comics"');
    expect(q).toContain('AND title:(batman)');
  });

  test('cada serie da lista e distintiva: nome de uma palavra so casaria com o acervo inteiro', async () => {
    const probe = stub([]);
    await archive.search({});
    const titles = [...queryOf(probe.url()).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const allowed = titles.filter((t) => !t.startsWith('spider') && !/^(x-men|avengers|batman|superman|wolverine|iron man|hulk|deadpool|justice league|daredevil|punisher|thor)$/i.test(t));
    // o casamento e' por substring; titulo de uma palavra generica arrastaria
    // centenas de itens sem relacao para dentro do catalogo
    const genericos = allowed.filter((t) => !t.includes(' ') && t.length < 8);
    expect(genericos).toEqual([]);
  });
});

describe('proxy de imagem do Archive', () => {
  test('o no que serve a pagina entra na allowlist junto com o dominio', () => {
    // /download/.../page/nN.jpg responde 302 para ia802800.us.archive.org, e a
    // allowlist vale a cada salto: sem o sufixo nenhuma pagina de HQ carregava
    expect(hostAllowed('archive.org')).toBe(true);
    expect(hostAllowed('ia802800.us.archive.org')).toBe(true);
    // o sufixo nao pode virar um curinga que aceite dominio parecido
    expect(hostAllowed('evilarchive.org')).toBe(false);
    expect(hostAllowed('archive.org.attacker.net')).toBe(false);
  });
});
