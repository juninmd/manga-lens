import { describe, expect, test } from 'bun:test';
import { lensSource } from '../src/client/lens.ts';

describe('lente: recorte ampliado', () => {
  const rect = { left: 100, top: 50, width: 400, height: 600 };
  const natural = { w: 800, h: 1200 };

  test('centra no ponto, em pixels da imagem original', () => {
    const { sx, sy, size } = lensSource(rect, natural, { x: 300, y: 350 }, 2, 200);
    // 200 px de lupa a 2x = 100 px de tela = 200 px da imagem (exibida pela metade)
    expect(size).toBe(200);
    expect(sx + size / 2).toBe(400);
    expect(sy + size / 2).toBe(600);
  });

  test('mais aumento, recorte menor', () => {
    const a = lensSource(rect, natural, { x: 300, y: 350 }, 1.5);
    const b = lensSource(rect, natural, { x: 300, y: 350 }, 3);
    expect(b.size).toBeLessThan(a.size);
    expect(a.size / b.size).toBe(2);
  });
});
