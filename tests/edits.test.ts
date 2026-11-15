import { describe, expect, test } from 'bun:test';
import { createEditStore, editKey, MAX_EDIT_CHARS, MAX_EDITS, type EditScope } from '../src/client/edits.ts';

/** localStorage de mentira: o modulo so' usa getItem/setItem */
function memoryStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const scope: EditScope = { provider: 'local', seriesId: 's', chapterId: 'c1', page: 2, target: 'pt-BR' };

describe('correcao manual de balao', () => {
  test('vale para o mesmo texto original mesmo com espaco e caixa diferentes', () => {
    const store = createEditStore(memoryStorage());
    store.set(scope, 'THEN I WILL\nGO TONIGHT.', 'Entao eu vou hoje a noite.');
    expect(store.get(scope, 'then i will go tonight.')).toBe('Entao eu vou hoje a noite.');
    // outra pagina, outro capitulo ou outro idioma: outra traducao
    expect(store.get({ ...scope, page: 3 }, 'THEN I WILL GO TONIGHT.')).toBeUndefined();
    expect(store.get({ ...scope, target: 'en' }, 'THEN I WILL GO TONIGHT.')).toBeUndefined();
  });

  test('aplicar troca so os baloes corrigidos e marca como editados', () => {
    const store = createEditStore(memoryStorage());
    store.set(scope, 'HELLO?', 'Oi? Tem alguem ai?');
    store.set(scope, 'CRASH', '');
    const page: { text: string; pt: string; edited?: boolean }[] = [
      { text: 'HELLO?', pt: 'OLA?' },
      { text: 'WHO ARE YOU?', pt: 'QUEM E VOCE?' },
      { text: 'CRASH', pt: 'CRASH' },
    ];
    expect(store.apply(scope, page)).toEqual([
      { text: 'HELLO?', pt: 'Oi? Tem alguem ai?', edited: true },
      { text: 'WHO ARE YOU?', pt: 'QUEM E VOCE?' },
      // vazio = deixar a arte original: o letreiramento pula balao sem traducao
      { text: 'CRASH', pt: '', edited: true },
    ]);
  });

  test('sobrevive a reabrir o app; remover volta a traducao automatica', () => {
    const storage = memoryStorage();
    createEditStore(storage).set(scope, 'HELLO?', 'Oi?');
    const reopened = createEditStore(storage);
    expect(reopened.get(scope, 'HELLO?')).toBe('Oi?');
    reopened.remove(scope, 'HELLO?');
    expect(createEditStore(storage).get(scope, 'HELLO?')).toBeUndefined();
  });

  test('tamanho e quantidade tem teto; as correcoes mais antigas saem primeiro', () => {
    const storage = memoryStorage();
    const store = createEditStore(storage);
    store.set(scope, 'LONG', 'x'.repeat(5000));
    expect(store.get(scope, 'LONG')).toHaveLength(MAX_EDIT_CHARS);
    for (let i = 0; i <= MAX_EDITS; i++) store.set({ ...scope, page: i }, `fala ${i}`, `t${i}`);
    const saved = JSON.parse(storage.data.get('manga-lens:edits:v1')!) as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(MAX_EDITS);
    expect(saved[editKey(scope, 'LONG')]).toBeUndefined();
  });

  test('armazenamento corrompido ou indisponivel nao derruba o leitor', () => {
    const broken = { getItem: () => '{nao e json', setItem: () => { throw new Error('cota'); } };
    const store = createEditStore(broken);
    expect(store.get(scope, 'x')).toBeUndefined();
    expect(() => store.set(scope, 'x', 'y')).not.toThrow();
    expect(store.get(scope, 'x')).toBe('y');
    expect(createEditStore(undefined).apply(scope, [{ text: 'a', pt: 'b' }])).toEqual([{ text: 'a', pt: 'b' }]);
  });
});
