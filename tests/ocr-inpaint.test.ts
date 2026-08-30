import { describe, expect, test } from 'bun:test';
import { diffusePixels } from '../src/client/ocr.ts';

/** Monta um RGBA w*h com uma cor solida, exceto um bloco central com outra. */
function makeImage(w: number, h: number, borderColor: [number, number, number], holeColor: [number, number, number], hole: { x: number; y: number; w: number; h: number }) {
  const data = new Uint8ClampedArray(w * h * 4);
  const unknown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const inHole = x >= hole.x && x < hole.x + hole.w && y >= hole.y && y < hole.y + hole.h;
      const [r, g, b] = inHole ? holeColor : borderColor;
      data[p * 4] = r;
      data[p * 4 + 1] = g;
      data[p * 4 + 2] = b;
      data[p * 4 + 3] = 255;
      if (inHole) unknown[p] = 1;
    }
  }
  return { data, unknown };
}

describe('diffusePixels — reconstrucao de fundo sob texto solto', () => {
  test('converge para a cor da moldura quando o fundo real e solido', () => {
    const w = 20;
    const h = 20;
    const { data, unknown } = makeImage(w, h, [200, 200, 200], [0, 0, 0], { x: 6, y: 6, w: 8, h: 8 });
    diffusePixels(data, w, h, unknown, 24);

    // pixel bem no centro do buraco converge na direcao da cor da moldura —
    // Jacobi e' lento no centro exato, mas nunca deveria sobrar perto do 0 original
    const cx = 10;
    const cy = 10;
    const p = (cy * w + cx) * 4;
    expect(data[p]).toBeGreaterThan(100);
    expect(data[p + 1]).toBeGreaterThan(100);
    expect(data[p + 2]).toBeGreaterThan(100);
  });

  test('reconstroi um gradiente em vez de achatar numa cor unica', () => {
    // moldura com metade clara, metade escura — bom fundo pra provar que a
    // difusao produz textura, nao um preenchimento solido (o que fillRect faria).
    const w = 24;
    const h = 24;
    const data = new Uint8ClampedArray(w * h * 4);
    const unknown = new Uint8Array(w * h);
    const hole = { x: 8, y: 8, w: 8, h: 8 };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const inHole = x >= hole.x && x < hole.x + hole.w && y >= hole.y && y < hole.y + hole.h;
        const v = x < w / 2 ? 40 : 220; // gradiente esquerda escura / direita clara
        data[p * 4] = inHole ? 0 : v;
        data[p * 4 + 1] = inHole ? 0 : v;
        data[p * 4 + 2] = inHole ? 0 : v;
        data[p * 4 + 3] = 255;
        if (inHole) unknown[p] = 1;
      }
    }
    diffusePixels(data, w, h, unknown, 24);

    const leftOfHole = ((hole.y + 4) * w + (hole.x + 1)) * 4;
    const rightOfHole = ((hole.y + 4) * w + (hole.x + hole.w - 2)) * 4;
    // difusao propaga o lado escuro e o lado claro de fora pra dentro — o
    // resultado nao pode ser um tom unico (contra o `fillRect` de cor solida)
    expect(data[rightOfHole]! - data[leftOfHole]!).toBeGreaterThan(30);
  });

  test('nao mexe em pixels fora da mascara de desconhecido', () => {
    const w = 10;
    const h = 10;
    const { data, unknown } = makeImage(w, h, [10, 20, 30], [0, 0, 0], { x: 3, y: 3, w: 4, h: 4 });
    diffusePixels(data, w, h, unknown, 8);
    // canto fora da mascara continua exatamente a cor original
    expect([data[0], data[1], data[2]]).toEqual([10, 20, 30]);
  });
});
