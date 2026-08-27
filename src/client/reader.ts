import { aiHealth, explain, getPages, visionTranslate, type ChapterRef, type PageRef, type SeriesDetail } from './api.ts';
import { el, langLabel, toast } from './ui.ts';
import {
  hasBookmark,
  markChapterRead,
  persist,
  saveProgress,
  store,
  toggleBookmark,
  type FitMode,
  type LetterFont,
  type ReadingMode,
  type TranslateEngine,
} from './state.ts';
import { getEngines, getTargets, type TargetLangInfo, type TranslateEngineInfo } from './api.ts';
import { Viewer } from './viewer.ts';
import { langFor, paintPage, recognizePage, translateBlocks, type OcrBlock } from './ocr.ts';

/** Carrega a imagem fora da tela com CORS, para o canvas do OCR poder ler os pixels. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.addEventListener('load', () => resolve(img), { once: true });
    img.addEventListener('error', () => reject(new Error(`imagem nao carregou: ${url}`)), { once: true });
    img.src = url;
  });
}

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

export class Reader {
  private host = el('section', { class: 'ml-reader' });
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
  private zoomRange = el('input', { class: 'ml-range', type: 'range', min: '5', max: '600', value: '100' });
  private pageLabel = el('span', { class: 'ml-page-label' }, '');
  private chat = el('aside', { class: 'ml-chat' });
  private chatLog = el('div', { class: 'ml-chat-log' });
  private ocrStatus = el('span', { class: 'ml-ocr-status' }, '');
  private aiDot = el('span', { class: 'ml-dot' });
  private aiLabel = el('span', {}, 'IA: verificando...');
  private queueInfo = el('span', { class: 'ml-status-queue' }, '');
  private autoBtn = el('button', { class: 'ml-btn ml-btn-sm' }, 'auto');
  private aiTimer?: number;

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
  private busy = false;
  /** pedido explicito de OCR feito enquanto outro estava em curso */
  private ocrRequested = false;
  private paintHandle = 0;
  private history: { role: 'user' | 'assistant'; content: string }[] = [];

  /** fila de adiantamento: paginas do capitulo atual e dos proximos, em ordem */
  private queue: { chapter: ChapterRef; page: number; url: string }[] = [];
  private queueRunning = false;
  private enqueued = new Set<string>();
  private pagesByChapter = new Map<string, PageRef[]>();
  private generation = 0;
  private engines: TranslateEngineInfo[] = [{ id: 'auto', name: 'Automatico (sem IA primeiro)', needsAi: false, note: '' }];
  private targets: TargetLangInfo[] = [{ id: 'pt-BR', name: 'Portugues (Brasil)' }];

  constructor(private onExit: () => void) {
    this.viewer = new Viewer({
      onPageChange: (p) => this.onPageChange(p),
      onTransform: ({ scale }) => {
        this.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
        this.zoomRange.value = String(Math.round(scale * 100));
      },
      onSheetsChange: () => this.paintOverlays(),
    });
    this.build();
    document.body.append(this.host);
    document.addEventListener('keydown', this.onKey);
    // janela de inspecao usada pela homologacao (e util para depurar a fila)
    (window as unknown as { __mangaLens?: unknown }).__mangaLens = {
      translatedKeys: (): string[] => [...this.ocrCache.keys()],
      queueSize: (): number => this.queue.length,
      queuedChapters: (): string[] => [...new Set(this.queue.map((i) => i.chapter.id))],
      blocksFor: (key: string): OcrBlock[] => this.ocrCache.get(key) ?? [],
    };
    void Promise.all([getEngines().catch(() => []), getTargets().catch(() => [])]).then(([engines, targets]) => {
      if (engines.length) this.engines = engines;
      if (targets.length) this.targets = targets;
      this.refreshBars();
    });
  }

  // ---------- montagem ----------

  private build(): void {
    this.host.append(this.buildTopBar(), this.stage, this.buildStatusBar(), this.buildBottomBar(), this.chat);
    this.viewer.mount(this.stage);
    // mount() reescreve o innerHTML do palco — o overlay so' pode entrar depois
    this.stage.append(this.stageLoading);
    this.viewer.mode = store.settings.mode;
    this.viewer.fit = store.settings.fit;
    this.viewer.rtl = store.settings.rtl;

    this.zoomRange.addEventListener('input', () => this.viewer.setZoom(Number(this.zoomRange.value) / 100));
    this.chat.append(
      el(
        'div',
        { class: 'ml-chat-head' },
        el('strong', {}, 'Assistente de leitura'),
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.chat.classList.remove('is-open') }, '✕'),
      ),
      this.chatLog,
      this.buildChatInput(),
    );
  }

  private toggle(label: string, on: boolean, onclick: () => void, title?: string): HTMLElement {
    return el('button', { class: `ml-btn ml-btn-sm ${on ? 'is-on' : ''}`, title: title ?? label, onclick }, label);
  }

  private buildTopBar(): HTMLElement {
    const s = store.settings;
    const modes = el(
      'div',
      { class: 'ml-group' },
      ...MODES.map(([m, label]) =>
        this.toggle(label, s.mode === m, () => {
          s.mode = m;
          persist();
          this.viewer.setMode(m);
          this.refreshBars();
        }),
      ),
    );
    const fits = el(
      'div',
      { class: 'ml-group' },
      ...FITS.map(([f, label]) =>
        this.toggle(label, s.fit === f, () => {
          s.fit = f;
          persist();
          this.viewer.applyFit(f);
          this.refreshBars();
        }),
      ),
      this.toggle('1:1', false, () => this.viewer.setZoom(1)),
    );

    return el(
      'header',
      { class: 'ml-reader-top' },
      el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.close() }, '‹ voltar'),
      el('div', { class: 'ml-reader-title', id: 'reader-title' }),
      this.pageLabel,
      modes,
      fits,
      this.toggle('RTL', this.rtl, () => {
        this.rtl = !this.rtl;
        s.rtl = this.rtl;
        persist();
        this.viewer.setRtl(this.rtl);
        this.refreshBars();
      }, 'sentido de leitura japones (direita para esquerda)'),
      el('div', { class: 'ml-group' },
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => void this.runOcr(true) }, 'OCR'),
        this.engineSelect(),
        this.targetSelect(),
        this.fontSelect(),
        this.toggle('traduzir', s.autoTranslate, () => {
          s.autoTranslate = !s.autoTranslate;
          persist();
          this.refreshBars();
          if (s.autoTranslate) {
            void this.runOcr(false);
            void this.pumpQueue();
          } else {
            this.stopQueue();
            this.ocrStatus.textContent = '';
          }
        }, 'traduz os baloes para pt-BR e segue adiantando os proximos capitulos'),
        this.toggle('original', s.showOriginal, () => {
          s.showOriginal = !s.showOriginal;
          persist();
          this.refreshBars();
          this.paintOverlays();
        }, 'mostra o texto reconhecido em vez da traducao'),
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => void this.visionRead() }, 'IA le a pagina'),
      ),
      this.bookmarkButton(),
      el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.chat.classList.toggle('is-open') }, 'explicar'),
      el('button', { class: 'ml-btn ml-btn-sm', onclick: () => void this.toggleFullscreen() }, '⛶'),
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

  /** Motor de traducao: com IA (contexto) ou tradutor classico, sem IA nenhuma. */
  private engineSelect(): HTMLElement {
    const select = el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'motor de traducao dos baloes',
        onchange: (e: Event) => {
          store.settings.engine = (e.target as HTMLSelectElement).value as TranslateEngine;
          persist();
          this.invalidateTranslations();
        },
      },
      ...this.engines.map((eng) =>
        el('option', { value: eng.id, selected: eng.id === store.settings.engine, title: eng.note }, eng.name),
      ),
    );
    return select;
  }

  private fontSelect(): HTMLElement {
    const fonts: [LetterFont, string][] = [
      ['comic', 'letreiro'],
      ['sans', 'sem serifa'],
      ['serif', 'serifada'],
    ];
    return el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'fonte do letreiramento da traducao',
        onchange: (e: Event) => {
          store.settings.font = (e.target as HTMLSelectElement).value as LetterFont;
          persist();
          this.paintOverlays();
        },
      },
      ...fonts.map(([id, label]) =>
        el('option', { value: id, selected: id === store.settings.font }, label),
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
          this.refreshBars();
        },
      },
      marked ? '🔖 marcado' : '🔖 marcar',
    );
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
    this.autoBtn.addEventListener('click', () => {
      const s = store.settings;
      s.autoTranslate = !s.autoTranslate;
      persist();
      if (s.autoTranslate) {
        void this.runOcr(false);
        void this.pumpQueue();
      } else {
        this.stopQueue();
        this.ocrStatus.textContent = '';
      }
      this.refreshBars();
      this.syncStatus();
    });

    return el(
      'div',
      { class: 'ml-statusbar' },
      el('span', { class: 'ml-status-item' }, this.aiDot, this.aiLabel),
      el('span', { class: 'ml-status-item ml-status-grow' }, this.ocrStatus),
      el('span', { class: 'ml-status-item' }, this.queueInfo),
      this.autoBtn,
    );
  }

  /** Reflete na barra o que a fila esta' fazendo agora. */
  private syncStatus(): void {
    const on = store.settings.autoTranslate;
    this.autoBtn.textContent = on ? 'parar auto' : 'auto desligado';
    this.autoBtn.classList.toggle('is-on', on);

    if (!on) {
      this.queueInfo.textContent = '';
      return;
    }
    const chapters = [...new Set(this.queue.map((i) => i.chapter.number ?? i.chapter.id))];
    this.queueInfo.textContent = this.queue.length
      ? `fila: ${this.queue.length} pag. · cap. ${chapters.slice(0, 3).join(', ')}${chapters.length > 3 ? '...' : ''}`
      : 'fila vazia';
  }

  /** Estado do endpoint de IA — so' importa quando o motor cai nela. */
  private async checkAi(): Promise<void> {
    try {
      const h = await aiHealth();
      this.aiDot.classList.toggle('is-on', Boolean(h.ok));
      this.aiLabel.textContent = h.ok ? `IA: ${h.model}` : 'IA: offline';
      this.aiLabel.title = h.ok ? `${h.baseUrl} — ${h.models?.length ?? 0} modelos` : (h.error ?? '');
    } catch {
      this.aiDot.classList.remove('is-on');
      this.aiLabel.textContent = 'IA: offline';
    }
  }

  private buildBottomBar(): HTMLElement {
    return el(
      'footer',
      { class: 'ml-reader-bottom' },
      el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.prevChapter() }, '« cap'),
      el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.viewer.prev() }, '‹'),
      this.film,
      el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.viewer.next() }, '›'),
      el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.nextChapter() }, 'cap »'),
      el(
        'div',
        { class: 'ml-zoom' },
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.viewer.setZoom(this.viewer.zoom / 1.25) }, '−'),
        this.zoomRange,
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.viewer.setZoom(this.viewer.zoom * 1.25) }, '+'),
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
    this.host.querySelector('#reader-title')!.textContent = this.titleText();
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
    const sameSeries = this.detail?.provider === detail.provider && this.detail?.id === detail.id;
    this.detail = detail;
    this.chapter = chapter;
    // seguir para o proximo capitulo da mesma obra aproveita o que a fila ja' traduziu
    if (!sameSeries) {
      this.ocrCache.clear();
      this.translatedAs.clear();
      this.pagesByChapter.clear();
    }
    this.rtl = this.rtlFor(detail);
    this.viewer.setRtl(this.rtl);
    this.stopQueue();
    this.history = [];
    this.chatLog.innerHTML = '';
    this.host.classList.add('is-open');
    document.body.classList.add('is-reading');
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
      if (!pages.length) throw new Error('capitulo sem paginas');
      this.pages = pages;
      this.viewer.setPages(pages, startPage);
      this.viewer.applyFit(store.settings.fit);
      this.buildFilm();
      this.pagesByChapter.set(chapter.id, pages);
      if (store.settings.autoTranslate) {
        this.paintOverlays();
        void this.runOcr(false);
        void this.pumpQueue();
      }
    } catch (err) {
      // `this.chapter` ja' aponta para o capitulo novo: deixar as paginas do
      // anterior no palco faria o OCR gravar pagina velha sob a chave do novo
      this.pages = [];
      this.viewer.setPages([], 0);
      this.film.innerHTML = '';
      this.pageLabel.textContent = 'falhou';
      toast(`capitulo nao abriu: ${(err as Error).message}`, 'error');
    } finally {
      this.stageLoading.classList.remove('is-visible');
    }
  }

  close(): void {
    this.stopQueue();
    clearInterval(this.aiTimer);
    this.host.classList.remove('is-open');
    document.body.classList.remove('is-reading');
    this.onExit();
  }

  private buildFilm(): void {
    this.film.innerHTML = '';
    this.pages.forEach((p, i) => {
      this.film.append(
        el(
          'button',
          { class: 'ml-thumb', dataset: { page: String(i) }, onclick: () => this.viewer.goToPage(i) },
          el('img', { src: p.url, loading: 'lazy', alt: `pagina ${i + 1}` }),
          el('span', {}, String(i + 1)),
        ),
      );
    });
  }

  private onPageChange(page: number): void {
    // capitulo que nao abriu nao tem pagina: sem esta guarda o `page >= length-1`
    // abaixo daria verdadeiro em 0 >= -1 e marcaria como lido o que nunca abriu
    if (!this.pages.length) return;
    this.pageLabel.textContent = `${page + 1} / ${this.pages.length}`;
    for (const t of this.film.children) t.classList.toggle('is-current', t.getAttribute('data-page') === String(page));
    this.film.querySelector('.is-current')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
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
      // chegou na ultima pagina: o capitulo conta como lido
      if (page >= this.pages.length - 1) {
        markChapterRead(this.detail.provider, this.detail.id, this.chapter.id);
      }
    }
    this.paintOverlays();
    if (store.settings.autoTranslate) void this.runOcr(false);
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
    for (const sheet of this.viewer.visibleSheets()) {
      const blocks = this.ocrCache.get(this.pageKey(sheet.page));
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

  /** Cache por capitulo: a fila adianta paginas de capitulos que ainda nem abriram. */
  private pageKey(page: number, chapterId = this.chapter?.id ?? ''): string {
    return `${chapterId}:${page}`;
  }

  // ---------- OCR + traducao ----------

  /** Motor + idioma com que uma traducao foi feita; muda um, a traducao vence. */
  private stamp(): string {
    return `${store.settings.engine}|${store.settings.targetLang}`;
  }

  /** Pagina ja' reconhecida E traduzida com o motor/idioma atuais. */
  private isFresh(key: string): boolean {
    return this.ocrCache.has(key) && this.translatedAs.get(key) === this.stamp();
  }

  /**
   * Trocar motor ou idioma de destino invalida a traducao, nao o reconhecimento:
   * o cache continua servindo de entrada e so' a chamada ao tradutor se repete.
   */
  private invalidateTranslations(): void {
    this.translatedAs.clear();
    this.enqueued.clear();
    this.queue.length = 0;
    this.paintOverlays();
    if (store.settings.autoTranslate) {
      void this.runOcr(true, true);
      void this.pumpQueue();
    }
  }

  private async runOcr(force: boolean, reuseOcr = false): Promise<void> {
    if (this.busy) {
      // Pedido explicito (botao OCR, tecla `o`, troca de idioma) era descartado em
      // silencio quando a pagina anterior ainda estava sendo reconhecida: o usuario
      // clicava e nada acontecia, sem nenhuma mensagem. Fica agendado.
      if (force) {
        this.ocrRequested = true;
        this.ocrStatus.textContent = 'OCR pedido: entra assim que a pagina atual terminar';
      }
      return;
    }
    const targets = this.viewer.visibleSheets().filter((s) => force || !this.isFresh(this.pageKey(s.page)));
    if (!targets.length) return;
    this.busy = true;

    try {
      for (const sheet of targets) {
        // uma pagina quebrada nao pode levar junto as outras do mesmo spread
        try {
          if (!(await imageReady(sheet.img))) {
            this.ocrStatus.textContent = `pag. ${sheet.page + 1} nao carregou`;
            continue;
          }
          const key = this.pageKey(sheet.page);
          const blocks = await this.processImage(sheet.img, this.chapter, `pag. ${sheet.page + 1}`, key, reuseOcr);
          this.ocrCache.set(key, blocks);
          this.paintOverlays();
          this.ocrStatus.textContent = blocks.length ? `${blocks.length} baloes` : 'sem texto nesta pagina';
        } catch (err) {
          this.ocrStatus.textContent = '';
          toast(`OCR/traducao falhou: ${(err as Error).message}`, 'error');
        }
      }
    } finally {
      this.busy = false;
      if (this.ocrRequested) {
        this.ocrRequested = false;
        void this.runOcr(true, reuseOcr);
      } else {
        void this.pumpQueue();
      }
    }
  }

  /** OCR + traducao de uma imagem ja' carregada. Serve tanto a pagina atual quanto a fila. */
  private async processImage(
    img: HTMLImageElement,
    chapter: ChapterRef | undefined,
    label: string,
    key: string,
    reuseOcr: boolean,
  ): Promise<OcrBlock[]> {
    // reconhecer e' a parte cara; quando so' a traducao venceu, reaproveita
    let blocks = reuseOcr ? this.ocrCache.get(key) : undefined;
    if (!blocks) {
      const lang = langFor(chapter?.lang, this.detail?.origin, store.settings.ocrLang);
      this.ocrStatus.textContent = `OCR ${label} (${lang})...`;
      blocks = await recognizePage(img, lang, (p) => {
        this.ocrStatus.textContent = `${label}: ${p.stage} ${Math.round(p.ratio * 100)}%`;
      });
    }
    // pagina sem balao ja' esta' pronta para qualquer idioma
    if (!blocks.length) {
      this.translatedAs.set(key, this.stamp());
      return blocks;
    }
    // sem traducao ligada nao ha' o que carimbar: ligar o `traduzir` depois
    // precisa encontrar a pagina como pendente, nao como pronta
    if (!store.settings.autoTranslate) return blocks;

    this.ocrStatus.textContent = `${label}: traduzindo ${blocks.length} baloes...`;
    // carimbo lido AGORA, nao no fim: se o usuario trocar de idioma enquanto esta
    // pagina traduz, ela guarda o idioma com que foi realmente traduzida e a troca
    // volta a alcanca-la
    const stamp = this.stamp();
    const translated = await translateBlocks(blocks, {
      sourceLang: chapter?.lang ?? this.detail?.origin,
      series: this.detail?.title,
      chapter: chapter?.number,
      engine: store.settings.engine,
      target: store.settings.targetLang,
    });
    // so' depois de traduzir de fato: tradutor que falha nao pode deixar a pagina
    // marcada como pronta e nunca mais ser tentada
    this.translatedAs.set(key, stamp);
    return translated;
  }

  // ---------- fila: traduz os proximos capitulos em sequencia ----------

  private static readonly LOOKAHEAD = 60;
  private static readonly CACHE_LIMIT = 3000;

  /** Enfileira o que falta do capitulo atual e segue pelos proximos, em ordem. */
  private async fillQueue(): Promise<void> {
    if (!this.detail || !this.chapter) return;
    // `stopQueue` zera a fila, mas um fillQueue em voo terminava depois e a
    // repopulava — parar precisa valer tambem para o enfileiramento em curso
    const mine = this.generation;
    const list = this.siblingChapters();
    let index = Math.max(
      list.findIndex((c) => c.id === this.chapter!.id),
      0,
    );
    let fromPage = this.viewer.currentPage;

    while (this.queue.length < Reader.LOOKAHEAD && index < list.length) {
      if (this.generation !== mine) return;
      const chapter = list[index]!;
      let pages = this.pagesByChapter.get(chapter.id);
      if (!pages) {
        if (chapter.id === this.chapter.id) pages = this.pages;
        else pages = (await getPages(chapter.provider, chapter.id).catch(() => ({ pages: [] }))).pages;
        this.pagesByChapter.set(chapter.id, pages);
      }
      // a busca de paginas acima e' assincrona: o usuario pode ter parado no meio
      if (this.generation !== mine) return;
      for (let p = fromPage; p < pages.length && this.queue.length < Reader.LOOKAHEAD; p++) {
        const key = this.pageKey(p, chapter.id);
        if (this.isFresh(key) || this.enqueued.has(key)) continue;
        this.enqueued.add(key);
        this.queue.push({ chapter, page: p, url: pages[p]!.url });
      }
      index++;
      fromPage = 0;
    }
  }

  /** Um item por vez: OCR e' pesado e a leitura do usuario tem prioridade. */
  private async pumpQueue(): Promise<void> {
    if (this.queueRunning || !store.settings.autoTranslate) return;
    if (!this.host.classList.contains('is-open')) return;
    this.queueRunning = true;
    const mine = this.generation;

    try {
      while (store.settings.autoTranslate && this.generation === mine && this.host.classList.contains('is-open')) {
        if (this.busy) break; // usuario pediu OCR da pagina atual: cede a vez
        if (!this.queue.length) await this.fillQueue();
        const item = this.queue.shift();
        if (!item) break;

        const label = `${item.chapter.number ? `cap. ${item.chapter.number}` : 'cap.'} pag. ${item.page + 1}`;
        try {
          const img = await loadImage(item.url);
          const key = this.pageKey(item.page, item.chapter.id);
          const blocks = await this.processImage(img, item.chapter, label, key, true);
          if (this.generation !== mine) break;
          this.ocrCache.set(key, blocks);
          this.trimCache();
          if (item.chapter.id === this.chapter?.id) this.paintOverlays();
        } catch (err) {
          console.error(`[fila] ${label}: ${(err as Error).message}`);
        }
        this.ocrStatus.textContent = `adiantando (${this.queue.length} na fila)`;
        this.syncStatus();
        // devolve o quadro para a UI nao travar entre paginas
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.queueRunning = false;
    }
  }

  private stopQueue(): void {
    this.generation++;
    this.queue = [];
    this.enqueued.clear();
    this.syncStatus();
  }

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
    this.chat.classList.add('is-open');
    const bubble = this.pushMessage('assistant', 'lendo a pagina com o modelo de visao...');
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1400 / (sheet.img.naturalWidth || 1400));
      canvas.width = Math.round(sheet.img.naturalWidth * scale);
      canvas.height = Math.round(sheet.img.naturalHeight * scale);
      canvas.getContext('2d')!.drawImage(sheet.img, 0, 0, canvas.width, canvas.height);
      const { balloons } = await visionTranslate({
        imageDataUrl: canvas.toDataURL('image/jpeg', 0.85),
        series: this.detail?.title,
        chapter: this.chapter?.number,
      });
      bubble.textContent = balloons.length
        ? balloons.map((b, i) => `${i + 1}. ${b.pt}\n   (${b.original})`).join('\n')
        : 'o modelo nao encontrou texto na pagina';
    } catch (err) {
      bubble.textContent = `falhou: ${(err as Error).message}`;
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
    this.chat.classList.add('is-open');
    this.pushMessage('user', question);
    const bubble = this.pushMessage('assistant', '');
    const pageText = this.viewer
      .visibleSheets()
      .flatMap((s) => this.ocrCache.get(this.pageKey(s.page)) ?? [])
      .map((b) => b.pt || b.text)
      .filter(Boolean);

    try {
      let full = '';
      for await (const chunk of explain({
        series: this.detail?.title,
        description: this.detail?.description,
        chapter: this.chapter?.number,
        pageText,
        question,
        history: this.history.slice(-6),
      })) {
        full += chunk;
        bubble.textContent = full;
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
      }
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: full });
      if (!full.trim()) bubble.textContent = '(o modelo devolveu vazio — confira AI_MODEL e AI_MAX_TOKENS)';
    } catch (err) {
      bubble.textContent = `falhou: ${(err as Error).message}`;
    }
  }

  // ---------- navegacao ----------

  private siblingChapters(): ChapterRef[] {
    const lang = this.chapter?.lang;
    return (this.detail?.chapters ?? []).filter((c) => c.lang === lang);
  }

  private stepChapter(delta: number): void {
    const list = this.siblingChapters();
    const i = list.findIndex((c) => c.id === this.chapter?.id);
    const next = list[i + delta];
    if (!next || !this.detail) return toast('nao ha capitulo nessa direcao');
    void this.open(this.detail, next, 0);
  }

  private nextChapter(): void {
    this.stepChapter(1);
  }
  private prevChapter(): void {
    this.stepChapter(-1);
  }

  private async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.host.requestFullscreen().catch(() => undefined);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.host.classList.contains('is-open')) return;
    if ((e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    const rtl = this.rtl;
    switch (e.key) {
      case 'ArrowRight':
        if (rtl) this.viewer.prev();
        else this.viewer.next();
        break;
      case 'ArrowLeft':
        if (rtl) this.viewer.next();
        else this.viewer.prev();
        break;
      case 'ArrowDown':
      case ' ':
        e.preventDefault();
        this.viewer.next();
        break;
      case 'ArrowUp':
        this.viewer.prev();
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
        void this.runOcr(true);
        break;
      case 't':
        store.settings.showOriginal = !store.settings.showOriginal;
        persist();
        this.paintOverlays();
        break;
      case 'f':
        void this.toggleFullscreen();
        break;
      case 'Escape':
        if (document.fullscreenElement) void document.exitFullscreen();
        else this.close();
        break;
      default:
        return;
    }
  };
}
