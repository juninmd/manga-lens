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
    if (eocd < 0) throw new Error('CBZ invalido: fim do arquivo zip nao encontrado');

    const count = tail.readUInt16LE(eocd + 10);
    const cenSize = tail.readUInt32LE(eocd + 12);
    const cenOffset = tail.readUInt32LE(eocd + 16);

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
      const name = cen.toString('utf8', p + 46, p + 46 + nameLen);
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
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, entry.offset);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = entry.offset + 30 + nameLen + extraLen;
    const raw = Buffer.alloc(entry.compressedSize);
    await fh.read(raw, 0, entry.compressedSize, dataStart);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`metodo de compressao ${entry.method} nao suportado`);
  } finally {
    await fh.close();
  }
}
