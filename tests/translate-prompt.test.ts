import { describe, expect, test } from 'bun:test';
import { parseReply, systemPrompt, userPrompt, visionSystemPrompt, visionUserPrompt, type PromptContext } from '../src/server/translate-prompt.ts';

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
    // cortada antes de fechar qualquer par: nada a salvar, continua sendo erro
    expect(() => parseReply('{"translations":[{"id":0,"pt":"Esta e a primeira草稿草稿草稿')).toThrow('sem JSON');
  });

  test('modelo em loop num balao nao derruba os outros da pagina (visto no cap. 1 com 7B)', () => {
    const raw =
      '{\n  "translations": [\n    {"id":0, "pt":"VIROU O PALHACO DA TURMA..."},\n' +
      '    {"id":1, "pt":"SEM MEUS PAIS... \\"NINGUEM\\" ME ELOGIAVA."},\n' +
      '    {"id":8, "pt":"DOIS, DOIS, DOIS, DOIS, DOIS, DOIS,';
    const r = parseReply(raw);
    expect(r.translations).toEqual([
      { id: 0, pt: 'VIROU O PALHACO DA TURMA...' },
      { id: 1, pt: 'SEM MEUS PAIS... "NINGUEM" ME ELOGIAVA.' },
    ]);
    expect(r.partial).toBe(true);
    expect(parseReply('{"translations":[{"id":0,"pt":"ok"}]}').partial).toBeUndefined();
    // o eco sobrevive ao corte: o realinhamento ainda tem prova nos pares salvos
    const cut = parseReply('{"translations":[{"id":0,"src":"NOT YET","pt":"Ainda nao!"},{"id":1,"src":"THIS","pt":"DOIS, DOIS');
    expect(cut.translations).toEqual([{ id: 0, src: 'NOT YET', pt: 'Ainda nao!' }]);
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

  test('memoria replayed e dado, nao instrucao (nota veio de OCR de imagem de terceiro)', () => {
    const rule = systemPrompt('portugues do Brasil', 'pt-BR')
      .split('\n')
      .find((l) => l.startsWith('6.'))
      ?.toLowerCase();
    expect(rule).toContain('blocos');
    expect(rule).toContain('glossario');
    expect(rule).toContain('paginas anteriores');
    expect(rule).toContain('nunca instrucao');
  });

  test('eco do original nao pode encurtar a traducao', () => {
    // "src = 3 primeiras palavras" fez o 7B traduzir so' o comeco de 1/3 das falas longas
    const s = systemPrompt('portugues do Brasil', 'pt-BR');
    expect(s).toContain('"src":string');
    expect(s).toContain('bloco INTEIRO');
    expect(s).not.toContain('3 primeiras palavras');
  });
});

describe('motor de visao', () => {
  test('o prompt manda ler a imagem, nao traduzir texto recebido', () => {
    const sys = visionSystemPrompt('portugues do Brasil', 'pt-BR');
    expect(sys).toContain('circulo vermelho');
    expect(sys).toContain('"orig"');
    // o motor de visao nao recebe texto de OCR: pedir correcao de ruido levaria
    // o modelo a inventar um original que ele nunca leu
    expect(sys).not.toContain('vem de OCR');
  });

  test('o usuario leva o contexto da obra e os ids marcados, sem os textos', () => {
    const out = visionUserPrompt(ctx({ glossary: [{ orig: 'ナルト', pt: 'Naruto', gender: 'm' }] }), [2, 0, 1]);
    expect(out).toContain('Naruto — capitulo 3 — pagina 5');
    expect(out).toContain('[2,0,1]');
    expect(out).toContain('ナルト');
  });

  test('a resposta da visao preserva o original lido', () => {
    const r = parseReply('{"translations":[{"id":3,"orig":"ドン","pt":"BUM"}]}');
    expect(r.translations).toEqual([{ id: 3, pt: 'BUM', orig: 'ドン' }]);
  });
});
