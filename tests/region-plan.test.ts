import { describe, expect, test } from 'bun:test';
import { cropMask, planTargets, type Detection, type HeuristicRegion } from '../src/client/region-plan.ts';

const PAGE = { w: 1000, h: 1600 };
const det = (label: 0 | 1 | 2, x: number, y: number, w: number, h: number, score = 0.9): Detection => ({ label, score, x, y, w, h });
/** regiao heuristica ja' na escala da deteccao (scale 0.5 = metade da pagina) */
const region = (x: number, y: number, w: number, h: number): HeuristicRegion => ({
  x,
  y,
  w,
  h,
  mask: new Uint8Array(w * h).fill(1),
  bg: 'rgb(255, 255, 255)',
  fg: 'rgb(0, 0, 0)',
});

describe('planTargets', () => {
  test('balao com um texto: mascara da heuristica, OCR na caixa justa do modelo', () => {
    const [t] = planTargets([det(1, 220, 220, 100, 60)], [region(100, 100, 100, 100)], 0.5, PAGE);
    expect(t!.free).toBe(false);
    expect(t!.block).toEqual({ x: 200, y: 200, w: 200, h: 200 });
    expect(t!.mask!.w).toBe(100);
    // OCR le so' o texto (com margem), nao o balao inteiro
    expect(t!.ocr.w).toBeLessThan(t!.block.w * 0.75);
    expect(t!.ocr.w).toBeGreaterThan(100);
  });

  test('dois baloes que a heuristica fundiu sao separados pelas caixas do modelo', () => {
    const merged = region(0, 0, 400, 200); // 800x400 na pagina
    const targets = planTargets(
      [det(0, 0, 0, 380, 400), det(1, 60, 100, 200, 150), det(0, 420, 0, 380, 400), det(1, 480, 100, 200, 150)],
      [merged],
      0.5,
      PAGE,
    );
    expect(targets).toHaveLength(2);
    const [a, b] = [...targets].sort((p, q) => p.block.x - q.block.x);
    expect(a!.block).toEqual({ x: 0, y: 0, w: 380, h: 400 });
    expect(b!.block).toEqual({ x: 420, y: 0, w: 380, h: 400 });
    // cada metade leva so' o pedaco da mascara que lhe cabe
    expect(a!.mask!.w).toBe(190);
  });

  test('texto sem balao heuristico (pagina colorida, legenda, SFX) vira alvo livre', () => {
    const [t] = planTargets([det(2, 500, 50, 120, 40)], [], 0.5, PAGE);
    expect(t!.free).toBe(true);
    expect(t!.mask).toBeUndefined();
  });

  test('modelo sem nenhum texto na pagina (estilo que ele nao conhece): heuristica segue valendo', () => {
    const targets = planTargets([], [region(10, 10, 50, 50)], 0.5, PAGE);
    expect(targets).toEqual([expect.objectContaining({ free: false, block: { x: 20, y: 20, w: 100, h: 100 } })]);
  });

  test('regiao clara sem texto do modelo numa pagina com texto e descartada (trama, borda)', () => {
    const targets = planTargets([det(1, 620, 620, 60, 40)], [region(300, 300, 50, 50), region(10, 10, 50, 50)], 0.5, PAGE);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.block).toEqual({ x: 600, y: 600, w: 100, h: 100 });
  });

  test('texto que so atravessa uma regiao nao e lido duas vezes', () => {
    const targets = planTargets([det(2, 50, 50, 100, 100)], [region(0, 0, 50, 50)], 0.5, PAGE);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.free).toBe(true);
  });

  test('mesma caixa em duas classes vira um alvo; deteccao fraca e ignorada', () => {
    const targets = planTargets([det(1, 100, 100, 300, 80, 0.7), det(2, 102, 101, 298, 80, 0.6), det(2, 600, 600, 50, 50, 0.3)], [], 0.5, PAGE);
    expect(targets).toHaveLength(1);
  });

  test('margem do texto nao sai da pagina', () => {
    const [t] = planTargets([det(2, 0, 0, 100, 50)], [], 1, PAGE);
    expect(t!.ocr.x).toBe(0);
    expect(t!.ocr.y).toBe(0);
  });
});

describe('cropMask', () => {
  test('recorta a mascara na interseccao e devolve nulo fora da regiao', () => {
    const r = region(10, 10, 4, 2);
    r.mask = Uint8Array.from([1, 0, 1, 0, 0, 1, 0, 1]);
    expect(cropMask(r, { x: 12, y: 10, w: 10, h: 10 })).toEqual({
      box: { x: 12, y: 10, w: 2, h: 2 },
      mask: { w: 2, h: 2, data: Uint8Array.from([1, 0, 0, 1]) },
    });
    expect(cropMask(r, { x: 100, y: 100, w: 5, h: 5 })).toBeNull();
  });
});
