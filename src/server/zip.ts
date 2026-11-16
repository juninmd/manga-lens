import { inflateRawSync } from 'node:zlib';
import { open } from 'node:fs/promises';

export interface ZipEntry {
  name: string;
  offset: number;
  compressedSize: number;
  size: number;
  method: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

/** Teto por pagina descompactada: CBZ legitimo nao chega perto disso. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Teto do central directory: ~200 mil entradas com nome longo. */
export const MAX_CEN_BYTES = 16 * 1024 * 1024;

/** Erro de arquivo invalido ou fora dos limites: as rotas viram 422. */
export class ZipError extends Error {}

/**
 * Leitor minimo de ZIP (o suficiente para CBZ): le o central directory e
 * descomprime uma entrada sob demanda. Evita dependencia externa para
 * abrir arquivo local do usuario.
 */
export async function readZipIndex(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 66_000);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('CBZ invalido: fim do arquivo zip nao encontrado');

    const count = tail.readUInt16LE(eocd + 10);
    const cenSize = tail.readUInt32LE(eocd + 12);
    const cenOffset = tail.readUInt32LE(eocd + 16);
    const hasLocator = eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG;
    if (hasLocator || count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) {
      throw new ZipError('CBZ ZIP64 nao suportado');
    }
    if (cenSize > MAX_CEN_BYTES) throw new ZipError('CBZ invalido: diretorio central maior que o limite');
    if (cenOffset + cenSize > size - 22) throw new ZipError('CBZ invalido: diretorio central fora do arquivo');

    const cen = Buffer.alloc(cenSize);
    await fh.read(cen, 0, cenSize, cenOffset);

    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cen.length; i++) {
      if (cen.readUInt32LE(p) !== CEN_SIG) break;
      const method = cen.readUInt16LE(p + 10);
      const compressedSize = cen.readUInt32LE(p + 20);
      const uncompressedSize = cen.readUInt32LE(p + 24);
      const nameLen = cen.readUInt16LE(p + 28);
      const extraLen = cen.readUInt16LE(p + 30);
      const commentLen = cen.readUInt16LE(p + 32);
      const localOffset = cen.readUInt32LE(p + 42);
      const flags = cen.readUInt16LE(p + 8);
      if (p + 46 + nameLen > cen.length) throw new ZipError('CBZ invalido: entrada truncada');
      const name = cen.toString('utf8', p + 46, p + 46 + nameLen);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new ZipError('CBZ ZIP64 nao suportado');
      }
      if (!name.endsWith('/') && flags & 1) throw new ZipError('CBZ com senha nao suportado');
      if (!name.endsWith('/')) {
        entries.push({ name, offset: localOffset, compressedSize, size: uncompressedSize, method });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

export async function readZipEntry(path: string, entry: ZipEntry): Promise<Buffer> {
  if (entry.compressedSize > MAX_ENTRY_BYTES || entry.size > MAX_ENTRY_BYTES) {
    throw new ZipError('entrada maior que o limite');
  }
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (entry.offset + 30 > size) throw new ZipError('CBZ invalido: entrada fora do arquivo');
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, entry.offset);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = entry.offset + 30 + nameLen + extraLen;
    if (dataStart + entry.compressedSize > size) throw new ZipError('CBZ invalido: entrada fora do arquivo');
    const raw = Buffer.alloc(entry.compressedSize);
    await fh.read(raw, 0, entry.compressedSize, dataStart);
    if (entry.method === 0) return raw;
    if (entry.method === 8) {
      let out: Buffer;
      try {
        out = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError('entrada maior que o limite');
        throw new ZipError(`CBZ invalido: ${(err as Error).message}`);
      }
      if (out.length !== entry.size) throw new ZipError('CBZ invalido: tamanho descompactado diverge do declarado');
      return out;
    }
    throw new ZipError(`metodo de compressao ${entry.method} nao suportado`);
  } finally {
    await fh.close();
  }
}
