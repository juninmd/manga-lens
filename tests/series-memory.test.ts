import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { contextFor, forget, MAX_GLOSSARY, MAX_LOCKED, memorySummary, NOTES_IN_PROMPT, remember, removeTerm, setTerm } from '../src/server/series-memory.ts';

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-memory-'));
config.cacheDir = dir;
afterAll(() => rm(dir, { recursive: true, force: true }));

let seq = 0;
const fresh = (): string => `Obra ${++seq}`;

describe('memoria da obra', () => {
  test('so entram notas de paginas ANTERIORES — nada de spoiler da frente', async () => {
    const s = fresh();
    await remember(s, 'pt-BR', '2', 3, { note: 'cap 2 p4' });
    await remember(s, 'pt-BR', '3', 0, { note: 'cap 3 p1' });
    await remember(s, 'pt-BR', '3', 5, { note: 'cap 3 p6' });
    await remember(s, 'pt-BR', '4', 0, { note: 'cap 4 p1' });
    const { notes } = await contextFor(s, 'pt-BR', '3', 2);
    expect(notes.map((n) => n.note)).toEqual(['cap 2 p4', 'cap 3 p1']);
  });

  test('prompt leva so as ultimas notas, na ordem da historia', async () => {
    const s = fresh();
    for (let p = 9; p >= 0; p--) await remember(s, 'pt-BR', '1', p, { note: `p${p}` });
    const { notes } = await contextFor(s, 'pt-BR', '1', 10);
    expect(notes).toHaveLength(NOTES_IN_PROMPT);
    expect(notes.map((n) => n.note)).toEqual(['p5', 'p6', 'p7', 'p8', 'p9']);
  });

  test('fala inteira nao vira termo fixo do glossario (visto ao vivo com modelo 4B)', async () => {
    const s = fresh();
    await remember(s, 'pt-BR', '1', 0, {
      glossary: [
        { orig: 'EH?', pt: 'EH?', gender: '?' },
        { orig: 'WHO DO YOU THINK YOU ARE', pt: 'QUEM VOCE PENSA QUE E', gender: '?' },
        { orig: 'LORD HOKAGE... I', pt: 'LORDE HOKAGE... EU', gender: '?' },
        { orig: 'Lord Hokage', pt: 'Lorde Hokage', gender: 'm' },
        { orig: 'うずまきナルト', pt: 'Uzumaki Naruto', gender: 'm' },
        { orig: 'Kage Bunshin no Jutsu', pt: 'Jutsu Clones das Sombras', gender: '?' },
      ],
    });
    expect((await memorySummary(s, 'pt-BR')).glossary.map((g) => g.orig)).toEqual(['Lord Hokage', 'うずまきナルト', 'Kage Bunshin no Jutsu']);
  });

  test('retraduzir a mesma pagina substitui a nota em vez de duplicar', async () => {
    const s = fresh();
    await remember(s, 'pt-BR', '1', 0, { note: 'velha' });
    await remember(s, 'pt-BR', '1', 0, { note: 'nova' });
    expect((await memorySummary(s, 'pt-BR')).notes.map((n) => n.note)).toEqual(['nova']);
  });

  test('nome registrado nao muda de forma; genero so sai de "?"', async () => {
    const s = fresh();
    await remember(s, 'pt-BR', '1', 0, { glossary: [{ orig: 'ナルト', pt: 'Naruto', gender: '?' }] });
    await remember(s, 'pt-BR', '1', 1, { glossary: [{ orig: 'ナルト', pt: 'Narutinho', gender: 'm' }] });
    await remember(s, 'pt-BR', '1', 2, { glossary: [{ orig: 'ナルト', pt: 'Naruto', gender: 'f' }] });
    expect((await contextFor(s, 'pt-BR', '1', 3)).glossary).toEqual([{ orig: 'ナルト', pt: 'Naruto', gender: 'm' }]);
  });

  test('saida do modelo e podada: tamanho, controle, lixo e teto do glossario', async () => {
    const s = fresh();
    const many = Array.from({ length: MAX_GLOSSARY + 20 }, (_, i) => ({ orig: `n${i}`, pt: `N${i}` }));
    await remember(s, 'pt-BR', '1', 0, {
      glossary: [{ orig: 'A\u0000‮B', pt: 'x'.repeat(200), gender: 'robo' }, { orig: 42 }, null, ...many],
      note: 'y'.repeat(1000),
    });
    const mem = await memorySummary(s, 'pt-BR');
    expect(mem.glossary).toHaveLength(MAX_GLOSSARY);
    expect(mem.glossary[0]).toEqual({ orig: 'A B', pt: 'x'.repeat(40), gender: '?' });
    expect(mem.notes[0]!.note.length).toBe(240);
  });

  test('idioma de chegada separa glossarios; limpar apaga do disco', async () => {
    const s = fresh();
    await remember(s, 'pt-BR', '1', 0, { glossary: [{ orig: '先生', pt: 'Professor' }] });
    expect((await contextFor(s, 'en', '1', 1)).glossary).toEqual([]);
    expect((await readdir(join(dir, 'series-memory'))).length).toBeGreaterThan(0);
    await forget(s, 'pt-br');
    expect((await memorySummary(s, 'pt-BR')).glossary).toEqual([]);
  });

  test('paginas traduzidas ao mesmo tempo nao se atropelam', async () => {
    const s = fresh();
    await Promise.all(
      Array.from({ length: 8 }, (_, p) => remember(s, 'pt-BR', '1', p, { note: `p${p}`, glossary: [{ orig: `k${p}`, pt: `K${p}` }] })),
    );
    const mem = await memorySummary(s, 'pt-BR');
    expect(mem.notes).toHaveLength(8);
    expect(mem.glossary).toHaveLength(8);
  });
});

describe('glossario editado por quem le', () => {
  test('corrigir um termo o fixa: a IA nao muda mais forma nem genero', async () => {
    const s = fresh();
    // o caso real: erro de OCR aprendido e repetido no resto da obra
    await remember(s, 'pt-BR', '1', 0, { glossary: [{ orig: 'OCEMON FOX', pt: 'Raposa Ocemon', gender: '?' }] });
    await setTerm(s, 'pt-BR', { orig: 'DEMON FOX', pt: 'Raposa Demonio', gender: 'f', was: 'OCEMON FOX' });
    await remember(s, 'pt-BR', '1', 1, { glossary: [{ orig: 'Demon Fox', pt: 'Raposa do Mal', gender: 'm' }] });
    expect((await memorySummary(s, 'pt-BR')).glossary).toEqual([{ orig: 'DEMON FOX', pt: 'Raposa Demonio', gender: 'f', locked: true }]);
  });

  test('termo fixado com genero "?" continua "?": e decisao de quem le', async () => {
    const s = fresh();
    await setTerm(s, 'pt-BR', { orig: 'Haku', pt: 'Haku', gender: '?' });
    await remember(s, 'pt-BR', '1', 0, { glossary: [{ orig: 'Haku', pt: 'Haku', gender: 'f' }] });
    expect((await memorySummary(s, 'pt-BR')).glossary[0]!.gender).toBe('?');
  });

  test('fixados vao primeiro no prompt e nao disputam vaga com os aprendidos', async () => {
    const s = fresh();
    const many = Array.from({ length: MAX_GLOSSARY }, (_, i) => ({ orig: `n${i}`, pt: `N${i}` }));
    await remember(s, 'pt-BR', '1', 0, { glossary: many });
    await setTerm(s, 'pt-BR', { orig: 'Konoha', pt: 'Vila da Folha' });
    const { glossary } = await contextFor(s, 'pt-BR', '1', 1);
    expect(glossary).toHaveLength(MAX_GLOSSARY + 1);
    expect(glossary[0]).toEqual({ orig: 'Konoha', pt: 'Vila da Folha', gender: '?', locked: true });
  });

  test('renomear para um termo que ja existia nao deixa duas entradas', async () => {
    const s = fresh();
    await remember(s, 'pt-BR', '1', 0, { glossary: [{ orig: 'Sasuke', pt: 'Sasuke' }, { orig: 'Saske', pt: 'Saske' }] });
    await setTerm(s, 'pt-BR', { orig: 'Sasuke', pt: 'Sasuke', gender: 'm', was: 'Saske' });
    expect((await memorySummary(s, 'pt-BR')).glossary).toEqual([{ orig: 'Sasuke', pt: 'Sasuke', gender: 'm', locked: true }]);
  });

  test('remover apaga so aquele termo e diz se existia', async () => {
    const s = fresh();
    await remember(s, 'pt-BR', '1', 0, { glossary: [{ orig: 'Naruto', pt: 'Naruto' }, { orig: 'Kyuubi', pt: 'Kyuubi' }] });
    expect(await removeTerm(s, 'pt-BR', 'naruto')).toBe(true);
    expect(await removeTerm(s, 'pt-BR', 'naruto')).toBe(false);
    expect((await memorySummary(s, 'pt-BR')).glossary.map((g) => g.orig)).toEqual(['Kyuubi']);
  });

  test('termo vazio, texto de controle e excesso de fixados sao barrados', async () => {
    const s = fresh();
    await expect(setTerm(s, 'pt-BR', { orig: '  ', pt: 'x' })).rejects.toThrow('obrigatorios');
    await expect(setTerm(s, 'pt-BR', { orig: 'x', pt: 42 })).rejects.toThrow('obrigatorios');
    const saved = await setTerm(s, 'pt-BR', { orig: 'A\u0000\nB', pt: 'y'.repeat(200), gender: 'robo' });
    expect(saved).toEqual({ orig: 'A B', pt: 'y'.repeat(40), gender: '?', locked: true });
    for (let i = 1; i < MAX_LOCKED; i++) await setTerm(s, 'pt-BR', { orig: `t${i}`, pt: `T${i}` });
    await expect(setTerm(s, 'pt-BR', { orig: 'um a mais', pt: 'x' })).rejects.toThrow('fixados');
    // corrigir um que ja' existe continua valendo no teto
    await expect(setTerm(s, 'pt-BR', { orig: 't1', pt: 'Novo' })).resolves.toMatchObject({ pt: 'Novo' });
  });

  test('edicao manual e gravacao do modelo ao mesmo tempo nao se perdem', async () => {
    const s = fresh();
    await Promise.all([
      remember(s, 'pt-BR', '1', 0, { glossary: [{ orig: 'Iruka', pt: 'Iruka' }] }),
      setTerm(s, 'pt-BR', { orig: 'Hokage', pt: 'Hokage', gender: 'm' }),
      remember(s, 'pt-BR', '1', 1, { glossary: [{ orig: 'Mizuki', pt: 'Mizuki' }] }),
    ]);
    expect((await memorySummary(s, 'pt-BR')).glossary.map((g) => g.orig).sort()).toEqual(['Hokage', 'Iruka', 'Mizuki']);
  });
});
