import { stat } from 'node:fs/promises';
import { createExtractorFromData } from 'node-unrar-js';

export interface RarEntry {
  name: string;
  size: number;
  encrypted: boolean;
}

/**
 * CBR e' RAR com outro nome. O `zip.ts` daqui e' um leitor proprio porque ZIP e'
 * simples; RAR nao e' — a descompressao vem do unrar oficial compilado em WASM
 * (`node-unrar-js`). Extrair e' uso comum de leitor de HQ; a licenca do unrar so'
 * proibe usar o codigo para recriar o algoritmo de COMPRESSAO, o que nao e' o caso.
 *
 * So' a variante "from data" devolve o conteudo: a "from file" extrai para disco
 * e deixa `extraction` vazio — nao serve para servir a pagina pela rede.
 */
let cache: { path: string; mtimeMs: number; size: number; data: ArrayBuffer } | null = null;

/**
 * Um CBR inteiro em memoria por vez. A leitura e' sequencial (pagina 1, 2, 3 do
 * mesmo capitulo), entao um slot cobre o caso real; guardar mais arquivos seria
 * segurar dezenas de MB por capitulo ja' fechado. `mtime` e tamanho no
 * carimbo porque arquivo trocado no disco nao pode continuar servindo o antigo.
 */
async function archiveData(path: string): Promise<ArrayBuffer> {
  const st = await stat(path);
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.data;
  const data = await Bun.file(path).arrayBuffer();
  cache = { path, mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

/** Nomes de arquivo dentro do CBR, sem os diretorios. */
export async function readRarIndex(path: string): Promise<RarEntry[]> {
  const extractor = await createExtractorFromData({ data: await archiveData(path) });
  const out: RarEntry[] = [];
  for (const h of extractor.getFileList().fileHeaders) {
    if (h.flags.directory) continue;
    out.push({ name: h.name, size: h.unpSize, encrypted: h.flags.encrypted });
  }
  return out;
}

/** Uma pagina por chamada — o leitor pede pagina a pagina. */
export async function readRarEntry(path: string, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const extractor = await createExtractorFromData({ data: await archiveData(path) });
  const [file] = [...extractor.extract({ files: [name] }).files];
  if (!file?.extraction) throw new Error(`pagina "${name}" nao pode ser extraida do CBR (protegida por senha ou ausente)`);
  // o unrar devolve uma view do heap WASM: copia para um buffer proprio, senao a
  // resposta viaja apontando para memoria que a proxima extracao reaproveita
  return new Uint8Array(file.extraction) as Uint8Array<ArrayBuffer>;
}
