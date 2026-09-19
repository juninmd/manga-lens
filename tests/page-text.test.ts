import { describe, expect, test } from 'bun:test';
import { collapseRepeats, MAX_BLOCK_CHARS, MAX_BLOCKS, readingOrder, sanitizeBlocks } from '../src/server/page-text.ts';

describe('collapseRepeats', () => {
  test('OCR em loop vira no maximo tres repeticoes (nao queima tokens do LLM)', () => {
    expect(collapseRepeats('●'.repeat(500))).toBe('●●●');
    expect(collapseRepeats('ha'.repeat(40))).toBe('hahaha');
  });

  test('onomatopeia e texto normal continuam legiveis', () => {
    expect(collapseRepeats('AAAAAAAH!')).toBe('AAAH!');
    expect(collapseRepeats('ドドドドドド')).toBe('ドドド');
    expect(collapseRepeats('I will not lose!')).toBe('I will not lose!');
    expect(collapseRepeats('TOO GOOD')).toBe('TOO GOOD');
  });

  test('bloco gigante e cortado', () => {
    expect(collapseRepeats('abcdefghij '.repeat(100)).length).toBe(MAX_BLOCK_CHARS);
  });
});

describe('sanitizeBlocks', () => {
  test('recusa corpo que nao e lista de blocos validos', () => {
    const dup = [{ id: 1, text: 'a' }, { id: 1, text: 'b' }];
    for (const raw of [undefined, 'x', [], [{ id: 1.5, text: 'a' }], [{ id: 1 }], [{ id: 1, text: 2 }], [null], dup]) {
      expect(sanitizeBlocks(raw)).toBeNull();
    }
    expect(sanitizeBlocks(Array.from({ length: MAX_BLOCKS + 1 }, (_, id) => ({ id, text: 'a' })))).toBeNull();
  });

  test('mantem caixa valida e descarta caixa quebrada sem recusar o bloco', () => {
    const out = sanitizeBlocks([
      { id: 0, text: 'ok', x: 10, y: 20, w: 30, h: 40 },
      { id: 1, text: 'sem area', x: 10, y: 20, w: 0, h: 40 },
      { id: 2, text: 'nan', x: Number.NaN, y: 1, w: 1, h: 1 },
    ]);
    expect(out).toEqual([
      { id: 0, text: 'ok', x: 10, y: 20, w: 30, h: 40 },
      { id: 1, text: 'sem area' },
      { id: 2, text: 'nan' },
    ]);
  });
});

describe('readingOrder', () => {
  const box = (id: number, x: number, y: number, w = 100, h = 80) => ({ id, text: String(id), x, y, w, h });

  test('manga (RTL): na mesma faixa, o balao da direita e lido primeiro', () => {
    // o da esquerda esta' 6 px mais alto: ordenar por y invertia a conversa
    const blocks = [box(0, 50, 100), box(1, 500, 106), box(2, 300, 400)];
    expect(readingOrder(blocks, true).map((b) => b.id)).toEqual([1, 0, 2]);
  });

  test('HQ (LTR): esquerda antes da direita', () => {
    const blocks = [box(0, 500, 100), box(1, 50, 104)];
    expect(readingOrder(blocks, false).map((b) => b.id)).toEqual([1, 0]);
  });

  test('balao que so encosta na faixa de cima vai para a linha seguinte', () => {
    const blocks = [box(0, 50, 0, 100, 100), box(1, 500, 90, 100, 100)];
    expect(readingOrder(blocks, true).map((b) => b.id)).toEqual([0, 1]);
  });

  test('sem posicao em algum bloco, preserva a ordem recebida', () => {
    const blocks = [{ id: 3, text: 'a' }, box(1, 0, 0)];
    expect(readingOrder(blocks, true).map((b) => b.id)).toEqual([3, 1]);
  });
});
