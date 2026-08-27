const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ENTITIES[ent]) return ENTITIES[ent]!;
    if (!ent.startsWith('#')) return m;
    const hex = ent[1] === 'x' || ent[1] === 'X';
    const code = Number.parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
    // HTML de provider vem quebrado: codepoint fora do intervalo Unicode lanca
    // RangeError e derrubaria a busca inteira. Entidade impossivel fica literal.
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return m;
    return String.fromCodePoint(code);
  });
}

export const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, '')).trim();

export function all(html: string, re: RegExp): RegExpExecArray[] {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html))) {
    out.push(m);
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return out;
}

export const first = (html: string, re: RegExp): string | undefined => re.exec(html)?.[1]?.trim();

/** Fatia o HTML nos pontos onde `marker` casa — um bloco por card. */
export function chunks(html: string, marker: RegExp): string[] {
  const idx = all(html, marker).map((m) => m.index);
  return idx.map((start, i) => html.slice(start, idx[i + 1] ?? html.length));
}
