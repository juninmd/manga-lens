const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  hellip: '\u2026',
  bull: '\u2022',
  trade: '\u2122',
  euro: '\u20ac',
};

// Latin-1 (U+00A1..U+00FF) na ordem do padrao HTML; nbsp (U+00A0) ja esta acima.
const LATIN1 =
  'iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
    ' ',
  );
LATIN1.forEach((name, i) => {
  ENTITIES[name] = String.fromCharCode(0xa1 + i);
});

export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (Object.hasOwn(ENTITIES, ent)) return ENTITIES[ent]!;
    if (!ent.startsWith('#')) return m;
    const hex = ent[1] === 'x' || ent[1] === 'X';
    const code = Number.parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
    // HTML de provider vem quebrado: codepoint fora do intervalo Unicode lanca
    // RangeError e derrubaria a busca inteira. Entidade impossivel fica literal.
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return m;
    return String.fromCodePoint(code);
  });
}

// `;` final obrigatorio: sem ele `?a=1&copy=2` em URLs viraria `?a=1\u00a92`.
export const stripTags = (s: string): string =>
  decodeEntities(s.replace(/<[^>]*>/g, ''))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();

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
