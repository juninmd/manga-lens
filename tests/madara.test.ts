import { describe, expect, test } from 'bun:test';
import { ratingOf } from '../src/server/providers/madara.ts';

/** Trecho real do card do MangaRead, com as estrelas antes do numero. */
const card = (score: string): string =>
  `<div class="post-total-rating "><i class="ion-ios-star ratings_stars rating_current"></i>` +
  `<i class="ion-ios-star-half ratings_stars rating_current_half"></i>` +
  `<span class="score font-meta total_votes">${score}</span></div>`;

describe('nota do Madara', () => {
  test('sobe da escala 0-5 do site para a 0-10 do catalogo', () => {
    // sem normalizar, uma obra bem avaliada no MangaRead (4.1) apareceria pior
    // que uma mediana do MangaDex, que ja' publica de 0 a 10
    expect(ratingOf(card('3.3'))).toBe(6.6);
    expect(ratingOf(card('4.1'))).toBe(8.2);
    expect(ratingOf(card('5'))).toBe(10);
  });

  test('nota zero e ninguem votou, nao obra pessima', () => {
    expect(ratingOf(card('0'))).toBeUndefined();
    expect(ratingOf(card('0.0'))).toBeUndefined();
  });

  test('card sem bloco de nota nao inventa valor', () => {
    expect(ratingOf('<div class="row c-tabs-item__content"><h3>Naruto</h3></div>')).toBeUndefined();
    expect(ratingOf('')).toBeUndefined();
  });

  test('lixo no lugar do numero nao vira NaN no card', () => {
    expect(ratingOf('<span class="score total_votes">sem nota</span>')).toBeUndefined();
  });

  test('site que publica fora da escala nao estoura o teto', () => {
    expect(ratingOf(card('9.9'))).toBe(10);
  });

  test('arredonda para uma casa, como o MangaDex', () => {
    expect(ratingOf(card('3.33'))).toBe(6.7);
    expect(String(ratingOf(card('4.25')))).toBe('8.5');
  });
});
