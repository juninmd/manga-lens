/**
 * Benchmark da rota /api/local/page em CBZ: mede a latencia por pagina lendo um
 * capitulo inteiro (sequencial e com prefetch concorrente). Uso:
 *   bun run scripts/bench-local-page.ts [paginas=200] [kb=400]
 * Roda em processo proprio: compare execucoes independentes, nao iteracoes.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStoredZip } from '../src/server/zip-write.ts';

const pages = Number(process.argv[2] ?? 200);
const kb = Number(process.argv[3] ?? 400);
const box = await mkdtemp(join(tmpdir(), 'ml-bench-'));
process.env.LOCAL_LIBRARY = box;
await mkdir(join(box, 'Obra'), { recursive: true });
const cbz = join(box, 'Obra', 'Cap 01.cbz');
// bytes aleatorios: imagem real ja' vem comprimida, o CBZ a guarda sem deflate
const entries = Array.from({ length: pages }, (_, i) => {
  const data = new Uint8Array(kb * 1024);
  for (let o = 0; o < data.length; o += 65536) crypto.getRandomValues(data.subarray(o, o + 65536));
  return { name: `${String(i + 1).padStart(3, '0')}.jpg`, data };
});
await writeFile(cbz, buildStoredZip(entries));
const { config } = await import('../src/server/config.ts');
config.localRoots.splice(0, config.localRoots.length, box);
const app = (await import('../src/server/index.ts')).default;
const token = Buffer.from(cbz, 'utf8').toString('base64url');
const get = async (i: number) => {
  const res = await app.fetch(new Request(`http://127.0.0.1/api/local/page?c=${token}&i=${i}`));
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  await res.arrayBuffer();
};
for (let i = 0; i < 20; i++) await get(i); // aquecimento
const lat: number[] = [];
const t0 = performance.now();
for (let i = 0; i < pages; i++) {
  const s = performance.now();
  await get(i);
  lat.push(performance.now() - s);
}
const seqMs = performance.now() - t0;
const t1 = performance.now();
for (let i = 0; i < pages; i += 8) await Promise.all(Array.from({ length: Math.min(8, pages - i) }, (_, k) => get(i + k)));
const parMs = performance.now() - t1;
lat.sort((a, b) => a - b);
const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]!.toFixed(3);
console.log(JSON.stringify({ pages, kb, seqTotalMs: +seqMs.toFixed(1), p50: +pct(50), p95: +pct(95), p99: +pct(99), par8TotalMs: +parMs.toFixed(1) }));
await rm(box, { recursive: true, force: true });
process.exit(0);
