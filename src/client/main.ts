import { aiHealth, getSeries, type ChapterRef, type SeriesDetail } from './api.ts';
import { Catalog } from './catalog.ts';
import { SeriesPanel } from './series.ts';
import { Reader } from './reader.ts';
import { el, qs, toast } from './ui.ts';
import { getProgress } from './state.ts';
import { resolveApiBase } from './base.ts';

// no desktop a API vive num sidecar: descobre a porta antes de qualquer fetch.
// Se isso falhar, todo fetch cairia no index.html do bundle e o erro apareceria
// como "Unexpected token '<'" — melhor falhar aqui, com a causa na tela.
try {
  await resolveApiBase();
} catch (err) {
  document.body.innerHTML =
    `<div style="padding:40px;font:14px system-ui;color:#e8ecf2">` +
    `<h2>Nao consegui falar com o servidor interno</h2><p>${(err as Error).message}</p></div>`;
  throw err;
}

const app = qs<HTMLElement>('#app');
const catalogRoot = el('main', { class: 'ml-main' });
app.append(catalogRoot);

const reader = new Reader(() => {
  if (location.hash.startsWith('#/r/')) history.back();
});

const seriesPanel = new SeriesPanel((detail, chapter) => openReader(detail, chapter));

const catalog = new Catalog({
  onOpenSeries: (provider, id) => {
    location.hash = `#/s/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;
  },
  onResume: (provider, seriesId) => {
    location.hash = `#/s/${encodeURIComponent(provider)}/${encodeURIComponent(seriesId)}`;
  },
  onOpenBookmark: (provider, seriesId, chapterId, page) => {
    void (async () => {
      const detail = await getSeries(provider, seriesId).catch(() => undefined);
      const chapter = detail?.chapters.find((c) => c.id === chapterId);
      if (!detail || !chapter) return toast('marcador aponta para um capitulo que sumiu', 'error');
      location.hash = `#/r/${encodeURIComponent(provider)}/${encodeURIComponent(seriesId)}/${encodeURIComponent(chapterId)}`;
      void reader.open(detail, chapter, page);
    })();
  },
});

function openReader(detail: SeriesDetail, chapter: ChapterRef): void {
  const progress = getProgress(detail.provider, detail.id);
  const startPage = progress?.chapterId === chapter.id ? progress.page : 0;
  seriesPanel.close();
  location.hash = `#/r/${encodeURIComponent(detail.provider)}/${encodeURIComponent(detail.id)}/${encodeURIComponent(chapter.id)}`;
  void reader.open(detail, chapter, startPage);
}

async function route(): Promise<void> {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  // Sair pelo botao da barra funcionava (ele chama history.back()), mas o caminho
  // inverso nao: o Back do navegador trocava a hash, a rota abria o painel de
  // serie e o leitor continuava por cima, em tela cheia, tapando tudo.
  if (parts[0] !== 'r' && reader.isOpen) reader.close();
  if (parts[0] === 's' && parts[1] && parts[2]) {
    await seriesPanel.open(parts[1], parts.slice(2).join('/'));
    return;
  }
  if (parts[0] === 'r' && parts[1] && parts[2] && parts[3]) {
    // openReader ja' abriu e so' mexeu na hash: recarregar aqui refaria o capitulo inteiro
    if (reader.isShowing(parts[1], parts[2], parts[3])) return;
    const detail = await getSeries(parts[1], parts[2]).catch(() => undefined);
    const chapter = detail?.chapters.find((c) => c.id === parts[3]);
    if (detail && chapter) void reader.open(detail, chapter, getProgress(parts[1], parts[2])?.page ?? 0);
    return;
  }
  seriesPanel.close();
}

window.addEventListener('hashchange', () => void route());

async function showAiStatus(): Promise<void> {
  const badge = el('div', { class: 'ml-ai-badge' }, 'IA: verificando...');
  document.body.append(badge);
  try {
    const h = await aiHealth();
    const swapped = h.ok && h.configuredModel && h.model !== h.configuredModel;
    const provPrefix = h.provider ? `[${h.provider}] ` : '';
    badge.textContent = h.ok
      ? `IA: ${provPrefix}${h.model}${swapped ? ' (substituto)' : ''}${h.visionModel ? ` + visao (${h.visionModel})` : ''}`
      : `IA offline ${provPrefix}(${h.error ?? '?'})`;
    badge.classList.toggle('is-bad', !h.ok);
    if (swapped) badge.title = `AI_MODEL="${h.configuredModel}" nao existe em ${h.baseUrl}; usando ${h.model}`;
    if (!h.ok) badge.title = `configure AI_PROVIDER/AI_BASE_URL/AI_MODEL no .env — endpoint atual: ${h.baseUrl}`;
  } catch {
    badge.textContent = 'IA indisponivel';
    badge.classList.add('is-bad');
  }
  setTimeout(() => badge.classList.add('is-quiet'), 6000);
}

await catalog.mount(catalogRoot).catch((e: Error) => toast(`falha ao iniciar: ${e.message}`, 'error'));
void route();
void showAiStatus();
