/** Balao como chega do cliente: posicao em pixels da pagina, opcional. */
export interface PageBlock {
  id: number;
  text: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export const MAX_BLOCKS = 300;
export const MAX_BLOCK_CHARS = 400;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * OCR em trama ou simbolo (`●`, `ー`) entra em loop e devolve centenas do mesmo
 * caractere: queimava tokens e travava o LLM. Tres repeticoes preservam
 * onomatopeia ("AAAH", "ドドド") sem deixar o lixo passar.
 */
export function collapseRepeats(text: string): string {
  return text
    .replace(/(.)\1{3,}/gsu, '$1$1$1')
    .replace(/(\S{2,6}?)\1{3,}/gsu, '$1$1$1')
    .slice(0, MAX_BLOCK_CHARS);
}

/** chines e japones nao separam palavras; coreano separa, entao Hangul fica de fora */
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー、。！？';
const CJK_BREAK = new RegExp(`([${CJK}])\\s*\\n\\s*(?=[${CJK}])`, 'gu');

/** Linha do OCR e' diagramacao do balao, nao do texto: o LLM a copiava palavra por palavra. */
const flattenLines = (text: string): string =>
  text
    .replace(CJK_BREAK, '$1')
    .replace(/(\p{L})-\s*\n\s*(?=\p{L})/gu, '$1-')
    .replace(/\s+/g, ' ')
    .trim();

/** Valida o corpo vindo da rede; `null` = recusar com 400. */
export function sanitizeBlocks(raw: unknown): PageBlock[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BLOCKS) return null;
  const out: PageBlock[] = [];
  const seen = new Set<number>();
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object' || !Number.isInteger(item.id) || typeof item.text !== 'string') return null;
    // a traducao volta casada por id: repetido, um balao sobrescreveria o outro
    if (seen.has(item.id as number)) return null;
    seen.add(item.id as number);
    // corta antes das regex (o corpo vem da rede); a folga deixa o colapso de repeticao encolher o texto
    const raw = item.text.slice(0, MAX_BLOCK_CHARS * 4);
    const block: PageBlock = { id: item.id as number, text: collapseRepeats(flattenLines(raw)) };
    if (finite(item.x) && finite(item.y) && finite(item.w) && finite(item.h) && item.w > 0 && item.h > 0) {
      Object.assign(block, { x: item.x, y: item.y, w: item.w, h: item.h });
    }
    out.push(block);
  }
  return out;
}

type Placed = PageBlock & { x: number; y: number; w: number; h: number };
const placed = (b: PageBlock): b is Placed => b.x !== undefined && b.y !== undefined && b.w !== undefined && b.h !== undefined;

/**
 * Ordem de leitura por faixas: baloes que dividem a maior parte da altura ficam
 * na mesma linha, lida da direita para a esquerda em manga (RTL) e ao contrario
 * em HQ. Ordenar so' por `y` alternava falas da mesma altura ao sabor de 1 px.
 */
export function readingOrder<T extends PageBlock>(blocks: T[], rtl: boolean): T[] {
  if (!blocks.every(placed)) return blocks;
  const rows: { top: number; bottom: number; items: T[] }[] = [];
  for (const b of [...blocks].sort((a, c) => a.y! - c.y!)) {
    const row = rows.at(-1);
    const overlap = row ? Math.min(row.bottom, b.y! + b.h!) - b.y! : 0;
    if (row && overlap >= 0.5 * Math.min(b.h!, row.bottom - row.top)) {
      row.items.push(b);
      row.bottom = Math.max(row.bottom, b.y! + b.h!);
    } else {
      rows.push({ top: b.y!, bottom: b.y! + b.h!, items: [b] });
    }
  }
  const centre = (b: T): number => b.x! + b.w! / 2;
  return rows.flatMap((r) => r.items.sort((a, c) => (rtl ? centre(c) - centre(a) : centre(a) - centre(c))));
}
