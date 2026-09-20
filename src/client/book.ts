import { getBookChapter, humanizeError, translate, type ChapterRef, type SeriesDetail } from './api.ts';
import { markChapterRead, persist, saveProgress, store } from './state.ts';
import { el, toast } from './ui.ts';

interface Para {
  id: number;
  text: string;
  pt?: string;
  node: HTMLParagraphElement;
}

/** Paragrafos por requisicao. Lote grande economiza chamada; lote enorme estoura o contexto do modelo. */
const BATCH = 10;
/** Lotes simultaneos — o mesmo teto de paginas do leitor de imagem, pela mesma razao (429). */
const PARALLEL = 3;
const FONT_MIN = 14;
const FONT_MAX = 28;

const isAbortError = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError';

/**
 * Leitor de livro: EPUB nao tem pagina nem balao, entao o OCR nao entra. O
 * capitulo chega como paragrafos numerados do servidor e vai ao mesmo
 * `/api/ai/translate` que o leitor de manga usa — so' o palco e' outro.
 */
export class BookReader {
  private host = el('section', {
    class: 'ml-book',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Leitor de livro',
    tabindex: '-1',
  });
  private titleEl = el('div', { class: 'ml-book-title' });
  private article = el('article', { class: 'ml-book-page' });
  private statusEl = el('span', { class: 'ml-book-status', role: 'status', 'aria-live': 'polite' }, '');
  private progressFill = el('div', { class: 'ml-progress-fill' });
  private progressBar = el(
    'div',
    {
      class: 'ml-progress',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
      hidden: true,
    },
    this.progressFill,
  );
  private translateBtn = el(
    'button',
    { class: 'ml-btn ml-btn-sm ml-btn-action-primary', onclick: () => this.toggleTranslate() },
    'traduzir',
  );

  private detail?: SeriesDetail;
  private chapter?: ChapterRef;
  private paras: Para[] = [];
  private busy = false;
  private abort?: AbortController;
  /** invalida trabalho de um capitulo que ja' foi trocado */
  private gen = 0;
  private saveTimer?: number;

  onChapterChange?: (detail: SeriesDetail, chapter: ChapterRef) => void;

  constructor(private readonly onExit: () => void) {
    document.body.append(this.host);
    this.host.append(this.buildTopBar(), this.article);
    this.host.addEventListener('keydown', (e) => this.onKey(e));
    this.article.addEventListener('scroll', () => this.scheduleSave());
    this.applyFont();
  }

  private buildTopBar(): HTMLElement {
    return el(
      'header',
      { class: 'ml-book-top' },
      el(
        'div',
        { class: 'ml-top-left' },
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.close(), 'aria-label': 'Voltar ao catalogo' }, '‹ voltar'),
        this.titleEl,
      ),
      el(
        'div',
        { class: 'ml-top-center' },
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.goChapter(-1), 'aria-label': 'Capitulo anterior' }, '«'),
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.goChapter(1), 'aria-label': 'Proximo capitulo' }, '»'),
        this.translateBtn,
        this.progressBar,
        this.statusEl,
      ),
      el(
        'div',
        { class: 'ml-top-right' },
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.bumpFont(-2), 'aria-label': 'Diminuir a letra' }, 'A-'),
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.bumpFont(2), 'aria-label': 'Aumentar a letra' }, 'A+'),
      ),
    );
  }

  get isOpen(): boolean {
    return this.host.classList.contains('is-open');
  }

  isShowing(provider: string, seriesId: string, chapterId: string): boolean {
    return this.isOpen && this.detail?.provider === provider && this.detail.id === seriesId && this.chapter?.id === chapterId;
  }

  async open(detail: SeriesDetail, chapter: ChapterRef, startBlock = 0): Promise<void> {
    const gen = ++this.gen;
    this.cancel();
    this.detail = detail;
    this.chapter = chapter;
    this.paras = [];
    this.host.classList.add('is-open');
    this.host.focus({ preventScroll: true });
    this.titleEl.textContent = `${detail.title} — ${chapter.title ?? `cap. ${chapter.number ?? ''}`}`;
    this.article.replaceChildren(el('p', { class: 'ml-book-note' }, 'carregando o capitulo...'));
    this.setProgress(0, 0);

    let blocks: { id: number; text: string }[];
    try {
      blocks = (await getBookChapter(chapter.id)).blocks;
    } catch (err) {
      if (gen !== this.gen) return;
      this.article.replaceChildren(el('p', { class: 'ml-book-note' }, `nao consegui abrir o capitulo: ${humanizeError(err)}`));
      return;
    }
    if (gen !== this.gen) return;

    this.paras = blocks.map((b) => {
      const node = el('p', { class: 'ml-book-p', dataset: { id: String(b.id) } }, b.text);
      node.addEventListener('click', () => this.toggleOriginal(b.id));
      return { id: b.id, text: b.text, node };
    });
    this.article.replaceChildren(
      ...(this.paras.length ? this.paras.map((p) => p.node) : [el('p', { class: 'ml-book-note' }, 'capitulo sem texto')]),
    );
    this.statusEl.textContent = `${this.paras.length} paragrafos`;
    this.scrollTo(startBlock);
    if (store.settings.autoTranslate && this.paras.length) void this.runTranslate();
  }

  close(): void {
    this.cancel();
    this.gen++;
    this.host.classList.remove('is-open');
    this.onExit();
  }

  private cancel(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.busy = false;
    this.translateBtn.textContent = 'traduzir';
    this.setProgress(0, 0);
  }

  private toggleTranslate(): void {
    if (this.busy) {
      this.cancel();
      this.statusEl.textContent = 'traducao cancelada';
      return;
    }
    void this.runTranslate();
  }

  /**
   * Motor: no modo OCR o livro usa o mesmo motor web do manga; em IA ou visao
   * cai em `llm` — sem pagina para olhar, o motor de visao nao teria o que ler.
   */
  private engineFor(): string {
    const s = store.settings;
    if (s.translateMode !== 'ocr') return 'llm';
    return s.engine === 'vision' || s.engine === 'llm' ? 'auto' : s.engine;
  }

  private setProgress(done: number, total: number): void {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    this.progressBar.hidden = total <= 0;
    this.progressFill.style.width = `${pct}%`;
    this.progressBar.setAttribute('aria-valuenow', String(pct));
    this.progressBar.setAttribute('aria-valuetext', total > 0 ? `${done}/${total} trechos` : '');
  }

  private async runTranslate(): Promise<void> {
    if (this.busy || !this.detail || !this.chapter || !this.paras.length) return;
    const gen = this.gen;
    const detail = this.detail;
    const chapter = this.chapter;
    const abort = new AbortController();
    this.abort = abort;
    this.busy = true;
    this.translateBtn.textContent = '✖ cancelar';

    const lots: Para[][] = [];
    for (let i = 0; i < this.paras.length; i += BATCH) lots.push(this.paras.slice(i, i + BATCH));
    let done = 0;
    let failed = 0;
    let lastError = '';
    this.setProgress(0, lots.length);
    this.statusEl.textContent = 'traduzindo...';

    const engine = this.engineFor();
    const run = async (lot: Para[], index: number): Promise<void> => {
      try {
        const res = await translate({
          blocks: lot.map((p) => ({ id: p.id, text: p.text })),
          sourceLang: detail.origin,
          series: detail.title,
          chapter: chapter.number ?? chapter.title,
          page: index,
          engine,
          target: store.settings.targetLang,
          provider: store.settings.aiProvider,
        });
        if (gen !== this.gen || abort.signal.aborted) return;
        for (const t of res.translations) this.applyTranslation(t.id, t.pt);
      } catch (err) {
        if (isAbortError(err)) return;
        failed++;
        lastError = humanizeError(err);
      } finally {
        done++;
        if (gen === this.gen) this.setProgress(done, lots.length);
      }
    };

    const queue = lots.map((lot, i) => () => run(lot, i));
    const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (abort.signal.aborted || gen !== this.gen) return;
        await next();
      }
    });
    await Promise.all(workers);

    if (gen !== this.gen) return;
    this.busy = false;
    this.abort = undefined;
    this.translateBtn.textContent = 'traduzir';
    this.setProgress(0, 0);
    if (abort.signal.aborted) return;
    this.statusEl.textContent = failed
      ? `traduzido com ${failed} trecho(s) perdido(s)`
      : `capitulo traduzido (${this.paras.length} paragrafos)`;
    if (failed) toast(`parte do capitulo nao traduziu: ${lastError}`, 'error');
    markChapterRead(detail.provider, detail.id, chapter.id);
  }

  private applyTranslation(id: number, pt: string): void {
    const para = this.paras.find((p) => p.id === id);
    if (!para || !pt.trim()) return;
    para.pt = pt;
    para.node.textContent = pt;
    para.node.classList.add('is-translated');
    para.node.title = 'clique para ver o original';
  }

  /** Clicar num paragrafo troca entre original e traducao — o equivalente ao balao do manga. */
  private toggleOriginal(id: number): void {
    const para = this.paras.find((p) => p.id === id);
    if (!para?.pt) return;
    const showingOriginal = para.node.classList.toggle('is-original');
    para.node.textContent = showingOriginal ? para.text : para.pt;
  }

  private bumpFont(delta: number): void {
    store.settings.bookFontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, store.settings.bookFontSize + delta));
    persist();
    this.applyFont();
  }

  private applyFont(): void {
    this.article.style.fontSize = `${store.settings.bookFontSize}px`;
  }

  private scrollTo(index: number): void {
    const target = this.paras[index]?.node;
    if (target) target.scrollIntoView({ block: 'start' });
    else this.article.scrollTop = 0;
  }

  /** Primeiro paragrafo visivel — e' o "onde parei" do livro, equivalente a pagina. */
  private currentIndex(): number {
    const top = this.article.getBoundingClientRect().top;
    const found = this.paras.findIndex((p) => p.node.getBoundingClientRect().bottom > top);
    return found < 0 ? 0 : found;
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 400);
  }

  private saveNow(): void {
    if (!this.detail || !this.chapter || !this.paras.length) return;
    saveProgress({
      provider: this.detail.provider,
      seriesId: this.detail.id,
      chapterId: this.chapter.id,
      chapterLabel: this.chapter.title ?? this.chapter.number ?? '',
      page: this.currentIndex(),
      title: this.detail.title,
      cover: this.detail.cover,
      at: Date.now(),
    });
  }

  private goChapter(step: number): void {
    if (!this.detail || !this.chapter) return;
    const list = this.detail.chapters;
    const at = list.findIndex((c) => c.id === this.chapter?.id);
    const next = list[at + step];
    if (!next) {
      toast(step > 0 ? 'ultimo capitulo' : 'primeiro capitulo');
      return;
    }
    this.saveNow();
    this.onChapterChange?.(this.detail, next);
    void this.open(this.detail, next, 0);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      this.toggleTranslate();
    } else if (e.key === '[') this.goChapter(-1);
    else if (e.key === ']') this.goChapter(1);
  }
}
