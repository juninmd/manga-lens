/** Maior code point Unicode: acima disso `String.fromCodePoint` lanca RangeError. */
const MAX_CODE_POINT = 0x10ffff;

const fromCode = (match: string, code: number): string =>
  Number.isInteger(code) && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : match;

/**
 * Entidades XML/HTML que os arquivos e catalogos usam na pratica. Referencia
 * numerica invalida fica como texto: um `&#99999999;` num resumo nao pode
 * derrubar a leitura do arquivo inteiro. `&amp;` por ultimo para `&amp;lt;`
 * virar `&lt;` e nao `<`.
 */
export const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => fromCode(m, Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d: string) => fromCode(m, Number(d)))
    .replace(/&amp;/g, '&');
