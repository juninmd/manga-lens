/**
 * Escritor minimo de ZIP sem compressao (store), o suficiente para CBZ: imagem
 * de pagina ja' vem comprimida (JPEG/PNG/WebP), deflate so' gastaria CPU.
 * Par do leitor em `zip.ts`.
 */
export interface ZipInput {
  name: string;
  data: Uint8Array;
}

/** Teto de um CBZ montado em memoria (fica bem abaixo do limite ZIP64 de 4 GiB). */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

export function buildStoredZip(entries: ZipInput[]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = Bun.hash.crc32(entry.data) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // bit 11: nome em UTF-8
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, entry.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, entry.data.length, true);
    central.setUint32(24, entry.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + entry.data.length;
    if (offset > MAX_ZIP_BYTES) throw new Error('capitulo grande demais para um CBZ');
  }
  const cenSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cenSize, true);
  eocd.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Nome seguro para pasta/arquivo em Windows, macOS e Linux. */
export function safeFileName(raw: string, fallback = 'sem titulo'): string {
  const clean = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: controle nao entra em nome de arquivo
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) return fallback;
  return clean;
}

/** Extensao da imagem pelo content-type (o nome no CBZ precisa dela para o leitor). */
export function imageExt(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes('png')) return '.png';
  if (t.includes('webp')) return '.webp';
  if (t.includes('gif')) return '.gif';
  if (t.includes('avif')) return '.avif';
  return '.jpg';
}
