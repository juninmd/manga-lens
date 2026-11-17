import { describe, expect, test } from 'bun:test';
import type { OcrBlock } from '../src/client/ocr.ts';
import { isSoundEffect, speakablePage } from '../src/client/reader-speech.ts';

const block = (id: number, x: number, y: number, text: string, pt?: string): OcrBlock =>
  ({ id, x, y, w: 100, h: 60, text, pt, confidence: 90 }) as OcrBlock;

describe('voz nos baloes do manga', () => {
  test('ordem RTL: direita antes da esquerda na mesma faixa', () => {
    const items = speakablePage([block(1, 10, 10, 'a', 'Esquerda.'), block(2, 400, 10, 'b', 'Direita.')], true);
    expect(items.map((i) => i.text)).toEqual(['Direita.', 'Esquerda.']);
  });

  test('ordem LTR para HQ', () => {
    const items = speakablePage([block(1, 10, 10, 'a', 'Esquerda.'), block(2, 400, 10, 'b', 'Direita.')], false);
    expect(items.map((i) => i.index)).toEqual([1, 2]);
  });

  test('sem traducao nao le, a menos que permitido', () => {
    expect(speakablePage([block(1, 0, 0, 'Hello there')], false)).toEqual([]);
    expect(speakablePage([block(1, 0, 0, 'Hello there')], false, true)[0]?.text).toBe('Hello there');
  });

  test('onomatopeia fica de fora', () => {
    expect(isSoundEffect('BAM!')).toBe(true);
    expect(isSoundEffect('...')).toBe(true);
    expect(isSoundEffect('Não!')).toBe(false);
    expect(isSoundEffect('Vamos embora daqui.')).toBe(false);
    const items = speakablePage([block(1, 0, 0, 'x', 'BOOM!'), block(2, 0, 200, 'y', 'Corre!')], false);
    expect(items.map((i) => i.text)).toEqual(['Corre!']);
  });
});
