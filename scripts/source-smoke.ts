/** Live catalog -> chapter -> signed image proxy; upstream failures remain failures. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const base = process.env['SOURCE_SMOKE_BASE'] ?? `http://127.0.0.1:${process.env['PORT'] ?? 7788}`;
const wanted = process.env['SOURCE_SMOKE_IDS']?.split(',').filter(Boolean);
const output = process.env['SOURCE_SMOKE_REPORT'] ?? '.cache/source-smoke.json';
// New releases can have no readable chapter yet. Also recheck a previously read title.
const samples = await Bun.file(new URL('./source-smoke-samples.json', import.meta.url)).json() as Record<string, string>;
interface Card { id: string; title: string; cover?: string }
interface Detail extends Card { chapters: { id: string }[] }
interface Result { provider: string; ok: boolean; series?: string; chapters?: number; pages?: number; images?: number; error?: string }
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json() as Promise<T>;
}
async function image(path: string): Promise<void> {
  if (!path.startsWith('/api/img?')) throw new Error('imagem nao assinada/proxiada');
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(40_000) });
  if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) throw new Error(`proxy: HTTP ${res.status}, ${res.headers.get('content-type')}`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength < 64) throw new Error('imagem vazia');
}
const providers = (await get<{ id: string; kind: string }[]>('/api/providers')).filter((p) => p.kind === 'online' && (!wanted || wanted.includes(p.id)));
if (!providers.length || wanted?.some((id) => !providers.some((p) => p.id === id))) throw new Error('fontes pedidas nao estao no catalogo');
const results: Result[] = [];
let cursor = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (cursor < providers.length) {
    const provider = providers[cursor++]!.id;
    const result: Result = { provider, ok: false };
    try {
      const search = await get<{ items: Card[]; errors: { message: string }[] }>(`/api/search?providers=${provider}`);
      if (search.errors.length) throw new Error(search.errors.map((e) => e.message).join('; '));
      if (!search.items.length) throw new Error('busca sem resultados');
      let lastError: unknown;
      const candidates = search.items.slice(0, 3);
      const sample = samples[provider];
      if (sample && !candidates.some((c) => c.id === sample)) candidates.push({ id: sample, title: sample });
      for (const card of candidates) {
        try {
          const detail = await get<Detail>(`/api/series?provider=${provider}&id=${encodeURIComponent(card.id)}`);
          if (!detail.chapters.length) throw new Error('obra sem capitulos');
          const { pages } = await get<{ pages: { url: string }[] }>(`/api/pages?provider=${provider}&chapter=${encodeURIComponent(detail.chapters[0]!.id)}`);
          if (!pages.length) throw new Error('capitulo sem paginas');
          const positions = [...new Set([0, Math.floor(pages.length / 2), pages.length - 1])];
          for (const pos of positions) await image(pages[pos]!.url);
          const cover = detail.cover ?? card.cover;
          if (cover) await image(cover);
          Object.assign(result, { ok: true, series: card.id, chapters: detail.chapters.length, pages: pages.length, images: positions.length + (cover ? 1 : 0) });
          lastError = undefined;
          break;
        } catch (error) { lastError = error; }
      }
      if (lastError) throw lastError;
    } catch (error) { result.error = String(error); }
    results.push(result);
    console.log(`${result.ok ? 'OK' : 'FALHA'} ${provider}: ${result.ok ? `${result.chapters} capitulos, ${result.pages} paginas, ${result.images} imagens proxiadas` : result.error}`);
  }
}));
await mkdir(join(output, '..'), { recursive: true });
await Bun.write(output, JSON.stringify({ checkedAt: new Date().toISOString(), base, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} fontes passaram. Relatorio: ${output}`);
process.exitCode = failed.length ? 1 : 0;
