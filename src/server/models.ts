import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.ts';
import { httpFetch } from './http.ts';

interface ModelSpec {
  url: string;
  sha256: string;
  bytes: number;
}

/**
 * Modelos baixados sob demanda. URL presa num commit e conteudo conferido por
 * SHA-256: o host final e' uma CDN que redireciona, entao a garantia de que o
 * arquivo e' o esperado vem do hash, nao do dominio.
 */
export const MODELS: Record<string, ModelSpec> = {
  // RT-DETR-v2 (Apache-2.0): bubble / text_bubble / text_free, manga+webtoon+HQ ocidental
  'text-detector': {
    url: 'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/16e8a622f91fabc6b5b65c96d32d1183f8843546/detector-v4-s_int8.onnx',
    sha256: '5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79',
    bytes: 11_120_765,
  },
};

const inflight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

async function download(name: string, spec: ModelSpec, path: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await httpFetch(spec.url, { timeoutMs: 180_000, retries: 1 });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength !== spec.bytes) throw new Error(`${name}: tamanho inesperado (${buf.byteLength} bytes)`);
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== spec.sha256) throw new Error(`${name}: hash nao confere (${digest.slice(0, 12)}...)`);
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, buf);
  await rename(tmp, path);
  console.log(`[modelos] ${name} baixado e conferido (${(buf.byteLength / 1e6).toFixed(1)} MB)`);
  return buf;
}

/** Bytes do modelo: do disco quando ja' baixado; senao baixa uma vez so' (pedidos concorrentes esperam o mesmo). */
export async function modelBytes(name: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!Object.hasOwn(MODELS, name)) return null;
  const spec = MODELS[name]!;
  const dir = join(config.cacheDir, 'models');
  const path = join(dir, `${name}-${spec.sha256.slice(0, 12)}.onnx`);
  const file = Bun.file(path);
  if (await file.exists()) return new Uint8Array(await file.arrayBuffer());
  let pending = inflight.get(name);
  if (!pending) {
    pending = mkdir(dir, { recursive: true }).then(() => download(name, spec, path));
    inflight.set(name, pending);
    void pending.finally(() => inflight.delete(name)).catch(() => undefined);
  }
  return await pending;
}
