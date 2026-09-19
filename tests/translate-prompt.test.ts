import { describe, expect, test } from 'bun:test';
import { parseReply, systemPrompt, userPrompt, type PromptContext } from '../src/server/translate-prompt.ts';

const ctx = (over: Partial<PromptContext> = {}): PromptContext => ({
  series: 'Naruto',
  chapter: '3',
  page: 4,
  sourceName: 'japones',
  glossary: [],
  notes: [],
  neighbours: [],
  withImage: false,
  ...over,
});

describe('parseReply', () => {
  test('objeto novo traz traducao, glossario e nota', () => {
    const r = parseReply('```json\n{"translations":[{"id":0,"pt":"Oi"}],"glossary":[{"orig":"a","pt":"A"}],"note":"n"}\n```');
    expect(r).toEqual({ translations: [{ id: 0, pt: 'Oi' }], glossary: [{ orig: 'a', pt: 'A' }], note: 'n' });
  });

  test('modelo que ignora o formato e devolve o array antigo nao perde a traducao', () => {
    expect(parseReply('Aqui: [{"id":2,"pt":"Bom dia"}]')).toEqual({ translations: [{ id: 2, pt: 'Bom dia' }] });
  });

  test('itens sem id inteiro ou sem texto sao descartados', () => {
    const r = parseReply('{"translations":[{"id":"0","pt":"x"},{"id":1},{"id":2,"pt":"ok"}]}');
    expect(r.translations).toEqual([{ id: 2, pt: 'ok' }]);
  });

  test('resposta sem JSON vira erro explicito', () => {
    expect(() => parseReply('desculpe, nao posso')).toThrow('sem JSON');
  });
});

describe('prompts', () => {
  test('glossario, paginas anteriores e posicao entram no pedido', () => {
    const p = userPrompt(
      ctx({
        glossary: [{ orig: 'サクラ', pt: 'Sakura', gender: 'f' }],
        notes: [{ chapter: '3', page: 3, note: 'Sakura chega atrasada.' }],
      }),
      [{ id: 0, text: 'おそい！' }],
    );
    expect(p).toContain('Naruto — capitulo 3 — pagina 5');
    expect(p).toContain('{"orig":"サクラ","pt":"Sakura","gender":"f"}');
    expect(p).toContain('cap. 3 pag. 4: Sakura chega atrasada.');
    expect(p).toContain('[{"id":0,"text":"おそい！"}]');
    expect(p).not.toContain('Outros baloes');
  });

  test('lote partido mostra os vizinhos como contexto somente leitura', () => {
    const p = userPrompt(ctx({ neighbours: [{ id: 9, text: 'antes', x: 1 }] }), [{ id: 0, text: 'depois' }]);
    expect(p).toContain('NAO traduza): [{"id":9,"text":"antes"}]');
  });

  test('regra de genero e tom pt-BR so para pt-BR', () => {
    expect(systemPrompt('portugues do Brasil', 'pt-BR')).toContain('construcao neutra');
    expect(systemPrompt('portugues do Brasil', 'pt-BR')).toContain('Conto com voce!');
    expect(systemPrompt('ingles', 'en')).not.toContain('Conto com voce!');
  });
});
