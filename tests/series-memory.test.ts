import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { contextFor, forget, MAX_GLOSSARY, memorySummary, NOTES_IN_PROMPT, remember } from '../src/server/series-memory.ts';

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
