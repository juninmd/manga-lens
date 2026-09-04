import { aiHealth, getSeries, type ChapterRef, type SeriesDetail } from './api.ts';
import { Catalog } from './catalog.ts';
import { SeriesPanel } from './series.ts';
import { Reader } from './reader.ts';
import { el, qs, toast } from './ui.ts';
import { getProgress, nextUnreadChapter } from './state.ts';
import { isDesktop, resolveApiBase, waitForApi } from './base.ts';

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

// O sidecar leva alguns segundos para escutar; sem esperar, o primeiro fetch
// caia em "servidor indisponivel" e o catalogo abria vazio.
if (isDesktop()) {
  const splash = el(
    'div',
    { class: 'ml-splash', role: 'status' },
    el('div', { class: 'ml-spinner' }),
    el('span', {}, 'iniciando servidor interno...'),
  );
  document.body.append(splash);
  const up = await waitForApi(12_000);
  if (up) splash.remove();
  else {
    splash.innerHTML = '';
    splash.append(
      el('span', {}, 'o servidor interno nao respondeu em 12 segundos'),
      el('button', { class: 'ml-btn ml-btn-primary', onclick: () => location.reload() }, 'tentar de novo'),
    );
    throw new Error('sidecar nao respondeu');
  }
}

// Soltar um arquivo na janela abria o arquivo no lugar do app (web) ou nao fazia nada (desktop)
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  // arrastar texto para a busca continua valendo
  if ((e.target as Element | null)?.closest('input, textarea')) return;
  e.preventDefault();
  toast('para ler arquivos locais, configure a biblioteca local em Fontes');
});

const app = qs<HTMLElement>('#app');
const catalogRoot = el('main', { class: 'ml-main' });
app.append(catalogRoot);

/** ultima obra aberta no leitor — para voltar ao painel dela quando nao ha' historico */
let current: { provider: string; id: string } | undefined;
const seriesHash = (provider: string, id: string): string =>
  `#/s/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;

// Entrar por deep-link `#/r/...` numa aba nova nao tem entrada anterior:
// `history.back()` nao faz nada, o leitor fecha mas a hash fica orfa e um
// recarregar reabre o capitulo. Sem historico, cai no painel da serie.
const reader = new Reader(() => {
  if (!location.hash.startsWith('#/r/')) return;
  // `history.back()` com entrada anterior de outro site (link externo) saia do app:
  // conhecendo a obra, vai direto ao painel dela
  if (current) location.hash = seriesHash(current.provider, current.id);
  else if (history.length > 1) history.back();
  else location.hash = '';
});

const readerHash = (detail: SeriesDetail, chapter: ChapterRef): string =>
  `#/r/${encodeURIComponent(detail.provider)}/${encodeURIComponent(detail.id)}/${encodeURIComponent(chapter.id)}`;

// "cap »", fim de capitulo e popover trocam o capitulo por dentro do leitor:
// a hash ficava no anterior e reload/compartilhar/Back reabriam o errado.
// `replaceState` nao dispara a rota (o leitor ja' esta' abrindo) nem enche o historico.
reader.onChapterChange = (detail, chapter) => {
  current = { provider: detail.provider, id: detail.id };
  history.replaceState(null, '', readerHash(detail, chapter));
};

const seriesPanel = new SeriesPanel((detail, chapter) => openReader(detail, chapter));

// painel fechado por Esc/✕ deixa a hash igual: atribuir o mesmo valor nao
// dispara `hashchange`, entao a rota precisa ser chamada na mao
function goToSeries(provider: string, id: string): void {
  const target = `#/s/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;
  if (location.hash === target) void route();
  else location.hash = target;
}

const catalog = new Catalog({
  onOpenSeries: goToSeries,
  // "Continuar lendo" abria o painel (dois cliques) e, com o capitulo ja'
  // terminado, relia o mesmo em vez de ir ao seguinte
  onResume: (provider, seriesId) => {
    void (async () => {
      const detail = await getSeries(provider, seriesId).catch(() => undefined);
      const progress = getProgress(provider, seriesId);
      const saved = detail?.chapters.find((c) => c.id === progress?.chapterId);
      if (!detail || !saved || !progress) return goToSeries(provider, seriesId);
      openReader(detail, nextUnreadChapter(detail, saved, progress.page) ?? saved);
    })();
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

/**
 * Progresso salvo na ultima pagina significa "terminei": reabrir o capitulo
 * do inicio, nao na pagina final (que obrigava a voltar tudo).
 */
function resumePage(detail: SeriesDetail, chapter: ChapterRef): number {
  const progress = getProgress(detail.provider, detail.id);
  if (progress?.chapterId !== chapter.id) return 0;
  if (chapter.pages && progress.page >= chapter.pages - 1) return 0;
  return progress.page;
}

function openReader(detail: SeriesDetail, chapter: ChapterRef): void {
  const startPage = resumePage(detail, chapter);
  current = { provider: detail.provider, id: detail.id };
  seriesPanel.close();
  location.hash = readerHash(detail, chapter);
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
    if (detail && chapter) {
      current = { provider: detail.provider, id: detail.id };
      void reader.open(detail, chapter, resumePage(detail, chapter));
    }
    return;
  }
  seriesPanel.close();
}

window.addEventListener('hashchange', () => void route());

/**
 * Badge de IA. Offline, o clique abre o painel de configuracao (a dica antiga
 * mandava editar um .env que nao existe no app instalado); saudavel, oculta.
 */
const aiBadge = el('div', { class: 'ml-ai-badge', role: 'status' }, 'IA: verificando...');
let aiBadgeOk = false;
/** dispensado pelo usuario: salvar config nao pode traze-lo de volta */
let aiBadgeDismissed = false;
let aiQuietTimer: number | undefined;
aiBadge.addEventListener('click', () => {
  if (aiBadgeOk) {
    aiBadgeDismissed = true;
    aiBadge.remove();
  }
  else void catalog.openAiDrawer(true);
});

async function showAiStatus(): Promise<void> {
  if (aiBadgeDismissed) return;
  if (!aiBadge.isConnected) document.body.append(aiBadge);
  aiBadge.classList.remove('is-quiet');
  try {
    const h = await aiHealth();
    const swapped = h.ok && h.configuredModel && h.model !== h.configuredModel;
    const provPrefix = h.provider ? `[${h.provider}] ` : '';
    aiBadgeOk = Boolean(h.ok);
    aiBadge.textContent = h.ok
      ? `IA: ${provPrefix}${h.model}${swapped ? ' (substituto)' : ''}${h.visionModel ? ` + visao (${h.visionModel})` : ''}`
      : `IA offline ${provPrefix}— o Tradutor Web funciona sem IA; clique para configurar`;
    aiBadge.classList.toggle('is-bad', !h.ok);
    aiBadge.title = h.ok
      ? swapped
        ? `modelo configurado "${h.configuredModel}" nao existe em ${h.baseUrl}; usando ${h.model}. Clique para ocultar`
        : 'clique para ocultar'
      : `${h.error ?? 'sem resposta'} (${h.baseUrl}). Clique para abrir o painel de IA`;
  } catch {
    aiBadgeOk = false;
    aiBadge.textContent = 'IA indisponivel — clique para configurar';
    aiBadge.classList.add('is-bad');
  }
  clearTimeout(aiQuietTimer);
  aiQuietTimer = window.setTimeout(() => aiBadge.classList.add('is-quiet'), 6000);
}

// salvar no painel de IA (ou trocar o provedor no leitor) reconsulta a saude
window.addEventListener('ml:ai-changed', () => {
  // config nova pode ter quebrado a IA: o aviso precisa voltar mesmo se foi ocultado
  aiBadgeDismissed = false;
  void showAiStatus();
});

await catalog.mount(catalogRoot).catch((e: Error) => toast(`falha ao iniciar: ${e.message}`, 'error'));
void route();
void showAiStatus();
