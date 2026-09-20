import {
  aiHealth,
  clearSeriesMemory,
  explain,
  getAiProviders,
  getEngines,
  getPages,
  getTargets,
  humanizeError,
  saveAiConfig,
  seriesMemory,
  visionTranslate,
  type ChapterRef,
  type PageRef,
  type SeriesDetail,
  type TargetLangInfo,
  type TranslateEngineInfo,
} from './api.ts';
import { el, langLabel, toast } from './ui.ts';
import {
  hasBookmark,
  isFavorite,
  markChapterRead,
  persist,
  resetSettings,
  saveProgress,
  store,
  toggleBookmark,
  toggleFavorite,
  type AiProviderName,
  type FitMode,
  type LetterFont,
  type ReadingMode,
  type TranslateEngine,
  type TranslateMode,
} from './state.ts';
import { MAX_SCALE, Viewer } from './viewer.ts';
import {
  TESS_LANG_OPTIONS,
  disposeOcr,
  effectiveOcrLang,
  isAbortError,
  langFor,
  paintPage,
  recognizePage,
  translateBlocks,
  type OcrBlock,
} from './ocr.ts';
import { numberedPage } from './page-image.ts';

/**
 * Pagina que nao esta' no palco nao tem <img>: carrega uma so' para o OCR.
 * `crossOrigin` e' obrigatorio, senao o canvas fica "tainted" e o OCR nao le.
 */
function loadPageImage(url: string, signal: AbortSignal, timeoutMs = 20_000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    // host que aceita a conexao e nunca responde travaria a fila com `busy` para sempre
    const timer = window.setTimeout(() => finish(new Error('imagem demorou demais')), timeoutMs);
    const onAbort = (): void => finish(new DOMException('OCR cancelado', 'AbortError'));
    const finish = (err: Error | null): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (err) {
        // `src = ''` dispara outro `error`: sem soltar os handlers virava loop infinito
        img.onload = null;
        img.onerror = null;
        img.src = '';
        reject(err);
      } else resolve(img);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    img.onload = () => finish(img.naturalWidth > 0 ? null : new Error('imagem vazia'));
    img.onerror = () => finish(new Error('imagem nao carregou'));
    img.src = url;
  });
}

/** "1 pagina" / "3 paginas" — ui.ts ganha o mesmo helper em outra frente; local ate' la' */
const plural = (n: number, s: string, p = `${s}s`): string => `${n} ${n === 1 ? s : p}`;

/**
 * Espera a imagem do sheet ficar utilizavel. Ouvir so' `load` era uma armadilha:
 * pagina que responde 404 (ou host bloqueado no proxy) nunca emite `load`, a
 * promessa nunca resolvia e o leitor ficava com `busy = true` para sempre — OCR,
 * traducao e fila morriam no capitulo inteiro ate' recarregar o app.
 */
function imageReady(img: HTMLImageElement, timeoutMs = 20_000): Promise<boolean> {
  if (img.complete) return Promise.resolve(img.naturalWidth > 0);
  return new Promise((resolve) => {
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      resolve(ok);
    };
    const onLoad = (): void => done(img.naturalWidth > 0);
    const onError = (): void => done(false);
    const timer = window.setTimeout(() => done(false), timeoutMs);
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
  });
}

/**
 * "🪄 Traduzir" vira icone + <span class="ml-btn-label">Traduzir</span>: em tela
 * estreita o CSS esconde so' o texto. Como display:none tira o texto do nome
 * acessivel, o rotulo inteiro vai para aria-label.
 */
function iconLabel(text: string): { children: (string | HTMLElement)[]; aria: Record<string, string> } {
  const m = /^(\S+)\s+(.+)$/.exec(text);
  if (!m) return { children: [text], aria: {} };
  return { children: [`${m[1]} `, el('span', { class: 'ml-btn-label' }, m[2]!)], aria: { 'aria-label': text } };
}

const MODES: [ReadingMode, string][] = [
  ['single', 'pagina'],
  ['double', 'dupla'],
  ['strip', 'tira'],
];
const FITS: [FitMode, string][] = [
  ['page', 'ajustar'],
  ['width', 'largura'],
  ['height', 'altura'],
];

/** motor/idioma fixados no inicio da execucao — trocar no meio nao mistura carimbos */
interface RunCtx {
  mode: TranslateMode;
  engine: TranslateEngine;
  provider: string;
  /** idioma de destino fixado no inicio: trocar no meio nao pode carimbar espanhol como pt-BR */
  target: string;
  stamp: string;
  modeLabel: string;
  signal: AbortSignal;
}

interface RunStats {
  translated: number;
  failedBalloons: number;
  failed: string[];
}

export class Reader {
  private host = el('section', { class: 'ml-reader', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Leitor', tabindex: '-1' });
  private stage = el('div', { class: 'ml-stage' });
  private stageLoading = el(
    'div',
    { class: 'ml-stage-loading' },
    el('div', { class: 'ml-spinner' }),
    el('span', {}, 'carregando capitulo...'),
  );
  private viewer: Viewer;
  private film = el('div', { class: 'ml-film' });
  private zoomLabel = el('span', { class: 'ml-zoom-label' }, '100%');
  private zoomRange = el('input', {
    class: 'ml-range',
    type: 'range',
    min: '5',
    max: String(MAX_SCALE * 100),
    value: '100',
    'aria-label': 'Zoom',
  });
  private pageLabel = el('span', { class: 'ml-page-label', role: 'status', 'aria-live': 'polite' }, '');
  private chat = el('aside', { class: 'ml-chat' });
  private chatLog = el('div', { class: 'ml-chat-log' });
  private ocrStatus = el('span', { class: 'ml-ocr-status', role: 'status', 'aria-live': 'polite' }, '');
  private progressFill = el('div', { class: 'ml-progress-fill' });
  private progressText = el('span', { class: 'ml-progress-text' }, '');
  private progressBar = el(
    'div',
    {
      class: 'ml-progress',
      role: 'progressbar',
      'aria-label': 'Progresso da traducao do capitulo',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    },
    this.progressFill,
  );
  private progressEl = el('span', { class: 'ml-status-item ml-progress-item', hidden: true }, this.progressBar, this.progressText);
  private aiDot = el('span', { class: 'ml-dot' });
  private aiLabel = el('span', {}, 'IA: verificando...');
  private tooltipEl = el('div', { class: 'ml-balloon-tooltip', hidden: true });
  /** fechamento com carencia: sair um pixel da caixa do balao nao pode apagar o texto */
  private tooltipHideTimer = 0;
  /** balao + conteudo ja' montados: evita remontar (e mover) o tooltip a cada pixel */
  private tooltipSig = '';
  private highlightBox = el('div', { class: 'ml-balloon-highlight', hidden: true });
  private popoverEl = el('div', { class: 'ml-popover', hidden: true });
  private popoverBackdrop = el('div', { class: 'ml-popover-backdrop', hidden: true });
  private popoverOpen = false;
  /** tela estreita ou baixa (celular deitado): a barra vira "voltar / titulo / traduzir / mais" e o resto vai para o popover */
  private compactQuery = window.matchMedia('(max-width: 640px), (max-height: 500px)');
  private aiTimer?: number;
  /**
   * Geracao do `open()`: dois cliques em "cap »" disparam dois getPages e a
   * resposta mais lenta chegava por ultimo, colocando as paginas do capitulo
   * errado no palco (e o OCR gravava cache sob a chave do novo).
   */
  private openGen = 0;
  private loadingChapter = false;
  /** quem tinha o foco antes de abrir: devolvido ao fechar */
  private prevFocus: HTMLElement | null = null;
  private bookmarkBtn?: HTMLElement;

  private detail?: SeriesDetail;
  private chapter?: ChapterRef;
  /** sentido efetivo da obra aberta: HQ ocidental le ao contrario de manga */
  private rtl = true;
  private pages: PageRef[] = [];
  private ocrCache = new Map<string, OcrBlock[]>();
  /**
   * Com que motor+idioma cada pagina do cache foi traduzida. Antes, trocar o
   * idioma de destino limpava o cache inteiro e refazia o Tesseract da pagina —
   * a parte cara — sendo que o texto reconhecido continua valendo: so' a traducao
   * envelhece. Com o carimbo, trocar de idioma so' retraduz.
   */
  private translatedAs = new Map<string, string>();
  /**
   * Carimbo da ultima execucao. Com IA offline a execucao cai no motor web e
   * carimba `ocr|auto|...`; a repintura comparava com o carimbo da preferencia
   * (`ai|...`) e escondia a traducao recem-feita.
   */
  private activeStamp?: string;
  /** tipo de reconhecimento da ultima execucao — ver `ocrKind` e `repaintNow` */
  private activeKind?: 'v' | 't';
  private busy = false;
  /** cartao de fim de obra: uma vez por pagina, nao um toast por tecla */
  private endCard?: HTMLElement;
  private helpEl?: HTMLElement;
  private helpReturnFocus?: HTMLElement;
  private chatAbort?: AbortController;
  /** cancela o OCR/traducao em voo: virar a pagina ou fechar nao espera o Tesseract terminar */
  private ocrAbort?: AbortController;
  /** 'page' = OCR da pagina (virar aborta); 'chapter' = traducao do capitulo (segue em fundo) */
  private runScope: 'page' | 'chapter' = 'page';
  /** capitulos cobertos pela execucao atual (o aberto + o proximo, adiantado) e paginas que faltam */
  private runChapters: string[] = [];
  private runPending = 0;
  private runDone = 0;
  private runTotal = 0;
  /** tooltip fixado por toque (touch nao tem hover) */
  private tooltipPinned = false;
  private aiOk = false;
  private aiError = '';
  private paintHandle = 0;
  private history: { role: 'user' | 'assistant'; content: string }[] = [];

  private engines: TranslateEngineInfo[] = [{ id: 'auto', name: 'Automatico (sem IA primeiro)', needsAi: false, note: '' }];
  private targets: TargetLangInfo[] = [{ id: 'pt-BR', name: 'Portugues (Brasil)' }];
  private aiProviders: { id: string; name: string; baseUrl: string; model: string; visionModel?: string; hasKey: boolean }[] = [];

  /**
   * Troca de capitulo feita de dentro do leitor (cap », fim de capitulo, popover):
   * quem cuida da hash e' o app — sem isto reload/Back reabriam o capitulo antigo.
   */
  onChapterChange?: (detail: SeriesDetail, chapter: ChapterRef) => void;

  constructor(private onExit: () => void) {
    this.viewer = new Viewer({
      onPageChange: (p) => this.onPageChange(p),
      onTransform: ({ scale, fit }) => {
        this.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
        this.zoomRange.value = String(Math.round(scale * 100));
        this.hideTooltip();
        // zoom pela roda vira 'free' e a tira forca 'width': a barra segue o viewer, nao a preferencia
        for (const b of this.host.querySelectorAll<HTMLElement>('[data-fit]')) {
          const on = b.dataset.fit === fit;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', String(on));
        }
      },
      onNavigate: (dir) => this.turn(dir),
      onTap: (x, y) => this.onStageTap(x, y),
      onSheetsChange: () => {
        this.paintOverlays();
        this.hideTooltip();
      },
    });
    this.build();
    document.body.append(this.host);
    document.addEventListener('keydown', this.onKey);
    // girar o celular troca o layout da barra: reconstroi em vez de esperar o proximo clique
    this.compactQuery.addEventListener('change', () => {
      if (this.host.classList.contains('is-open')) this.refreshBars();
      this.syncChatToViewport();
    });
    this.popoverBackdrop.addEventListener('click', () => this.togglePopover(false));
    (window as unknown as { __mangaLens?: unknown }).__mangaLens = {
      translatedKeys: (): string[] => [...this.ocrCache.keys()],
      blocksFor: (key: string): OcrBlock[] => this.ocrCache.get(key) ?? [],
      queuedChapters: (): string[] => this.runChapters,
      queueSize: (): number => this.runPending,
      progress: (): { done: number; total: number } => ({ done: this.runDone, total: this.runTotal }),
    };
    void Promise.all([
      getEngines().catch(() => []),
      getTargets().catch(() => []),
      getAiProviders().catch(() => ({ active: 'ollama' as const, providers: [] })),
    ]).then(([engines, targets, provData]) => {
      if (engines.length) this.engines = engines;
      if (targets.length) this.targets = targets;
      if (provData.providers?.length) {
        this.aiProviders = provData.providers;
        // o servidor e' a fonte da verdade: o padrao 'ollama' do store mostrava
        // "IA offline" enquanto o openrouter ativo no servidor estava saudavel
        if (provData.active && provData.active !== store.settings.aiProvider) {
          store.settings.aiProvider = provData.active;
          persist();
        }
      }
      this.refreshBars();
      // o checkAi do open() pode ter rodado antes do provider certo chegar
      if (this.host.classList.contains('is-open')) void this.checkAi();
    });
  }

  // ---------- montagem ----------

  private build(): void {
    this.host.append(this.buildTopBar(), this.stage, this.buildStatusBar(), this.buildBottomBar(), this.chat, this.tooltipEl, this.popoverBackdrop, this.popoverEl);
    this.viewer.mount(this.stage);
    // mount() reescreve o innerHTML do palco — o overlay so' pode entrar depois
    this.stage.append(this.stageLoading);
    this.viewer.mode = store.settings.mode;
    this.viewer.fit = store.settings.fit;
    this.viewer.rtl = store.settings.rtl;

    this.stage.addEventListener('pointermove', this.onStagePointerMove);
    this.stage.addEventListener('pointerleave', this.onStagePointerLeave);

    this.zoomRange.addEventListener('input', () => this.viewer.setZoom(Number(this.zoomRange.value) / 100));
    this.chat.append(
      el(
        'div',
        { class: 'ml-chat-head' },
        el('strong', {}, 'Assistente de leitura'),
        el('button', { class: 'ml-btn ml-btn-ghost', 'aria-label': 'Fechar assistente', onclick: () => this.closeChat() }, '✕'),
      ),
      this.chatLog,
      this.buildChatInput(),
    );
  }

  private onStagePointerMove = (e: PointerEvent): void => {
    // no touch todo movimento e' arrasto; o tooltip fixado por toque nao pode sumir com ele
    if (this.tooltipPinned || e.pointerType !== 'mouse') return;
    this.checkBalloonHover(e.clientX, e.clientY);
  };

  private onStagePointerLeave = (): void => {
    if (!this.tooltipPinned) this.scheduleHideTooltip();
  };

  /**
   * Touch nao tem hover: um toque em cima do balao fixa o tooltip com o texto
   * original; outro toque em qualquer lugar fecha. Devolve true quando consumiu
   * o toque, para o viewer nao virar a pagina por cima.
   */
  private onStageTap(clientX: number, clientY: number): boolean {
    if (this.tooltipPinned) {
      this.hideTooltip();
      return true;
    }
    const hit = this.findBlockAt(clientX, clientY);
    if (!hit) return false;
    this.showTooltip(hit.block, clientX, clientY, hit.sheet, true);
    return this.tooltipPinned;
  }

  private checkBalloonHover(clientX: number, clientY: number): void {
    // arrastar a pagina e' intencao de mover, nao de ler: fecha na hora
    if (this.viewer.isDragging()) {
      this.hideTooltip();
      return;
    }
    const hit = this.findBlockAt(clientX, clientY);
    if (!hit) {
      // ir com o mouse ate' o tooltip para ler o original nao pode fecha-lo
      if (!this.overTooltip(clientX, clientY)) this.scheduleHideTooltip();
      return;
    }
    this.showTooltip(hit.block, clientX, clientY, hit.sheet);
  }

  /** O proprio tooltip conta como alvo de hover — ele e' transparente ao ponteiro. */
  private overTooltip(clientX: number, clientY: number): boolean {
    if (this.tooltipEl.hidden) return false;
    const pad = 12;
    const r = this.tooltipEl.getBoundingClientRect();
    return clientX >= r.left - pad && clientX <= r.right + pad && clientY >= r.top - pad && clientY <= r.bottom + pad;
  }

  private findBlockAt(clientX: number, clientY: number): { block: OcrBlock; sheet: { page: number; el: HTMLDivElement; x: number; y: number; w: number; h: number } } | null {
    const stageRect = this.stage.getBoundingClientRect();
    const stageX = clientX - stageRect.left;
    const stageY = clientY - stageRect.top;

    const transform = this.viewer.getTransform();
    const canvasX = (stageX - transform.tx) / transform.scale;
    const canvasY = (stageY - transform.ty) / transform.scale;

    for (const sheet of this.viewer.getSheets()) {
      if (canvasX >= sheet.x && canvasX <= sheet.x + sheet.w && canvasY >= sheet.y && canvasY <= sheet.y + sheet.h) {
        const imgX = canvasX - sheet.x;
        const imgY = canvasY - sheet.y;
        const blocks = this.ocrCache.get(this.pageKey(sheet.page));
        if (!blocks || !blocks.length) continue;

        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (imgX >= b.x && imgX <= b.x + b.w && imgY >= b.y && imgY <= b.y + b.h) {
            return { block: b, sheet };
          }
        }
      }
    }
    return null;
  }

  /**
   * O tooltip ancora no balao, nao no ponteiro: enquanto o mouse anda dentro do
   * mesmo balao ele fica parado. Antes ele era remontado e reposicionado a cada
   * `pointermove`, entao fugia do cursor e piscava — e quem tentasse ir ate' ele
   * para ler o original saia da caixa do balao e o perdia.
   */
  private showTooltip(block: OcrBlock, clientX: number, clientY: number, sheet: { el: HTMLDivElement }, pin = false): void {
    const origText = block.text?.trim();
    if (!origText) {
      this.hideTooltip();
      return;
    }
    clearTimeout(this.tooltipHideTimer);
    const sig = `${block.id}|${origText}|${block.pt ?? ''}|${pin ? 'fix' : 'hover'}`;
    // mesmo balao e mesmo texto: nada a remontar, e mexer na posicao so' atrapalharia
    if (!this.tooltipEl.hidden && sig === this.tooltipSig) return;
    this.tooltipSig = sig;
    this.tooltipPinned = pin;

    this.highlightBox.style.left = `${block.x}px`;
    this.highlightBox.style.top = `${block.y}px`;
    this.highlightBox.style.width = `${block.w}px`;
    this.highlightBox.style.height = `${block.h}px`;
    if (this.highlightBox.parentElement !== sheet.el) {
      sheet.el.append(this.highlightBox);
    }
    this.highlightBox.hidden = false;

    this.tooltipEl.innerHTML = '';
    const header = el(
      'div',
      { class: 'ml-tooltip-header' },
      el('span', { class: 'ml-tooltip-tag' }, 'Texto original'),
      block.confidence ? el('span', { class: 'ml-tooltip-confidence' }, `${Math.round(block.confidence)}% conf.`) : el('span', {}),
      pin
        ? el('button', { class: 'ml-btn ml-btn-ghost ml-btn-sm', 'aria-label': 'fechar', onclick: () => this.hideTooltip() }, '✕')
        : null,
    );
    const origEl = el('div', { class: 'ml-tooltip-original' }, origText);
    this.tooltipEl.append(header, origEl);

    if (block.pt && block.pt.trim() && block.pt.trim() !== origText) {
      const transEl = el(
        'div',
        { class: 'ml-tooltip-translated' },
        el('span', { class: 'ml-tooltip-subtag' }, 'Traducao:'),
        block.pt.trim(),
      );
      this.tooltipEl.append(transEl);
    }

    this.tooltipEl.hidden = false;

    const pad = 16;
    const ttW = this.tooltipEl.offsetWidth || 240;
    const ttH = this.tooltipEl.offsetHeight || 80;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    let left = clientX + 16;
    let top = clientY + 16;

    if (left + ttW > vpW - pad) {
      left = Math.max(pad, clientX - ttW - 16);
    }
    if (top + ttH > vpH - pad) {
      top = Math.max(pad, clientY - ttH - 16);
    }

    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.top = `${top}px`;
  }

  /**
   * Fecha depois de uma carencia curta. Sair da caixa do balao por um pixel, ou
   * atravessar o vao entre dois baloes, nao e' intencao de fechar; ir com o mouse
   * ate' o tooltip para ler o original muito menos.
   */
  private scheduleHideTooltip(): void {
    if (this.tooltipPinned) return;
    clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = window.setTimeout(() => this.hideTooltip(), Reader.TOOLTIP_GRACE_MS);
  }

  private static readonly TOOLTIP_GRACE_MS = 320;

  /** Fecha agora: zoom, arrasto, virar pagina e sair do leitor invalidam a ancora. */
  private hideTooltip(): void {
    clearTimeout(this.tooltipHideTimer);
    this.tooltipPinned = false;
    this.tooltipSig = '';
    this.tooltipEl.hidden = true;
    this.highlightBox.hidden = true;
  }

  private toggle(label: string, on: boolean, onclick: () => void, title?: string, extra: Record<string, string> = {}): HTMLElement {
    const { children, aria } = iconLabel(label);
    return el(
      'button',
      { class: `ml-btn ml-btn-sm ${on ? 'is-on' : ''}`, title: title ?? label, 'aria-pressed': String(on), ...aria, onclick, ...extra },
      ...children,
    );
  }

  private togglePopover(open?: boolean): void {
    this.popoverOpen = open !== undefined ? open : !this.popoverOpen;
    this.popoverEl.classList.toggle('is-open', this.popoverOpen);
    this.popoverBackdrop.classList.toggle('is-open', this.popoverOpen);
    this.popoverEl.hidden = !this.popoverOpen;
    this.popoverBackdrop.hidden = !this.popoverOpen;
    const btn = document.getElementById('ml-btn-options');
    if (btn) btn.classList.toggle('is-on', this.popoverOpen);
    if (this.popoverOpen) {
      this.buildPopover();
    }
  }

  private get compact(): boolean {
    return this.compactQuery.matches;
  }

  /** Modo, capa, ajuste e sentido: na barra (desktop) ou no popover (mobile). */
  private readingControls(): [HTMLElement, HTMLElement | null, HTMLElement, HTMLElement] {
    const s = store.settings;
    const modes = el(
      'div',
      { class: 'ml-group' },
      ...MODES.map(([m, label]) =>
        this.toggle(
          label,
          s.mode === m,
          () => {
            s.mode = m;
            persist();
            this.viewer.setMode(m);
            // a tira forca 'width' no viewer: ao sair dela a preferencia do usuario volta
            this.viewer.applyFit(s.fit);
            this.refreshBars();
          },
          m === 'strip' ? 'Tira: roda rola, Ctrl+roda da zoom' : `${label}: roda da zoom, Shift+roda ou toque na lateral vira a pagina`,
        ),
      ),
    );
    const fits = el(
      'div',
      { class: 'ml-group' },
      ...FITS.map(([f, label]) =>
        this.toggle(
          label,
          this.viewer.fit === f,
          () => {
            s.fit = f;
            persist();
            this.viewer.applyFit(f);
            this.refreshBars();
          },
          undefined,
          { 'data-fit': f },
        ),
      ),
      this.toggle('1:1', false, () => this.viewer.setZoom(1), 'Tamanho real (tecla 1)'),
    );
    // capa sozinha na primeira folha: so' faz sentido na dupla
    const coverBtn =
      s.mode === 'double'
        ? this.toggle(
            '↔ capa',
            this.viewer.coverOffset === 1,
            () => this.toggleCoverOffset(),
            'Deslocar a dupla em uma pagina, deixando a capa sozinha (Shift+D)',
            { 'aria-label': 'Deslocar dupla em uma pagina' },
          )
        : null;
    const rtlBtn = this.toggle('RTL', this.rtl, () => {
      this.rtl = !this.rtl;
      s.rtl = this.rtl;
      persist();
      this.viewer.setRtl(this.rtl);
      this.refreshBars();
    }, 'Sentido de leitura japones (direita para esquerda)');
    return [modes, coverBtn, fits, rtlBtn];
  }

  private translateButton(): HTMLElement {
    return el('button', {
      class: 'ml-btn ml-btn-sm ml-btn-action-primary',
      disabled: this.busy,
      onclick: () => void this.runTranslate(),
      title: this.busy ? 'traducao em andamento — use cancelar' : 'Traduzir o capitulo inteiro, a partir desta pagina (tecla R)',
      ...iconLabel('🪄 Traduzir').aria,
    }, ...iconLabel('🪄 Traduzir').children);
  }

  /** OCR/cancelar e Original. */
  private ocrControls(): HTMLElement[] {
    const s = store.settings;
    return [
      // enquanto roda, o botao de OCR vira o unico jeito de abortar sem virar a pagina
      this.busy
        ? el('button', {
            class: 'ml-btn ml-btn-sm is-on',
            'aria-label': 'Cancelar OCR',
            onclick: () => this.ocrAbort?.abort(),
            title: 'Cancelar o OCR/traducao em andamento',
          }, ...iconLabel('✖ cancelar').children)
        : el('button', {
            class: 'ml-btn ml-btn-sm',
            onclick: () => void this.runOcrOnly(),
            disabled: s.translateMode === 'vision',
            title:
              s.translateMode === 'vision'
                ? 'No modo IA com visao o Tesseract nao roda: quem le os baloes e o modelo, ao traduzir'
                : 'Reconhecer texto (OCR) so nas paginas visiveis, sem traduzir (tecla O)',
            ...iconLabel('🔍 OCR').aria,
          }, ...iconLabel('🔍 OCR').children),
      this.toggle(
        s.showOriginal ? '👁️ original (ligado)' : '👁️ Original',
        s.showOriginal,
        () => {
          s.showOriginal = !s.showOriginal;
          persist();
          this.refreshBars();
          this.paintOverlays();
        },
        'Alternar entre a pagina original e os baloes traduzidos (tecla T)',
      ),
    ];
  }

  private optionsButton(label = '⚙️ Opcoes'): HTMLElement {
    return el('button', {
      id: 'ml-btn-options',
      class: `ml-btn ml-btn-sm ${this.popoverOpen ? 'is-on' : ''}`,
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        this.togglePopover();
      },
      title: 'Configuracoes de traducao (modo, provedor, idiomas e letra)',
      ...iconLabel(label).aria,
    }, ...iconLabel(label).children);
  }

  /** Visao, Explicar, marcador e tela cheia. */
  private toolControls(): HTMLElement[] {
    return [
      el('button', {
        class: 'ml-btn ml-btn-sm',
        onclick: () => void this.visionRead(),
        title: 'IA descreve a pagina inteira (modelo de visao)',
        ...iconLabel('🤖 Visao').aria,
      }, ...iconLabel('🤖 Visao').children),
      el('button', {
        class: 'ml-btn ml-btn-sm',
        onclick: () => (this.chat.classList.contains('is-open') ? this.closeChat() : this.openChat()),
        title: 'Assistente de leitura',
        ...iconLabel('💬 Explicar').aria,
      }, ...iconLabel('💬 Explicar').children),
      (this.bookmarkBtn = this.bookmarkButton()),
      // iPhone nao tem requestFullscreen: botao inerte confunde mais que a ausencia
      document.fullscreenEnabled
        ? el('button', {
            class: 'ml-btn ml-btn-sm',
            onclick: () => void this.toggleFullscreen(),
            title: 'Alternar tela cheia (tecla F)',
            'aria-label': 'Alternar tela cheia',
          }, '⛶')
        : null,
    ].filter((n): n is HTMLElement => n !== null);
  }

  // ---------- assistente (painel) ----------

  private openChat(): void {
    this.chat.classList.add('is-open');
    this.syncChatToViewport();
    window.visualViewport?.addEventListener('resize', this.syncChatToViewport);
  }

  private closeChat(): void {
    this.chat.classList.remove('is-open');
    this.chat.style.height = '';
    window.visualViewport?.removeEventListener('resize', this.syncChatToViewport);
  }

  /** teclado virtual (iOS) nao encolhe o layout: o campo do chat ficava atras dele */
  private syncChatToViewport = (): void => {
    const vv = window.visualViewport;
    // girar para paisagem larga com o chat aberto deixava a altura em px do retrato
    if (!this.compact) {
      this.chat.style.height = '';
      return;
    }
    if (!vv || !this.chat.classList.contains('is-open')) return;
    this.chat.style.height = `${Math.round(vv.height)}px`;
  };

  // ---------- atalhos (ajuda) ----------

  private toggleHelp(open?: boolean): void {
    const isOpen = Boolean(this.helpEl);
    const want = open ?? !isOpen;
    if (want === isOpen) return;
    if (!want) {
      this.helpEl?.remove();
      this.helpEl = undefined;
      // fechar com o ✕ focado mandava o foco para o body (Tab recomecava do documento)
      const back = this.helpReturnFocus;
      this.helpReturnFocus = undefined;
      if (back?.isConnected) back.focus();
      else this.host.focus();
      return;
    }
    this.helpReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const rows: [string, string][] = [
      ['← → ↑ ↓ / espaco', 'virar pagina (setas seguem o sentido RTL)'],
      ['R', 'traduzir o capitulo'],
      ['O', 'so OCR nas paginas visiveis, sem traduzir'],
      ['T', 'mostrar/esconder o original'],
      ['F', 'tela cheia'],
      ['0 / 1', 'ajustar a pagina / tamanho real'],
      ['+ / −', 'zoom'],
      ['Shift+D', 'deslocar a dupla (capa sozinha)'],
      ['?', 'esta lista'],
      ['Esc', 'fechar painel / sair do leitor'],
    ];
    this.helpEl = el(
      'div',
      { class: 'ml-help', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Atalhos de teclado' },
      el(
        'div',
        { class: 'ml-popover-head' },
        el('span', { class: 'ml-popover-title' }, 'Atalhos de teclado'),
        el('button', { class: 'ml-btn ml-btn-ghost ml-btn-sm', 'aria-label': 'fechar', onclick: () => this.toggleHelp(false) }, '✕'),
      ),
      el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, v)])),
    );
    this.host.append(this.helpEl);
    this.helpEl.querySelector<HTMLElement>('button')?.focus();
  }

  /** volta modo, ajuste, motor, idiomas e fonte ao padrao — sem isto so' limpando o localStorage */
  private restoreDefaults(): void {
    if (!confirm('Restaurar as configuracoes de leitura e traducao para o padrao?')) return;
    // o provedor de IA vem do servidor (fonte da verdade): o padrao 'ollama' do
    // store nao pode voltar por cima dele
    const aiProvider = store.settings.aiProvider;
    const ocrLangBefore = store.settings.ocrLang;
    resetSettings();
    store.settings.aiProvider = aiProvider;
    persist();
    if (store.settings.ocrLang !== ocrLangBefore) {
      // o texto reconhecido muda com o modelo: o cache inteiro envelhece
      this.ocrAbort?.abort();
      this.ocrCache.clear();
      this.translatedAs.clear();
    }
    this.viewer.setMode(store.settings.mode);
    this.viewer.applyFit(store.settings.fit);
    this.rtl = this.rtlFor(this.detail);
    this.viewer.setRtl(this.rtl);
    this.invalidateTranslations();
    this.refreshBars();
    if (this.popoverOpen) this.buildPopover();
    toast('configuracoes restauradas');
  }

  private originBadge(): HTMLElement {
    const detectedLang = this.chapter?.lang ?? this.detail?.origin;
    const originName = detectedLang ? langLabel(detectedLang) : 'Auto';
    return el('span', { class: 'ml-lang-badge', title: `Idioma original do scan (define o OCR): ${originName}` }, `Origem: ${originName}`);
  }

  private buildTopBar(): HTMLElement {
    const back = el(
      'button',
      { class: 'ml-btn ml-btn-ghost', onclick: () => this.close(), title: 'Voltar ao catalogo', ...iconLabel('‹ voltar').aria },
      ...iconLabel('‹ voltar').children,
    );
    const title = el('div', { class: 'ml-reader-title', id: 'reader-title' });

    // Celular: cinco linhas de botoes deixavam um terco da tela para a pagina.
    // Fica so' o essencial; o resto mora no popover, montado pelos mesmos construtores.
    if (this.compact) {
      return el(
        'header',
        { class: 'ml-reader-top is-compact' },
        back,
        title,
        this.pageLabel,
        // ocupado, o cancelar entra no lugar do Traduzir: no celular ele so' existia dentro do "mais"
        this.busy ? this.ocrControls()[0]! : this.translateButton(),
        this.optionsButton('⋯ mais'),
      );
    }

    const [modes, coverBtn, fits, rtlBtn] = this.readingControls();
    return el(
      'header',
      { class: 'ml-reader-top' },
      // Esquerda: Navegação e Informações
      el('div', { class: 'ml-top-left' }, back, title, this.originBadge(), this.pageLabel),
      // Centro: Modos de Leitura/Ajuste + Ações de Tradução
      el('div', { class: 'ml-top-center' }, modes, coverBtn, fits, rtlBtn, this.translateButton(), ...this.ocrControls()),
      // Direita: Configurações, Assistente e Ferramentas
      el('div', { class: 'ml-top-right' }, this.optionsButton(), ...this.toolControls()),
    );
  }

  /** Secao "Leitura" do popover no mobile: o que saiu da barra. */
  private readingSection(): HTMLElement {
    const [modes, coverBtn, fits, rtlBtn] = this.readingControls();
    const row = (...items: (HTMLElement | null)[]): HTMLElement => el('div', { class: 'ml-popover-row' }, ...items);
    return el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, 'Leitura'),
      row(modes, coverBtn),
      row(fits, rtlBtn),
      row(...this.ocrControls(), this.originBadge()),
      row(...this.toolControls()),
      row(
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.prevChapter(), 'aria-label': 'Capitulo anterior' }, '« capitulo anterior'),
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.nextChapter(), 'aria-label': 'Proximo capitulo' }, 'proximo capitulo »'),
      ),
    );
  }

  private buildPopover(): void {
    const s = store.settings;
    this.popoverEl.innerHTML = '';

    const head = el(
      'div',
      { class: 'ml-popover-head' },
      el('span', { class: 'ml-popover-title' }, 'Configuracoes de traducao'),
      el('button', {
        class: 'ml-btn ml-btn-ghost ml-btn-sm',
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          this.togglePopover(false);
        },
        title: 'Fechar opcoes',
      }, '✕'),
    );

    const isAi = s.translateMode === 'ai';
    const isVision = s.translateMode === 'vision';
    const visionModel = this.aiProviders.find((p) => p.id === s.aiProvider)?.visionModel;
    const pickMode = (next: TranslateMode): ((e: MouseEvent) => void) => (e) => {
      e.stopPropagation();
      s.translateMode = next;
      persist();
      this.invalidateTranslations();
      this.refreshBars();
      this.buildPopover();
    };
    const modeBtn = (label: string, on: boolean, next: TranslateMode, title: string, disabled = false): HTMLElement =>
      el('button', {
        class: `ml-segmented-btn ${on ? 'is-active' : ''}`,
        onclick: pickMode(next),
        title,
        disabled,
        'aria-pressed': String(on),
      }, label);
    const modeSection = el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, 'Modo de traducao'),
      el(
        'div',
        { class: 'ml-segmented' },
        modeBtn('✨ IA (contexto)', isAi, 'ai', 'O LLM traduz o texto que o OCR leu, com glossario e contexto da obra'),
        modeBtn(
          '👁️ IA com visao',
          isVision,
          'vision',
          visionModel
            ? `O modelo de visao (${visionModel}) le os baloes direto da imagem: resolve japones vertical e letra estilizada, que o OCR erra. Gasta mais tokens por pagina`
            : 'Defina um modelo de visao no provedor de IA para usar este modo',
          !visionModel,
        ),
        modeBtn('🌐 Tradutor Web', !isAi && !isVision, 'ocr', 'Google/MyMemory sobre o texto do OCR, sem IA e sem chave'),
      ),
      this.toggle(
        s.autoTranslate ? '⚡ Traduzir ao abrir (ligado)' : '⚡ Traduzir ao abrir',
        s.autoTranslate,
        () => {
          s.autoTranslate = !s.autoTranslate;
          persist();
          this.buildPopover();
        },
        'Comeca a traduzir o capitulo inteiro assim que ele abre, sem apertar Traduzir',
      ),
    );

    const providerSection = el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, isAi || isVision ? 'Provedor de IA' : 'Motor de traducao'),
      isAi || isVision ? this.providerSelect() : this.engineSelect(),
    );

    const targetSection = el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, 'Traduzir para'),
      this.targetSelect(),
    );

    const fontSection = el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, 'Letra dos baloes'),
      this.fontSelect(),
    );

    const ocrLangSection = el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, 'Idioma do OCR'),
      this.ocrLangSelect(),
      this.toggle(
        s.neuralDetect ? '🎯 Detector neural (ligado)' : '🎯 Detector neural',
        s.neuralDetect,
        () => {
          s.neuralDetect = !s.neuralDetect;
          persist();
          // os baloes achados mudam: o OCR em cache envelhece
          this.ocrAbort?.abort();
          this.ocrCache.clear();
          this.translatedAs.clear();
          this.paintOverlays();
          this.buildPopover();
          this.ocrStatus.textContent = 'detector alterado — pressione O ou R';
        },
        'Acha baloes e texto solto com um modelo local (11 MB, baixado uma vez). Desligue para voltar a deteccao antiga por manchas brancas',
      ),
    );

    const foot = el(
      'div',
      { class: 'ml-popover-foot' },
      el('button', { class: 'ml-btn ml-btn-sm ml-btn-ghost', onclick: () => this.toggleHelp(true), title: 'Lista de atalhos (tecla ?)' }, '⌨ atalhos'),
      el('button', { class: 'ml-btn ml-btn-sm ml-btn-ghost', onclick: () => this.restoreDefaults() }, 'restaurar padroes'),
    );

    this.popoverEl.append(head);
    if (this.compact) this.popoverEl.append(this.readingSection());
    this.popoverEl.append(modeSection, providerSection, ...(isAi || isVision ? [this.contextSection()] : []), targetSection, ocrLangSection, fontSection, foot);
  }

  /**
   * Modo IA: a memoria da obra (glossario de nomes/genero + resumo das paginas
   * anteriores) e a opcao de mandar a pagina numerada ao modelo de visao. Limpar
   * existe porque um nome ou genero gravado errado se repetiria no resto da obra.
   */
  private contextSection(): HTMLElement {
    const s = store.settings;
    const series = this.detail?.title;
    const vision = this.aiProviders.find((p) => p.id === s.aiProvider)?.visionModel;
    const info = el('span', { class: 'ml-popover-hint', role: 'status' }, series ? 'lendo memoria da obra...' : 'abra uma obra para ver a memoria');
    const showMemory = (): void => {
      if (!series) return;
      void seriesMemory(series, s.targetLang)
        .then((m) => {
          info.textContent = `${plural(m.glossary.length, 'nome')} no glossario · ${plural(m.notes.length, 'pagina resumida', 'paginas resumidas')}`;
        })
        .catch((err) => {
          info.textContent = `memoria indisponivel: ${humanizeError(err)}`;
        });
    };
    showMemory();
    const seesPage = this.toggle(
      s.aiSeesPage ? '🖼️ IA ve a pagina (ligado)' : '🖼️ IA ve a pagina',
      s.aiSeesPage,
      () => {
        s.aiSeesPage = !s.aiSeesPage;
        persist();
        this.invalidateTranslations();
        this.buildPopover();
      },
      vision
        ? `Manda a pagina reduzida, com os baloes numerados, ao modelo de visao (${vision}): acerta melhor quem fala e o genero, mas gasta mais tokens por pagina`
        : 'Defina um modelo de visao no provedor de IA para usar esta opcao',
    );
    if (!vision) seesPage.setAttribute('disabled', '');
    return el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, 'Contexto da obra'),
      // no modo visao a pagina sempre vai ao modelo: a opcao seria um botao sem efeito
      s.translateMode === 'vision' ? null : seesPage,
      info,
      el('button', {
        class: 'ml-btn ml-btn-sm ml-btn-ghost',
        disabled: !series,
        title: 'Apaga os nomes e o resumo aprendidos nesta obra (use se a IA gravou um nome ou genero errado)',
        onclick: () => {
          if (!series) return;
          void clearSeriesMemory(series, s.targetLang)
            .then(() => {
              toast('memoria da obra apagada');
              showMemory();
            })
            .catch((err) => toast(`nao consegui apagar a memoria: ${humanizeError(err)}`, 'error'));
        },
      }, 'limpar memoria da obra'),
    );
  }

  /**
   * Idioma do scan para o Tesseract. O 'auto' segue o idioma que a fonte declara
   * para o capitulo — e a fonte erra: scan em ingles marcado como "unknown" cai
   * no modelo japones e sai lixo. Aqui o usuario corrige.
   */
  private ocrLangSelect(): HTMLElement {
    return el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'modelo de reconhecimento usado no OCR',
        'aria-label': 'Idioma do OCR',
        onchange: (e: Event) => {
          store.settings.ocrLang = (e.target as HTMLSelectElement).value;
          persist();
          // o texto reconhecido muda com o modelo: o cache inteiro envelhece
          this.ocrAbort?.abort();
          this.ocrCache.clear();
          this.translatedAs.clear();
          this.paintOverlays();
          this.ocrStatus.textContent = 'idioma do OCR alterado — pressione O ou R';
        },
      },
      ...TESS_LANG_OPTIONS.map((o) =>
        el('option', { value: o.code, selected: o.code === store.settings.ocrLang }, o.label),
      ),
    );
  }

  /** Idioma de chegada: vale para os tres motores; trocar reletreira o capitulo. */
  private targetSelect(): HTMLElement {
    return el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'idioma de destino da traducao',
        onchange: (e: Event) => {
          store.settings.targetLang = (e.target as HTMLSelectElement).value;
          persist();
          this.invalidateTranslations();
        },
      },
      ...this.targets.map((t) =>
        el('option', { value: t.id, selected: t.id === store.settings.targetLang }, t.name),
      ),
    );
  }

  /** Motor de traducao: Google ou MyMemory (modo OCR tradicional). */
  private engineSelect(): HTMLElement {
    // este select e' o do Tradutor Web: motor que depende de IA tem modo proprio
    const traditionalEngines = this.engines.filter((eng) => !eng.needsAi);
    const select = el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'motor de traducao dos baloes (modo Tradutor Web)',
        onchange: (e: Event) => {
          store.settings.engine = (e.target as HTMLSelectElement).value as TranslateEngine;
          persist();
          this.invalidateTranslations();
        },
      },
      ...(traditionalEngines.length ? traditionalEngines : this.engines).map((eng) =>
        el('option', { value: eng.id, selected: eng.id === store.settings.engine, title: eng.note }, eng.name),
      ),
    );
    return select;
  }

  private fontSelect(): HTMLElement {
    const fonts: [LetterFont, string, string][] = [
      ['comic', 'Balao de HQ', 'Fonte estilo quadrinhos / manga'],
      ['sans', 'Moderna (Limpa)', 'Fonte limpa e moderna sem serifa'],
      ['serif', 'Classica (livro)', 'Fonte classica de livro impresso'],
    ];
    return el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'letra dos baloes traduzidos',
        onchange: (e: Event) => {
          store.settings.font = (e.target as HTMLSelectElement).value as LetterFont;
          persist();
          this.paintOverlays();
        },
      },
      ...fonts.map(([id, label, desc]) =>
        el('option', { value: id, selected: id === store.settings.font, title: desc }, label),
      ),
    );
  }

  /** Provider de IA: openrouter, ollama, openaicompatible (via AI SDK). */
  private providerSelect(): HTMLElement {
    return el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'provedor de IA (modo IA)',
        onchange: (e: Event) => {
          const active = (e.target as HTMLSelectElement).value as AiProviderName;
          store.settings.aiProvider = active;
          persist();
          this.invalidateTranslations();
          // trocar so' no cliente deixava servidor e leitor discordando do provedor
          void saveAiConfig({ active })
            .catch((err) => toast(`nao consegui ativar o provedor no servidor: ${humanizeError(err)}`, 'error'))
            .finally(() => void this.checkAi());
        },
      },
      ...this.aiProviders.map((p) =>
        el('option', { value: p.id, selected: p.id === store.settings.aiProvider }, `IA: ${p.name}`),
      ),
    );
  }

  private bookmarkButton(): HTMLElement {
    const marked =
      this.chapter !== undefined && hasBookmark(this.chapter.provider, this.chapter.id, this.viewer.currentPage);
    return el(
      'button',
      {
        class: `ml-btn ml-btn-sm ${marked ? 'is-on' : ''}`,
        title: 'marcar esta pagina',
        'aria-pressed': String(marked),
        onclick: () => {
          if (!this.detail || !this.chapter) return;
          const on = toggleBookmark({
            provider: this.detail.provider,
            seriesId: this.detail.id,
            chapterId: this.chapter.id,
            chapterLabel: this.chapterLabel(),
            page: this.viewer.currentPage,
            title: this.detail.title,
            cover: this.detail.cover,
          });
          toast(on ? 'pagina marcada' : 'marcador removido');
          this.refreshBookmark();
        },
      },
      marked ? '🔖 marcado' : '🔖 marcar',
    );
  }

  /** virar a pagina deixava o botao com o estado da pagina anterior: clicar numa ja' marcada removia o marcador */
  private refreshBookmark(): void {
    if (!this.bookmarkBtn?.isConnected) return;
    const next = this.bookmarkButton();
    const hadFocus = document.activeElement === this.bookmarkBtn;
    this.bookmarkBtn.replaceWith(next);
    this.bookmarkBtn = next;
    if (hadFocus) next.focus();
  }

  /**
   * Manga/manhwa le da direita para a esquerda; HQ ocidental, da esquerda para a
   * direita. Abrir uma HQ com o RTL do manga inverte a ordem das paginas na visao
   * dupla e as setas do teclado — por isso a obra decide, e o botao ainda corrige.
   */
  private rtlFor(detail: SeriesDetail | undefined): boolean {
    const western = ['en', 'pt-br', 'pt', 'es', 'fr', 'it', 'de'];
    if (detail?.type === 'comic' || western.includes((detail?.origin ?? '').toLowerCase())) return false;
    return store.settings.rtl;
  }

  private chapterLabel(): string {
    return this.chapter?.number ? `Cap. ${this.chapter.number}` : (this.chapter?.title ?? '');
  }

  /**
   * Barra fixa de status. Sem ela o `traduzir` fica ligado no armazenamento e o
   * leitor segue reconhecendo e traduzindo capitulos que o usuario nunca abriu,
   * sem nenhum sinal na tela nem como interromper.
   */
  private buildStatusBar(): HTMLElement {
    return el(
      'div',
      { class: 'ml-statusbar' },
      el('span', { class: 'ml-status-item' }, this.aiDot, this.aiLabel),
      el('span', { class: 'ml-status-item ml-status-grow' }, this.ocrStatus),
      this.progressEl,
    );
  }

  /**
   * Barra do capitulo. O texto ja' dizia "[3/20]", mas ele e' sobrescrito a cada
   * balao reconhecido: quem olha de longe nao tinha como saber se a fila andou.
   */
  private setProgress(done: number, total: number, label = ''): void {
    this.runDone = done;
    this.runTotal = total;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    this.progressEl.hidden = total <= 0;
    this.progressFill.style.width = `${pct}%`;
    this.progressBar.setAttribute('aria-valuenow', String(pct));
    const text = total > 0 ? `${label}${done}/${total} paginas` : '';
    this.progressText.textContent = text;
    this.progressBar.setAttribute('aria-valuetext', text);
  }

  /** No Tradutor Web a IA e' irrelevante: o "IA: offline" vermelho so' assustava. */
  private syncStatus(): void {
    const item = this.aiLabel.parentElement;
    if (item) item.hidden = store.settings.translateMode === 'ocr';
  }

  /** Estado do endpoint de IA — so' importa quando o motor cai nela. */
  private async checkAi(): Promise<{ ok: boolean; error: string }> {
    try {
      const h = await aiHealth(store.settings.aiProvider);
      this.aiDot.classList.toggle('is-on', Boolean(h.ok));
      const provPrefix = h.provider ? `[${h.provider}] ` : '';
      this.aiLabel.textContent = h.ok ? `IA: ${provPrefix}${h.model}` : `IA: ${provPrefix}offline`;
      this.aiLabel.title = h.ok ? `${h.baseUrl} — ${h.models?.length ?? 0} modelos` : (h.error ?? '');
      this.aiOk = Boolean(h.ok);
      this.aiError = h.error ?? 'sem resposta';
    } catch (err) {
      this.aiDot.classList.remove('is-on');
      this.aiLabel.textContent = 'IA: offline';
      this.aiOk = false;
      this.aiError = humanizeError(err);
    }
    return { ok: this.aiOk, error: this.aiError };
  }

  private buildBottomBar(): HTMLElement {
    const prevBtn = el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.turn(-1), title: 'Pagina anterior', 'aria-label': 'Pagina anterior' }, '‹');
    const nextBtn = el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.turn(1), title: 'Proxima pagina', 'aria-label': 'Proxima pagina' }, '›');
    // celular: uma linha so' — setas nas bordas, filme no meio; capitulo troca pelo popover ou no fim da folha
    if (this.compact) {
      return el('footer', { class: 'ml-reader-bottom is-compact' }, prevBtn, this.film, nextBtn);
    }
    return el(
      'footer',
      { class: 'ml-reader-bottom' },
      el(
        'div',
        { class: 'ml-bottom-nav' },
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.prevChapter(), title: 'Capitulo anterior', 'aria-label': 'Capitulo anterior' }, '« cap'),
        prevBtn,
      ),
      this.film,
      el(
        'div',
        { class: 'ml-bottom-nav' },
        nextBtn,
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.nextChapter(), title: 'Proximo capitulo', 'aria-label': 'Proximo capitulo' }, 'cap »'),
      ),
      el(
        'div',
        { class: 'ml-zoom' },
        el('button', { class: 'ml-btn ml-btn-ghost', title: 'Diminuir zoom (tecla -)', 'aria-label': 'Diminuir zoom', onclick: () => this.viewer.setZoom(this.viewer.zoom / 1.25) }, '−'),
        this.zoomRange,
        el('button', { class: 'ml-btn ml-btn-ghost', title: 'Aumentar zoom (tecla +)', 'aria-label': 'Aumentar zoom', onclick: () => this.viewer.setZoom(this.viewer.zoom * 1.25) }, '+'),
        this.zoomLabel,
      ),
    );
  }

  private buildChatInput(): HTMLElement {
    const input = el('textarea', { class: 'ml-chat-input', rows: '2', placeholder: 'pergunte sobre a cena, personagem, referencia...' });
    const send = (): void => {
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      void this.ask(q);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    return el(
      'div',
      { class: 'ml-chat-foot' },
      input,
      el('button', { class: 'ml-btn ml-btn-primary', onclick: send }, 'perguntar'),
      el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => void this.ask('Explique o que esta acontecendo nesta pagina.') }, 'explicar pagina'),
    );
  }

  private refreshBars(): void {
    const top = this.host.querySelector('.ml-reader-top');
    // a barra e' reconstruida inteira a cada troca de modo/ajuste/marcador, e o
    // controle que o usuario acabou de acionar deixa de existir: sem devolver o
    // foco, navegar so' pelo teclado volta para o inicio do documento a cada clique
    const before = top ? [...top.querySelectorAll('button, select')] : [];
    const focused = before.indexOf(document.activeElement as Element);
    const next = this.buildTopBar();
    top?.replaceWith(next);
    if (focused >= 0) {
      const after = next.querySelectorAll<HTMLElement>('button, select');
      after[focused]?.focus();
    }
    const bottom = this.host.querySelector('.ml-reader-bottom');
    const wantCompact = this.compact;
    if (bottom && bottom.classList.contains('is-compact') !== wantCompact) bottom.replaceWith(this.buildBottomBar());
    // no mobile os toggles vivem no popover: sem remontar, "dupla" continuaria apagado depois do clique.
    // Mas nao por baixo de um <select> aberto: o fim do OCR fechava o dropdown na mao do usuario.
    // No touch o botao tocado fica com o foco, entao so' campos de edicao seguram a remontagem.
    if (this.popoverOpen) {
      const active = document.activeElement as HTMLElement | null;
      const inside = active && this.popoverEl.contains(active);
      const editing = inside && /^(SELECT|INPUT|TEXTAREA)$/.test(active.tagName);
      if (!editing) {
        const key = inside ? (active.getAttribute('aria-label') ?? active.textContent ?? '') : '';
        this.buildPopover();
        if (inside && key) {
          const again = [...this.popoverEl.querySelectorAll<HTMLElement>('button')].find(
            (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '') === key,
          );
          again?.focus({ preventScroll: true });
        }
      }
    }
    const title = this.host.querySelector<HTMLElement>('#reader-title')!;
    title.textContent = this.titleText();
    title.title = this.titleText();
  }

  // ---------- ciclo de leitura ----------

  private titleText(): string {
    if (!this.detail || !this.chapter) return '';
    const num = this.chapter.number ? `Cap. ${this.chapter.number}` : (this.chapter.title ?? '');
    return `${this.detail.title} — ${num}${this.chapter.lang ? ` (${langLabel(this.chapter.lang)})` : ''}`;
  }

  get isOpen(): boolean {
    return this.host.classList.contains('is-open');
  }

  /** O roteador de hash reabriria o mesmo capitulo por cima da leitura em curso. */
  isShowing(provider: string, seriesId: string, chapterId: string): boolean {
    return (
      this.host.classList.contains('is-open') &&
      this.detail?.provider === provider &&
      this.detail?.id === seriesId &&
      this.chapter?.id === chapterId
    );
  }

  async open(detail: SeriesDetail, chapter: ChapterRef, startPage = 0): Promise<void> {
    const gen = ++this.openGen;
    this.loadingChapter = true;
    const sameSeries = this.detail?.provider === detail.provider && this.detail?.id === detail.id;
    if (!this.host.classList.contains('is-open')) {
      this.prevFocus = document.activeElement as HTMLElement | null;
      // o catalogo fica atras do leitor em tela cheia mas continuava na ordem do Tab
      document.querySelector('.ml-main')?.setAttribute('inert', '');
      this.togglePopover(false);
      this.closeChat();
    }
    this.hideEndCard();
    // resposta do chat do capitulo anterior nao pode cair no historico do novo
    this.chatAbort?.abort();
    // OCR de pagina morre com a troca; a traducao do capitulo continua se o
    // destino e' um dos capitulos que ela cobre (o atual ou o adiantado)
    if (!sameSeries || this.runScope === 'page' || !this.runChapters.includes(chapter.id)) this.ocrAbort?.abort();
    this.detail = detail;
    this.chapter = chapter;
    if (!sameSeries) {
      this.ocrCache.clear();
      this.translatedAs.clear();
    }
    this.rtl = this.rtlFor(detail);
    this.viewer.setRtl(this.rtl);
    this.history = [];
    this.chatLog.innerHTML = '';
    this.host.classList.add('is-open');
    document.body.classList.add('is-reading');
    this.host.focus({ preventScroll: true });
    this.refreshBars();
    this.syncStatus();
    // o endpoint pode cair no meio da leitura: reconsulta enquanto o leitor vive
    void this.checkAi();
    clearInterval(this.aiTimer);
    this.aiTimer = window.setInterval(() => void this.checkAi(), 60_000);
    this.film.innerHTML = '';
    this.pageLabel.textContent = 'carregando...';
    this.stageLoading.classList.add('is-visible');

    try {
      const { pages } = await getPages(chapter.provider, chapter.id);
      if (gen !== this.openGen) return;
      if (!pages.length) throw new Error('capitulo sem paginas');
      this.pages = pages;
      // -1 = "ultima pagina" (voltar um capitulo). Capitulo ja' terminado e' tratado
      // por quem chama (main.ts): aqui um marcador na ultima pagina tem de abrir nela.
      if (startPage < 0) startPage = pages.length - 1;
      // ajuste antes das paginas: aplicar depois zerava a rolagem da tira e perdia o startPage
      this.viewer.applyFit(store.settings.fit);
      this.viewer.setPages(pages, startPage);
      this.buildFilm();
      this.paintOverlays();
      this.autoStartTranslate(gen);
    } catch (err) {
      if (gen !== this.openGen) return;
      // `this.chapter` ja' aponta para o capitulo novo: deixar as paginas do
      // anterior no palco faria o OCR gravar pagina velha sob a chave do novo
      this.pages = [];
      this.viewer.setPages([], 0);
      this.film.innerHTML = '';
      this.pageLabel.textContent = 'falhou';
      toast(`capitulo nao abriu: ${humanizeError(err)}`, 'error');
    } finally {
      // a chamada antiga nao pode apagar o spinner da nova
      if (gen === this.openGen) {
        this.loadingChapter = false;
        this.stageLoading.classList.remove('is-visible');
      }
    }
  }

  /**
   * `autoTranslate`: comeca o capitulo sozinho. Espera um quadro porque
   * `runTranslate` parte das folhas visiveis, e elas so' existem depois que o
   * viewer montou o palco. Execucao em andamento (o adiantamento do capitulo
   * anterior, por exemplo) manda: `runTranslate` ja' sai em `busy`.
   */
  private autoStartTranslate(gen: number): void {
    if (!store.settings.autoTranslate || this.busy) return;
    requestAnimationFrame(() => {
      if (gen !== this.openGen || this.busy) return;
      void this.runTranslate();
    });
  }

  close(): void {
    this.hideTooltip();
    this.hideEndCard();
    this.toggleHelp(false);
    this.ocrAbort?.abort();
    this.chatAbort?.abort();
    clearInterval(this.aiTimer);
    this.openGen++;
    this.loadingChapter = false;
    this.stageLoading.classList.remove('is-visible');
    // popover/chat abertos reapareciam no proximo capitulo
    this.togglePopover(false);
    this.closeChat();
    this.host.classList.remove('is-open');
    document.body.classList.remove('is-reading');
    document.querySelector('.ml-main')?.removeAttribute('inert');
    this.prevFocus?.focus?.();
    this.prevFocus = null;
    // workers do Tesseract (WASM + modelos) ficavam residentes depois de sair do leitor
    void disposeOcr().catch(() => undefined);
    this.onExit();
  }

  private buildFilm(): void {
    this.film.innerHTML = '';
    this.pages.forEach((p, i) => {
      this.film.append(
        el(
          'button',
          { class: 'ml-thumb', dataset: { page: String(i) }, onclick: () => this.viewer.goToPage(i) },
          // mesmo CORS do sheet: resposta cacheada sem cabecalhos deixava o canvas do OCR tainted
          el('img', { src: p.url, loading: 'lazy', decoding: 'async', crossorigin: 'anonymous', alt: `pagina ${i + 1}` }),
          el('span', {}, String(i + 1)),
        ),
      );
    });
  }

  private onPageChange(page: number): void {
    // capitulo que nao abriu nao tem pagina: sem esta guarda o `page >= length-1`
    // abaixo daria verdadeiro em 0 >= -1 e marcaria como lido o que nunca abriu
    if (!this.pages.length) return;
    this.hideTooltip();
    this.hideEndCard();
    // OCR da pagina que ficou para tras nao precisa terminar; a traducao do
    // capitulo continua em fundo e pinta a pagina nova quando chegar nela
    if (this.runScope === 'page') this.ocrAbort?.abort();
    this.pageLabel.textContent = `${page + 1} / ${this.pages.length}`;
    for (const t of this.film.children) t.classList.toggle('is-current', t.getAttribute('data-page') === String(page));
    this.film.querySelector('.is-current')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    this.refreshBookmark();
    if (this.detail && this.chapter) {
      saveProgress({
        provider: this.detail.provider,
        seriesId: this.detail.id,
        chapterId: this.chapter.id,
        chapterLabel: this.chapterLabel(),
        page,
        title: this.detail.title,
        cover: this.detail.cover,
        at: Date.now(),
      });
      // chegou na ultima pagina: o capitulo conta como lido. No modo dupla `page`
      // e' a primeira da folha; a ultima folha [8,9] de 10 paginas nunca marcava.
      const lastShown = Math.max(page, ...this.viewer.visibleSheets().map((s) => s.page));
      if (lastShown >= this.pages.length - 1) {
        const { provider, id } = this.detail;
        const chapterId = this.chapter.id;
        if (this.pages.length > 1) markChapterRead(provider, id, chapterId);
        else {
          // capitulo de uma pagina era marcado lido so' de abrir, antes da imagem existir
          const img = this.viewer.visibleSheets()[0]?.img;
          if (img) void imageReady(img).then((ok) => ok && this.chapter?.id === chapterId && markChapterRead(provider, id, chapterId));
        }
      }
    }
    this.paintOverlays();
  }

  /**
   * Virar a pagina disparava duas repinturas completas (`onSheetsChange` e depois
   * `onPageChange`), e cada uma refaz a busca binaria de corpo de letra balao a
   * balao. Juntar no proximo quadro faz o trabalho uma vez so'.
   */
  private paintOverlays(): void {
    if (this.paintHandle) return;
    this.paintHandle = requestAnimationFrame(() => {
      this.paintHandle = 0;
      this.repaintNow();
    });
  }

  private repaintNow(): void {
    // os dois carimbos valem: o fallback web num capitulo nao pode esconder a
    // traducao por IA ja' feita em outro capitulo da mesma obra
    const stamps = new Set([this.stamp(), this.activeStamp ?? this.stamp()]);
    // a execucao pode ter recuado do modo visao para o tradutor web (IA offline):
    // os blocos ficaram sob a chave do OCR, e so' a preferencia atual nao acha
    const kinds = new Set([this.ocrKind(), this.activeKind ?? this.ocrKind()]);
    for (const sheet of this.viewer.visibleSheets()) {
      const key = [...kinds].map((k) => this.pageKey(sheet.page, this.chapter?.id, k)).find((k) => this.ocrCache.has(k)) ?? this.pageKey(sheet.page);
      let blocks = this.ocrCache.get(key);
      // traducao feita com outro motor/idioma nao e' repintada: melhor o balao
      // original que um texto no idioma errado passando por atual
      const made = this.translatedAs.get(key);
      if (blocks?.length && (made === undefined || !stamps.has(made))) blocks = blocks.map((b) => ({ ...b, pt: undefined }));
      const width = sheet.img.naturalWidth || 1;
      const height = sheet.img.naturalHeight || 1;
      paintPage(sheet.ocr, blocks ?? [], {
        showOriginal: store.settings.showOriginal,
        font: store.settings.font,
        width,
        height,
      });
    }
  }

  /**
   * No motor de visao o Tesseract nao roda: os blocos vem sem texto. Servir
   * esses blocos ao modo IA (que traduz o texto do OCR) daria pagina em branco,
   * entao o tipo de reconhecimento entra na chave do cache.
   */
  private ocrKind(mode: TranslateMode = store.settings.translateMode): 'v' | 't' {
    return mode === 'vision' ? 'v' : 't';
  }

  /** Cache por capitulo: a fila adianta paginas de capitulos que ainda nem abriram. */
  private pageKey(page: number, chapterId = this.chapter?.id ?? '', kind = this.ocrKind()): string {
    return `${chapterId}:${page}:${kind}`;
  }

  // ---------- OCR + traducao ----------

  /** Motor + idioma + provider com que uma traducao foi feita; muda um, a traducao vence. */
  private stamp(): string {
    const mode = store.settings.translateMode;
    const prov = mode === 'ocr' ? store.settings.engine : store.settings.aiProvider;
    return `${mode}|${prov}|${store.settings.targetLang}`;
  }

  /**
   * Trocar motor ou idioma de destino invalida a traducao, nao o reconhecimento:
   * o cache continua servindo de entrada e so' a chamada ao tradutor se repete.
   */
  private invalidateTranslations(): void {
    // o carimbo fica: `repaintNow` compara com o atual e esconde a traducao velha
    this.activeStamp = undefined;
    this.activeKind = undefined;
    this.paintOverlays();
    this.syncStatus();
    if (this.translatedAs.size) this.ocrStatus.textContent = 'traducao desatualizada — pressione R';
  }

  /** Controlador novo por execucao; o anterior (se houver) e' abortado. */
  private startRun(scope: 'page' | 'chapter' = 'page'): AbortSignal {
    this.ocrAbort?.abort();
    this.ocrAbort = new AbortController();
    this.runScope = scope;
    this.runChapters = [];
    this.runPending = 0;
    this.setProgress(0, 0);
    this.busy = true;
    this.refreshBars();
    return this.ocrAbort.signal;
  }

  private endRun(): void {
    this.busy = false;
    // lista stale fazia `open()` achar que o proximo capitulo ainda estava coberto
    this.runChapters = [];
    this.runPending = 0;
    this.setProgress(0, 0);
    this.refreshBars();
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('OCR cancelado', 'AbortError');
  }

  /** Reconhece uma folha (ou reaproveita o cache) e devolve os blocos. */
  private async recognizeSheet(
    sheet: { page: number; img: HTMLImageElement },
    signal: AbortSignal,
    chapter: ChapterRef | undefined = this.chapter,
    tag = '',
    mode: TranslateMode = store.settings.translateMode,
  ): Promise<OcrBlock[]> {
    const key = this.pageKey(sheet.page, chapter?.id, this.ocrKind(mode));
    const cached = this.ocrCache.get(key);
    if (cached) return cached;
    // motor de visao: so' o mapeamento dos baloes; quem le o texto e' o modelo
    const read = mode !== 'vision';
    const lang = langFor(chapter?.lang, this.detail?.origin, store.settings.ocrLang);
    // mostra o modelo que vai rodar, nao o rotulo que a fonte declarou
    const langDisplay = effectiveOcrLang(lang);
    const prefix = tag ? `${tag} ` : '';
    this.ocrStatus.textContent = read
      ? `${prefix}OCR pag. ${sheet.page + 1} (${langDisplay})...`
      : `${prefix}mapeando baloes da pag. ${sheet.page + 1}...`;
    const blocks = await recognizePage(
      sheet.img,
      lang,
      (p) => {
        this.ocrStatus.textContent = `${prefix}pag. ${sheet.page + 1}: ${p.stage} ${Math.round(p.ratio * 100)}%`;
      },
      signal,
      { neural: store.settings.neuralDetect, read },
    );
    this.throwIfAborted(signal);
    this.ocrCache.set(key, blocks);
    this.trimCache();
    return blocks;
  }

  private setStatus(text: string, error = false): void {
    this.ocrStatus.textContent = text;
    this.ocrStatus.classList.toggle('ml-status-error', error);
  }

  /** Executa OCR apenas nas paginas visiveis, sem traduzir. */
  private async runOcrOnly(): Promise<void> {
    if (this.busy) return;
    const targets = this.viewer.visibleSheets();
    if (!targets.length) return;
    const signal = this.startRun();

    try {
      let totalBalloons = 0;
      const failed: string[] = [];
      for (const sheet of targets) {
        try {
          if (!(await imageReady(sheet.img))) {
            failed.push(`pag. ${sheet.page + 1} nao carregou`);
            continue;
          }
          const blocks = await this.recognizeSheet(sheet, signal);
          totalBalloons += blocks.length;
          this.paintOverlays();
        } catch (err) {
          if (isAbortError(err)) return this.setStatus('OCR cancelado');
          const msg = humanizeError(err);
          failed.push(`OCR falhou na pag. ${sheet.page + 1}: ${msg}`);
          toast(`OCR falhou: ${msg}`, 'error');
        }
      }
      // o toast some em segundos; o que fica na barra nao pode dizer "sem texto" quando na verdade falhou
      if (failed.length) this.setStatus(failed.join(' · '), true);
      else this.setStatus(totalBalloons ? `OCR: ${plural(totalBalloons, 'balao detectado', 'baloes detectados')}` : 'sem texto nesta pagina');
    } finally {
      this.endRun();
    }
  }

  /**
   * Traduz o capitulo inteiro: primeiro as folhas visiveis (o usuario ve o
   * resultado logo), depois as paginas seguintes ate' o fim e por ultimo as
   * anteriores. Virar a pagina nao interrompe; trocar de capitulo ou fechar sim.
   */
  private async runTranslate(): Promise<void> {
    if (this.busy) return;
    const visible = this.viewer.visibleSheets();
    const chapter = this.chapter;
    if (!visible.length || !this.pages.length || !chapter) return;
    const signal = this.startRun('chapter');
    this.runChapters = [chapter.id];
    this.runPending = this.pages.length;
    const total = this.pages.length;

    try {
      // IA fora do ar: descobrir isso so' depois do OCR (a parte cara) era o pior momento
      let mode = store.settings.translateMode;
      let engine = store.settings.engine;
      if (mode !== 'ocr') {
        const h = await this.checkAi();
        if (signal.aborted) return this.setStatus('OCR cancelado');
        if (!h.ok) {
          if (!confirm(`IA offline (${h.error}). Usar o Tradutor Web (Google/MyMemory) so desta vez?`)) {
            return this.setStatus('IA offline — traducao cancelada', true);
          }
          // so' nesta execucao; a preferencia do usuario continua sendo IA
          mode = 'ocr';
          engine = 'auto';
        }
      }
      const provider = mode === 'ocr' ? engine : store.settings.aiProvider;
      const target = store.settings.targetLang;
      const MODE_LABEL: Record<TranslateMode, string> = {
        ocr: `motor (${provider})`,
        ai: `IA (${provider})`,
        vision: `visao (${provider})`,
      };
      const ctx: RunCtx = {
        mode,
        engine,
        provider,
        target,
        stamp: `${mode}|${provider}|${target}`,
        modeLabel: MODE_LABEL[mode],
        signal,
      };
      this.activeStamp = ctx.stamp;
      this.activeKind = this.ocrKind(mode);
      const stats: RunStats = { translated: 0, failedBalloons: 0, failed: [] };

      // ordem: visiveis, depois da atual ate' o fim, depois do inicio ate' a atual
      const first = Math.min(...visible.map((s) => s.page));
      const order: number[] = visible.map((s) => s.page);
      for (let p = first + 1; p < total; p++) if (!order.includes(p)) order.push(p);
      for (let p = 0; p < first; p++) if (!order.includes(p)) order.push(p);
      const visibleImg = new Map(visible.map((s) => [s.page, s.img]));

      const completed = await this.translatePages(chapter, this.pages, order, visibleImg, ctx, stats, (n) => `[${n}/${total}]`, false, '');
      if (!completed) return;

      // adianta UM capitulo: quando o leitor passar para ele, os baloes ja' saem do cache
      const list = this.siblingChapters();
      const next = list[list.findIndex((c) => c.id === chapter.id) + 1];
      let ahead = 0;
      if (next) {
        try {
          const { pages } = await getPages(next.provider, next.id);
          this.throwIfAborted(signal);
          this.runChapters = [chapter.id, next.id];
          this.runPending = pages.length;
          const label = next.number ? `cap. ${next.number}` : 'proximo capitulo';
          const order2 = pages.map((_, i) => i);
          const ok = await this.translatePages(next, pages, order2, new Map(), ctx, stats, (n) => `adiantando ${label}: [${n}/${pages.length}]`, true, `${label}: `);
          // cancelar aqui nao desfaz o capitulo atual, que ja' esta' pronto
          if (!ok) return this.setStatus('capitulo traduzido; adiantamento do proximo cancelado');
          ahead = pages.length;
        } catch (err) {
          if (isAbortError(err)) return this.setStatus('capitulo traduzido; adiantamento do proximo cancelado');
          // adiantar e' bonus: falha aqui nao suja o resultado do capitulo atual
        }
      }

      const aheadNote = ahead ? ` · proximo capitulo adiantado (${plural(ahead, 'pagina')})` : '';
      if (stats.failed.length) {
        const shown = stats.failed.slice(0, 3).join(' · ');
        this.setStatus(`traducao falhou em ${plural(stats.failed.length, 'pagina')}: ${shown}${stats.failed.length > 3 ? ' ...' : ''}`, true);
      } else if (stats.failedBalloons) {
        this.setStatus(
          `capitulo: ${stats.translated} de ${plural(stats.translated + stats.failedBalloons, 'balao', 'baloes')} traduzidos; ${plural(stats.failedBalloons, 'falhou', 'falharam')} — pressione R para tentar de novo`,
          true,
        );
      } else {
        this.setStatus(
          (stats.translated ? `capitulo traduzido: ${plural(stats.translated, 'balao', 'baloes')} em ${plural(total, 'pagina')}` : 'sem baloes para traduzir') + aheadNote,
        );
      }
    } finally {
      this.endRun();
    }
  }

  /**
   * OCR + traducao de uma lista de paginas de um capitulo (aberto ou nao).
   * Devolve false quando cancelado — o status ja' foi escrito.
   *
   * Duas etapas, nao uma: o reconhecimento e' CPU (e o pool do Tesseract nao
   * aceita duas paginas ao mesmo tempo), entao segue em serie; a traducao e'
   * rede, e ficava parada esperando — agora ate' PAGE_CONCURRENCY paginas
   * traduzem enquanto a proxima e' reconhecida. O teto existe porque o Google
   * responde 429 em rajada (o servidor tambem limita, por processo).
   */
  private async translatePages(
    chapter: ChapterRef,
    pages: PageRef[],
    order: number[],
    visibleImg: Map<number, HTMLImageElement>,
    ctx: RunCtx,
    stats: RunStats,
    progress: (n: number) => string,
    ahead = false,
    barLabel = '',
  ): Promise<boolean> {
    let done = 0;
    let cancelled = false;
    const inFlight = new Set<Promise<void>>();
    const pageTag = (page: number): string => (chapter.id === this.chapter?.id ? `pag. ${page + 1}` : `cap. ${chapter.number ?? '?'} pag. ${page + 1}`);
    const bump = (): void => {
      done++;
      this.runPending = pages.length - done;
      this.setProgress(done, pages.length, barLabel);
    };
    const fail = (page: number, err: unknown): void => {
      const msg = humanizeError(err);
      stats.failed.push(`${pageTag(page)}: ${msg}`);
      // um erro por pagina inundaria a tela em capitulo longo: toast so' no primeiro
      if (stats.failed.length === 1) toast(`Traducao falhou: ${msg}`, 'error');
    };

    this.setProgress(0, pages.length, barLabel);
    for (const page of order) {
      if (cancelled) break;
      const key = this.pageKey(page, chapter.id, this.ocrKind(ctx.mode));
      const tag = progress(done + 1);
      let ready: { blocks: OcrBlock[]; pending: OcrBlock[]; img?: HTMLImageElement } | null = null;
      try {
        ready = await this.preparePage(chapter, pages, page, key, visibleImg, ctx, stats, tag);
      } catch (err) {
        if (isAbortError(err)) {
          cancelled = true;
          break;
        }
        fail(page, err);
      }
      if (!ready) {
        bump();
        continue;
      }
      // a vaga so' abre quando uma traducao em voo termina; ate' la' o OCR espera
      while (inFlight.size >= Reader.PAGE_CONCURRENCY) await Promise.race(inFlight);
      const prepared = ready;
      const task = (async (): Promise<void> => {
        try {
          await this.translateOnePage(chapter, page, key, prepared, ctx, stats, tag);
        } catch (err) {
          if (isAbortError(err)) cancelled = true;
          else fail(page, err);
        } finally {
          bump();
        }
      })();
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }
    // cancelado ou nao, o que ja' foi enviado precisa pousar antes do relatorio
    await Promise.all(inFlight);
    if (cancelled) {
      if (!ahead) this.setStatus(`traducao cancelada (${done} de ${plural(pages.length, 'pagina')})`);
      return false;
    }
    return true;
  }

  /** Quantas paginas podem estar com a traducao em voo ao mesmo tempo. */
  private static readonly PAGE_CONCURRENCY = 3;

  /**
   * Etapa serial: cache, imagem e reconhecimento. `null` = nada a traduzir nesta
   * pagina (ja' pronta, sem baloes ou imagem que nao carregou) — quem chama so'
   * conta a pagina e segue.
   */
  private async preparePage(
    chapter: ChapterRef,
    pages: PageRef[],
    page: number,
    key: string,
    visibleImg: Map<number, HTMLImageElement>,
    ctx: RunCtx,
    stats: RunStats,
    tag: string,
  ): Promise<{ blocks: OcrBlock[]; pending: OcrBlock[]; img?: HTMLImageElement } | null> {
    const cached = this.ocrCache.get(key);
    // o modelo de visao le a imagem: sem ela nao ha' traducao, cache ou nao
    const needsImage = ctx.mode === 'vision' || (ctx.mode === 'ai' && store.settings.aiSeesPage);
    // ja' traduzida com este motor/idioma e sem lote vazio: nem carrega a imagem
    if (cached && this.translatedAs.get(key) === ctx.stamp && cached.every((b) => b.pt?.trim())) {
      stats.translated += cached.length;
      return null;
    }
    let img = visibleImg.get(page);
    if (img) {
      if (!(await imageReady(img))) {
        stats.failed.push(`${chapter.id === this.chapter?.id ? `pag. ${page + 1}` : `cap. ${chapter.number ?? '?'} pag. ${page + 1}`} nao carregou`);
        return null;
      }
    } else if (!cached || needsImage) {
      this.setStatus(`${tag} carregando pag. ${page + 1}...`);
      img = await loadPageImage(pages[page]!.url, ctx.signal);
    }
    this.throwIfAborted(ctx.signal);
    const blocks = cached ?? (await this.recognizeSheet({ page, img: img! }, ctx.signal, chapter, tag, ctx.mode));
    if (!blocks.length) {
      this.translatedAs.set(key, ctx.stamp);
      return null;
    }
    // ja' traduzida com este motor/idioma: so' refaz o que voltou vazio
    const pending = this.translatedAs.get(key) === ctx.stamp ? blocks.filter((b) => !b.pt?.trim()) : blocks;
    if (!pending.length) {
      stats.translated += blocks.length;
      return null;
    }
    return { blocks, pending, img };
  }

  /** Etapa paralela: a chamada ao tradutor e a pintura da pagina. */
  private async translateOnePage(
    chapter: ChapterRef,
    page: number,
    key: string,
    ready: { blocks: OcrBlock[]; pending: OcrBlock[]; img?: HTMLImageElement },
    ctx: RunCtx,
    stats: RunStats,
    tag: string,
  ): Promise<void> {
    const { blocks, pending, img } = ready;
    this.setStatus(`${tag} pag. ${page + 1}: traduzindo ${plural(pending.length, 'balao', 'baloes')} via ${ctx.modeLabel}...`);
    const seesPage = img && (ctx.mode === 'vision' || (ctx.mode === 'ai' && store.settings.aiSeesPage)) ? img : undefined;
    const translated = await translateBlocks(pending, {
      sourceLang: chapter.lang ?? this.detail?.origin,
      series: this.detail?.title,
      chapter: chapter.number,
      page,
      rtl: this.rtl,
      pageImage: seesPage ? numberedPage(seesPage, pending) : undefined,
      engine: ctx.mode === 'ocr' ? ctx.engine : ctx.mode === 'vision' ? 'vision' : 'llm',
      target: ctx.target,
      provider: ctx.mode === 'ocr' ? undefined : ctx.provider,
    });
    // a chamada nao e' abortavel; o resultado de um capitulo que ja' ficou para tras e' descartado
    this.throwIfAborted(ctx.signal);
    const byId = new Map(translated.map((b) => [b.id, b]));
    const merged = blocks.map((b) => {
      const t = byId.get(b.id);
      return t ? { ...b, pt: t.pt, text: t.text } : b;
    });
    this.ocrCache.set(key, merged);
    this.trimCache();
    this.translatedAs.set(key, ctx.stamp);
    // lote que o servidor nao conseguiu traduzir volta com `pt` vazio: nao e' sucesso
    const ok = merged.filter((b) => b.pt?.trim()).length;
    stats.translated += ok;
    stats.failedBalloons += merged.length - ok;
    this.paintOverlays();
  }

  /**
   * Cada pagina guarda mascaras e, para texto solto, um canvas de fundo
   * reconstruido (`bgCanvas`) — que e' relido a cada repintura, entao nao da'
   * para descartar depois de pintar. Em 3000 paginas isso passava de centenas
   * de MB numa sessao longa; 200 cobre varios capitulos de ida e volta.
   */
  private static readonly CACHE_LIMIT = 200;

  private trimCache(): void {
    while (this.ocrCache.size > Reader.CACHE_LIMIT) {
      const oldest = this.ocrCache.keys().next().value;
      if (oldest === undefined) break;
      this.ocrCache.delete(oldest);
      this.translatedAs.delete(oldest);
    }
  }

  /** Caminho paralelo ao OCR: manda a pagina inteira para um modelo com visao. */
  private async visionRead(): Promise<void> {
    const sheet = this.viewer.visibleSheets()[0];
    if (!sheet) return;
    this.openChat();
    const bubble = this.pushMessage('assistant', 'lendo a pagina com o modelo de visao...');
    try {
      // sem a imagem decodificada o canvas sai 0x0 e o modelo recebe "data:," vazio
      if (!(await imageReady(sheet.img))) {
        bubble.textContent = 'a pagina ainda nao carregou; tente de novo';
        return;
      }
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1400 / (sheet.img.naturalWidth || 1400));
      canvas.width = Math.round(sheet.img.naturalWidth * scale);
      canvas.height = Math.round(sheet.img.naturalHeight * scale);
      canvas.getContext('2d')!.drawImage(sheet.img, 0, 0, canvas.width, canvas.height);
      const { balloons } = await visionTranslate({
        imageDataUrl: canvas.toDataURL('image/jpeg', 0.85),
        series: this.detail?.title,
        chapter: this.chapter?.number,
        provider: store.settings.aiProvider,
      });
      bubble.textContent = balloons.length
        ? balloons.map((b, i) => `${i + 1}. ${b.pt}\n   (${b.original})`).join('\n')
        : 'o modelo nao encontrou texto na pagina';
    } catch (err) {
      bubble.textContent = `falhou: ${humanizeError(err)}`;
    }
  }

  // ---------- assistente ----------

  private pushMessage(role: 'user' | 'assistant', text: string): HTMLElement {
    const body = el('div', { class: 'ml-msg-body' }, text);
    this.chatLog.append(el('div', { class: `ml-msg is-${role}` }, body));
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    return body;
  }

  private async ask(question: string): Promise<void> {
    this.openChat();
    this.pushMessage('user', question);
    const bubble = this.pushMessage('assistant', '');
    const pageText = this.viewer
      .visibleSheets()
      .flatMap((s) => this.ocrCache.get(this.pageKey(s.page)) ?? [])
      .map((b) => b.pt || b.text)
      .filter(Boolean);

    // resposta longa sem como parar (ate' 120s de servidor): botao de parar por pergunta
    this.chatAbort?.abort();
    const abort = new AbortController();
    this.chatAbort = abort;
    const stop = el('button', { class: 'ml-btn ml-btn-ghost ml-btn-sm ml-chat-stop', 'aria-label': 'parar resposta', onclick: () => abort.abort() }, '■ parar');
    bubble.parentElement?.append(stop);

    let full = '';
    try {
      for await (const chunk of explain(
        {
          series: this.detail?.title,
          description: this.detail?.description,
          chapter: this.chapter?.number,
          pageText,
          question,
          history: this.history.slice(-6),
          provider: store.settings.aiProvider,
        },
        abort.signal,
      )) {
        full += chunk;
        bubble.textContent = full;
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
      }
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: full });
      if (!full.trim()) bubble.textContent = '(o modelo devolveu vazio — confira o modelo e o limite de tokens no painel de IA)';
    } catch (err) {
      // o que ja' chegou vale: apagar a resposta parcial era pior que o erro
      const why = isAbortError(err) ? '' : `: ${humanizeError(err)}`;
      bubble.textContent = full ? `${full}\n\n(interrompido${why})` : `falhou${why || ': interrompido'}`;
    } finally {
      stop.remove();
      if (this.chatAbort === abort) this.chatAbort = undefined;
    }
  }

  // ---------- navegacao ----------

  private siblingChapters(): ChapterRef[] {
    const lang = this.chapter?.lang;
    return (this.detail?.chapters ?? []).filter((c) => c.lang === lang);
  }

  private stepChapter(delta: number): void {
    if (this.loadingChapter) return;
    const list = this.siblingChapters();
    const i = list.findIndex((c) => c.id === this.chapter?.id);
    const next = list[i + delta];
    if (!next || !this.detail) {
      if (delta > 0) this.showEndCard();
      else toast('inicio da obra');
      return;
    }
    // trocar pelo popover (mobile) deixava o painel cobrindo a pagina nova
    this.togglePopover(false);
    // voltar um capitulo quer a ultima pagina dele, nao a primeira
    this.onChapterChange?.(this.detail, next);
    void this.open(this.detail, next, delta < 0 ? -1 : 0);
  }

  /**
   * Fim da obra: um toast por tecla ("nao ha proximo") nao dizia o que fazer.
   * O cartao aparece uma vez por pagina e oferece voltar/favoritar.
   */
  private showEndCard(): void {
    if (this.endCard || !this.detail) return;
    const d = this.detail;
    const lang = this.chapter?.lang;
    const mine = this.siblingChapters().length;
    const others = new Map<string, number>();
    for (const c of d.chapters) {
      if (c.lang === lang) continue;
      const k = c.lang ?? '';
      others.set(k, (others.get(k) ?? 0) + 1);
    }
    const more = [...others].filter(([, n]) => n > mine).map(([l, n]) => `${plural(n - mine, 'capitulo')} a mais em ${langLabel(l || 'unknown')}`);
    const favBtn = (): HTMLElement => {
      const on = isFavorite(d.provider, d.id);
      return el(
        'button',
        {
          class: `ml-btn ml-btn-sm ${on ? 'is-on' : ''}`,
          'aria-pressed': String(on),
          onclick: (e: Event) => {
            toggleFavorite({ provider: d.provider, id: d.id, title: d.title, cover: d.cover });
            (e.currentTarget as HTMLElement).replaceWith(favBtn());
          },
        },
        on ? '★ favoritado' : '☆ favoritar para acompanhar',
      );
    };
    this.endCard = el(
      'div',
      { class: 'ml-end-card', role: 'status' },
      el('button', { class: 'ml-btn ml-btn-ghost ml-btn-sm ml-end-close', 'aria-label': 'fechar', onclick: () => this.hideEndCard() }, '✕'),
      el('strong', {}, `Voce chegou ao ultimo capitulo disponivel${lang ? ` (${langLabel(lang)})` : ''}`),
      more.length ? el('p', {}, more.join(' · ')) : null,
      el(
        'div',
        { class: 'ml-end-actions' },
        el('button', { class: 'ml-btn ml-btn-sm ml-btn-primary', onclick: () => this.close() }, 'voltar a obra'),
        favBtn(),
      ),
    );
    this.stage.append(this.endCard);
  }

  private hideEndCard(): void {
    this.endCard?.remove();
    this.endCard = undefined;
  }

  /** vira a pagina; no fim/inicio do capitulo passa para o vizinho em vez de nao fazer nada */
  private turn(dir: 1 | -1): void {
    if (!this.pages.length) return;
    const moved = dir > 0 ? this.viewer.next() : this.viewer.prev();
    if (!moved) this.stepChapter(dir);
  }

  private nextChapter(): void {
    this.stepChapter(1);
  }
  private prevChapter(): void {
    this.stepChapter(-1);
  }

  /** capa sozinha na primeira folha da dupla; vale so' nesta sessao */
  private toggleCoverOffset(): void {
    this.viewer.setCoverOffset(this.viewer.coverOffset === 1 ? 0 : 1);
    this.refreshBars();
  }

  private async toggleFullscreen(): Promise<void> {
    // iPhone: `requestFullscreen` e' undefined e chamar lancaria antes do .catch
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.host.requestFullscreen().catch(() => undefined);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.host.classList.contains('is-open')) return;
    // Esc vale ate' com o foco num select/textarea (fechar o popover ou o chat de dentro deles)
    if (e.key === 'Escape') {
      if (this.popoverOpen) this.togglePopover(false);
      else if (this.helpEl) this.toggleHelp(false);
      else if (this.chat.classList.contains('is-open')) this.closeChat();
      else if (this.endCard) this.hideEndCard();
      else if (document.fullscreenElement) void document.exitFullscreen();
      else this.close();
      return;
    }
    // <select> das opcoes: seta troca a opcao E virava a pagina, letras disparavam OCR
    const target = e.target as HTMLElement | null;
    if (/^(TEXTAREA|INPUT|SELECT)$/.test(target?.tagName ?? '') || target?.isContentEditable) return;
    // Ctrl+R recarregava E traduzia, Ctrl+T abria aba E alternava o original
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const rtl = this.rtl;
    switch (e.key) {
      case '?':
        this.toggleHelp();
        break;
      case 'ArrowRight':
        this.turn(rtl ? -1 : 1);
        break;
      case 'ArrowLeft':
        this.turn(rtl ? 1 : -1);
        break;
      case 'ArrowDown':
      case ' ':
        e.preventDefault();
        this.turn(1);
        break;
      case 'ArrowUp':
        this.turn(-1);
        break;
      case '+':
      case '=':
        this.viewer.setZoom(this.viewer.zoom * 1.25);
        break;
      case '-':
        this.viewer.setZoom(this.viewer.zoom / 1.25);
        break;
      case '0':
        this.viewer.applyFit('page');
        break;
      case '1':
        this.viewer.setZoom(1);
        break;
      case 'o':
      case 'O':
        if (this.busy) toast('aguarde, traducao em andamento (botao cancelar para abortar)');
        else void this.runOcrOnly();
        break;
      case 'r':
      case 'R':
        if (this.busy) toast('aguarde, traducao em andamento (botao cancelar para abortar)');
        else void this.runTranslate();
        break;
      case 't':
      case 'T':
        store.settings.showOriginal = !store.settings.showOriginal;
        persist();
        this.refreshBars();
        this.paintOverlays();
        break;
      case 'D':
        if (!e.shiftKey || store.settings.mode !== 'double') return;
        this.toggleCoverOffset();
        break;
      case 'f':
      case 'F':
        void this.toggleFullscreen();
        break;
      default:
        return;
    }
  };
}
