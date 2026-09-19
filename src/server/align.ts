/** Item da resposta do LLM: `src` e' o eco do inicio do original, pedido para ancorar o id. */
export interface ReplyItem {
  id: number;
  pt: string;
  src?: string;
}

const norm = (s: string): string =>
  s
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '');

function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length]!;
}

/** O eco bate com o inicio do texto? Tolera o OCR que o modelo corrigiu ("OID YOU" -> "DID YOU"). */
function echoes(src: string, text: string): boolean {
  const a = [...norm(src)];
  const b = [...norm(text)];
  const n = Math.min(a.length, b.length);
  if (n < 2) return false;
  return distance(a.slice(0, n).join(''), b.slice(0, n).join('')) <= Math.max(1, Math.floor(n * 0.34));
}

/**
 * Modelo pequeno pula uma fala curta e escorrega as seguintes um balao para cima
 * (visto na p57 do cap. 1 com 7B). O eco `src` e' a prova: item cujo eco aponta
 * para outro balao livre e' movido para ele. Se aponta para balao ja' traduzido
 * (duplicata) ou para textos diferentes ao mesmo tempo, cai: o balao vazio o
 * usuario refaz com R, a fala no balao errado ninguem percebe. Sem eco
 * reconhecivel nao ha' prova de nada: fica onde esta'.
 */
export function realign(items: ReplyItem[], blocks: { id: number; text: string }[]): { id: number; pt: string }[] {
  const text = new Map(blocks.map((b) => [b.id, b.text]));
  const owner = new Map<number, number>();
  const moved: number[] = [];
  items.forEach((it, i) => {
    const own = text.get(it.id);
    const anchored = !it.src || (own !== undefined && echoes(it.src, own)) || !blocks.some((b) => echoes(it.src!, b.text));
    if (anchored) {
      if (!owner.has(it.id)) owner.set(it.id, i);
    } else moved.push(i);
  });
  for (const i of moved) {
    const targets = blocks.filter((b) => echoes(items[i]!.src!, b.text));
    const free = targets.filter((b) => !owner.has(b.id));
    // "WHAT?!" repetido: qualquer balao livre com o mesmo texto serve; textos diferentes seria chute
    const same = targets.every((b) => norm(b.text) === norm(targets[0]!.text));
    if (free.length && same) owner.set(free[0]!.id, i);
  }
  return [...owner]
    .sort((a, b) => a[1] - b[1])
    .map(([id, i]) => ({ id, pt: items[i]!.pt }));
}
