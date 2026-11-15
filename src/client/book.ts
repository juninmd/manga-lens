import { getBookChapter, getTargets, humanizeError, translate, type ChapterRef, type SeriesDetail, type TargetLangInfo } from './api.ts';
import { openGlossary } from './glossary.ts';
import { markChapterRead, persist, saveProgress, store, translateStyle, type BookTheme, type Honorifics, type Tone } from './state.ts';
import { el, toast } from './ui.ts';

interface Para {
  id: number;
  text: string;
  pt?: string;
  /** linha do paragrafo: no modo bilingue guarda as duas colunas */
  row: HTMLDivElement;
  node: HTMLParagraphElement;
  /** coluna do original no modo bilingue; vazia ate' o paragrafo ser traduzido */
  src: HTMLParagraphElement;
}

/** Paragrafos por requisicao. Lote grande economiza chamada; lote enorme estoura o contexto do modelo. */
const BATCH = 10;
/** Letras por requisicao: dez paragrafos de romance russo passam de 10 mil letras, e ai' o teto e' este. */
const BATCH_CHARS = 3600;
/** Lotes simultaneos — o mesmo teto de paginas do leitor de imagem, pela mesma razao (429). */
const PARALLEL = 3;
const FONT_MIN = 14;
const FONT_MAX = 28;
/** paragrafos do fim do lote anterior que acompanham o proximo, so' como contexto */
const CONTEXT_PARAS = 2;

const THEMES: [BookTheme, string][] = [
  ['dark', 'escuro'],
  ['sepia', 'sepia'],
  ['light', 'claro'],
];

const isAbortError = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError';

/**
 * Corta o capitulo em lotes por quantidade E por tamanho. So' por quantidade, um
 * lote de paragrafos longos passava do que o modelo devolve inteiro e a resposta
 * vinha cortada no meio.
 */
export function batchParagraphs<T extends { text: string }>(paras: T[], maxCount = BATCH, maxChars = BATCH_CHARS): T[][] {
  const lots: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const p of paras) {
    if (current.length && (current.length >= maxCount || chars + p.text.length > maxChars)) {
      lots.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += p.text.length;
  }
  if (current.length) lots.push(current);
  return lots;
}

/**
 * Leitor de livro: EPUB, TXT e afins nao tem pagina nem balao, entao o OCR nao
 * entra. O capitulo chega como paragrafos numerados do servidor e vai ao mesmo
 * `/api/ai/translate` que o leitor de manga usa, em modo prosa — so' o palco e' outro.
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
  private chapterSelect = el('select', {
    class: 'ml-select ml-select-sm ml-book-toc',
    'aria-label': 'Sumario: ir para o capitulo',
    onchange: () => this.goToChapter(this.chapterSelect.value),
  });
  private bilingualBtn = el(
    'button',
    { class: 'ml-btn ml-btn-sm', onclick: () => this.toggleBilingual(), title: 'Original e traducao lado a lado (B)' },
    '◫ bilingue',
  );
  private themeBtn = el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.cycleTheme() }, '');
  private fontBtn = el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.toggleFont() }, '');
  /** opcoes de traducao: popover nativo (fecha no Esc e no clique fora, sem codigo) */
  private optionsEl = el('div', { class: 'ml-book-options', id: 'ml-book-options', popover: 'auto', 'aria-label': 'Opcoes de traducao' });
  private targets: TargetLangInfo[] = [];
  /** fio fino no topo: quanto do capitulo ja' rolou */
  private readFill = el('div', { class: 'ml-book-read-fill' });

  private detail?: SeriesDetail;
  private chapter?: ChapterRef;
  private paras: Para[] = [];
  private busy = false;
  private abort?: AbortController;
  /** invalida trabalho de um capitulo que ja' foi trocado */
  private gen = 0;
  private saveTimer?: number;
  /**
   * Traducoes desta sessao, por capitulo+idioma+motor: voltar a um capitulo ja'
   * traduzido nao paga a traducao de novo. Vive na memoria — fechar o app zera.
   */
  private translated = new Map<string, Map<number, string>>();

  onChapterChange?: (detail: SeriesDetail, chapter: ChapterRef) => void;

  constructor(private readonly onExit: () => void) {
    document.body.append(this.host);
    this.host.append(this.buildTopBar(), this.article, this.optionsEl);
    this.optionsEl.addEventListener('toggle', (e) => {
      if ((e as ToggleEvent).newState === 'open') this.buildOptions();
    });
    void getTargets()
      .then((t) => {
        this.targets = t;
      })
      .catch(() => undefined);
    this.host.addEventListener('keydown', (e) => this.onKey(e));
    this.article.addEventListener('scroll', () => {
      this.scheduleSave();
      this.paintReadProgress();
    });
    this.applyLook();
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
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.goChapter(-1), 'aria-label': 'Capitulo anterior', title: 'Capitulo anterior ([)' }, '«'),
        this.chapterSelect,
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.goChapter(1), 'aria-label': 'Proximo capitulo', title: 'Proximo capitulo (])' }, '»'),
        this.translateBtn,
        this.progressBar,
        this.statusEl,
      ),
      el(
        'div',
        { class: 'ml-top-right' },
        this.bilingualBtn,
        el(
          'button',
          {
            class: 'ml-btn ml-btn-sm',
            onclick: () => this.showGlossary(),
            title: 'Glossario da obra: nomes e termos que a traducao por IA mantem iguais (G)',
          },
          '📖 glossario',
        ),
        el(
          'button',
          { class: 'ml-btn ml-btn-sm', popovertarget: 'ml-book-options', title: 'Motor, idioma de chegada e estilo da traducao' },
          '⚙ traducao',
        ),
        this.themeBtn,
        this.fontBtn,
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.bumpFont(-2), 'aria-label': 'Diminuir a letra' }, 'A-'),
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => this.bumpFont(2), 'aria-label': 'Aumentar a letra' }, 'A+'),
      ),
      el('div', { class: 'ml-book-read', 'aria-hidden': 'true' }, this.readFill),
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
    this.titleEl.textContent = detail.title;
    this.titleEl.title = `${detail.title} — ${chapter.title ?? `cap. ${chapter.number ?? ''}`}`;
    this.fillToc(detail, chapter);
    this.article.replaceChildren(el('p', { class: 'ml-book-note' }, 'carregando o capitulo...'));
    this.setProgress(0, 0);
    this.paintReadProgress();

    let blocks: { id: number; text: string }[];
    try {
      blocks = (await getBookChapter(detail.provider, chapter.id)).blocks;
    } catch (err) {
      if (gen !== this.gen) return;
      this.article.replaceChildren(el('p', { class: 'ml-book-note' }, `nao consegui abrir o capitulo: ${humanizeError(err)}`));
      return;
    }
    if (gen !== this.gen) return;

    this.paras = blocks.map((b) => {
      const node = el('p', { class: 'ml-book-p', dataset: { id: String(b.id) } }, b.text);
      const src = el('p', { class: 'ml-book-src', lang: detail.origin && detail.origin !== 'unknown' ? detail.origin : undefined });
      const row = el('div', { class: 'ml-book-row' }, src, node);
      node.addEventListener('click', () => this.toggleOriginal(b.id));
      return { id: b.id, text: b.text, row, node, src };
    });
    this.article.replaceChildren(
      ...(this.paras.length ? this.paras.map((p) => p.row) : [el('p', { class: 'ml-book-note' }, 'capitulo sem texto')]),
    );
    this.statusEl.textContent = `${this.paras.length} paragrafos`;
    // capitulo ja' traduzido nesta sessao volta pronto
    const known = this.translated.get(this.cacheKey());
    if (known) for (const [id, pt] of known) this.applyTranslation(id, pt);
    this.scrollTo(startBlock);
    this.paintReadProgress();
    if (store.settings.autoTranslate && this.paras.some((p) => !p.pt)) void this.runTranslate();
  }

  /** O sumario na barra: o capitulo atual vira o titulo, e trocar e' um clique. */
  private fillToc(detail: SeriesDetail, chapter: ChapterRef): void {
    this.chapterSelect.replaceChildren(
      ...detail.chapters.map((c, i) => el('option', { value: c.id, selected: c.id === chapter.id }, `${i + 1}. ${c.title ?? `Capitulo ${c.number ?? i + 1}`}`)),
    );
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

  /** Mesmo capitulo em outro idioma, motor ou estilo e' outra traducao. */
  private cacheKey(): string {
    const s = store.settings;
    return [this.detail?.provider, this.detail?.id, this.chapter?.id, s.targetLang, this.engineFor(), s.tone, s.honorifics].join('|');
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

    // so' o que falta: cancelar e retomar nao refaz o que ja' veio
    const lots = batchParagraphs(this.paras.filter((p) => !p.pt));
    if (!lots.length) {
      this.busy = false;
      this.abort = undefined;
      this.translateBtn.textContent = 'traduzir';
      this.statusEl.textContent = `capitulo traduzido (${this.paras.length} paragrafos)`;
      return;
    }
    let done = 0;
    let failed = 0;
    let lastError = '';
    this.setProgress(0, lots.length);
    this.statusEl.textContent = 'traduzindo...';

    const engine = this.engineFor();
    const key = this.cacheKey();
    const cache = this.translated.get(key) ?? new Map<number, string>();
    this.translated.set(key, cache);
    const run = async (lot: Para[], index: number): Promise<void> => {
      // o fim do trecho anterior acompanha o lote: sem ele cada lote comecava "do nada"
      const first = this.paras.indexOf(lot[0]!);
      const context = this.paras.slice(Math.max(0, first - CONTEXT_PARAS), first).map((p) => p.text.slice(-400));
      try {
        const res = await translate(
          {
            blocks: lot.map((p) => ({ id: p.id, text: p.text })),
            sourceLang: detail.origin,
            series: detail.title,
            chapter: chapter.number ?? chapter.title,
            page: index,
            engine,
            target: store.settings.targetLang,
            provider: store.settings.aiProvider,
            mode: 'prose',
            style: translateStyle(),
            context,
          },
          abort.signal,
        );
        if (gen !== this.gen || abort.signal.aborted) return;
        for (const t of res.translations) {
          if (!t.pt.trim()) continue;
          cache.set(t.id, t.pt);
          this.applyTranslation(t.id, t.pt);
        }
      } catch (err) {
        if (isAbortError(err) || abort.signal.aborted) return;
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
    para.node.classList.remove('is-original');
    para.node.classList.add('is-translated');
    para.node.title = 'clique para ver o original';
    para.src.textContent = para.text;
    para.row.classList.add('has-pair');
  }

  /** Clicar num paragrafo troca entre original e traducao — o equivalente ao balao do manga. */
  private toggleOriginal(id: number): void {
    // lado a lado o original ja' esta' na tela: trocar a coluna da traducao so' duplicaria o texto
    if (store.settings.bookBilingual) return;
    const para = this.paras.find((p) => p.id === id);
    if (!para?.pt) return;
    const showingOriginal = para.node.classList.toggle('is-original');
    para.node.textContent = showingOriginal ? para.text : para.pt;
  }

  private toggleBilingual(): void {
    const anchor = this.currentIndex();
    store.settings.bookBilingual = !store.settings.bookBilingual;
    persist();
    // de volta ao modo simples, nenhum paragrafo pode ficar preso mostrando o original
    for (const p of this.paras) {
      if (p.pt && p.node.classList.contains('is-original')) {
        p.node.classList.remove('is-original');
        p.node.textContent = p.pt;
      }
    }
    this.applyLook();
    // a altura de cada linha muda com a segunda coluna: sem reancorar, a leitura pulava de lugar
    this.scrollTo(anchor);
  }

  private cycleTheme(): void {
    const at = THEMES.findIndex(([id]) => id === store.settings.bookTheme);
    store.settings.bookTheme = THEMES[(at + 1) % THEMES.length]![0];
    persist();
    this.applyLook();
  }

  private toggleFont(): void {
    store.settings.bookFont = store.settings.bookFont === 'serif' ? 'sans' : 'serif';
    persist();
    this.applyLook();
  }

  private bumpFont(delta: number): void {
    store.settings.bookFontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, store.settings.bookFontSize + delta));
    persist();
    this.applyLook();
  }

  /** Papel, letra e colunas: tudo que e' preferencia de leitura, aplicado de uma vez. */
  private applyLook(): void {
    const s = store.settings;
    this.article.style.fontSize = `${s.bookFontSize}px`;
    this.host.dataset['theme'] = s.bookTheme;
    this.host.dataset['font'] = s.bookFont;
    this.host.classList.toggle('is-bilingual', s.bookBilingual);
    this.bilingualBtn.classList.toggle('is-active', s.bookBilingual);
    this.bilingualBtn.setAttribute('aria-pressed', String(s.bookBilingual));
    const theme = THEMES.find(([id]) => id === s.bookTheme)?.[1] ?? 'escuro';
    this.themeBtn.textContent = `papel: ${theme}`;
    this.themeBtn.title = `Papel: ${theme} (clique para trocar)`;
    this.fontBtn.textContent = s.bookFont === 'serif' ? 'Aa serifa' : 'Aa sem serifa';
    this.fontBtn.title = 'Trocar a familia da letra';
  }

  /**
   * Motor, idioma e estilo. O livro lia essas preferencias do leitor de manga e
   * nao tinha onde troca-las: para traduzir um livro para outro idioma era
   * preciso abrir um manga antes.
   */
  private buildOptions(): void {
    const s = store.settings;
    const ai = s.translateMode !== 'ocr';
    const changed = (): void => {
      persist();
      this.resetTranslations();
      this.buildOptions();
    };
    const mode = (label: string, on: boolean, next: 'ocr' | 'ai', title: string): HTMLElement =>
      el(
        'button',
        {
          class: `ml-segmented-btn ${on ? 'is-active' : ''}`,
          'aria-pressed': String(on),
          title,
          onclick: () => {
            s.translateMode = next;
            changed();
          },
        },
        label,
      );
    const select = <T extends string>(id: string, label: string, value: T, options: [T, string][], set: (v: T) => void): HTMLElement[] => [
      el('label', { for: id }, label),
      el(
        'select',
        {
          id,
          class: 'ml-select ml-select-sm',
          onchange: (e: Event) => {
            set((e.target as HTMLSelectElement).value as T);
            changed();
          },
        },
        ...options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)),
      ),
    ];
    const targets: [string, string][] = this.targets.length ? this.targets.map((t) => [t.id, t.name]) : [[s.targetLang, s.targetLang]];
    this.optionsEl.replaceChildren(
      el('span', { class: 'ml-popover-label' }, 'Traducao do livro'),
      el(
        'div',
        { class: 'ml-segmented' },
        mode('🌐 Tradutor Web', !ai, 'ocr', 'Google/MyMemory: sem chave e sem IA, traduz paragrafo a paragrafo'),
        mode('✨ IA (contexto)', ai, 'ai', 'O LLM traduz com o glossario da obra, o resumo do que veio antes e o estilo escolhido'),
      ),
      el(
        'div',
        { class: 'ml-style-grid' },
        ...select('ml-book-target', 'Traduzir para', s.targetLang, targets, (v) => {
          s.targetLang = v;
        }),
        ...(ai
          ? [
              ...select<Tone>('ml-book-tone', 'Tom', s.tone, [['natural', 'Natural'], ['literal', 'Literal (colada no original)'], ['localized', 'Localizada (adapta referencias)']], (v) => {
                s.tone = v;
              }),
              ...select<Honorifics>('ml-book-honor', 'Honorificos', s.honorifics, [['keep', 'Manter (-san, senpai)'], ['adapt', 'Adaptar (senhor, dona)']], (v) => {
                s.honorifics = v;
              }),
            ]
          : []),
      ),
      el(
        'button',
        {
          class: `ml-btn ml-btn-sm ${s.autoTranslate ? 'is-active' : ''}`,
          'aria-pressed': String(s.autoTranslate),
          title: 'Comeca a traduzir assim que o capitulo abre',
          onclick: () => {
            s.autoTranslate = !s.autoTranslate;
            persist();
            this.buildOptions();
          },
        },
        s.autoTranslate ? '⚡ Traduzir ao abrir (ligado)' : '⚡ Traduzir ao abrir',
      ),
      ...(ai ? [] : [el('span', { class: 'ml-popover-hint' }, 'Glossario, tom e honorificos so valem no modo IA.')]),
    );
  }

  /**
   * Motor, idioma ou estilo mudaram: o que esta' na tela foi feito com a escolha
   * antiga. Volta ao original e reaproveita o que ja' existir para a escolha nova.
   */
  private resetTranslations(): void {
    this.cancel();
    for (const p of this.paras) {
      p.pt = undefined;
      p.node.textContent = p.text;
      p.node.classList.remove('is-translated', 'is-original');
      p.node.removeAttribute('title');
      p.row.classList.remove('has-pair');
    }
    const known = this.translated.get(this.cacheKey());
    if (known) for (const [id, pt] of known) this.applyTranslation(id, pt);
    this.statusEl.textContent = known?.size ? `capitulo traduzido (${this.paras.length} paragrafos)` : `${this.paras.length} paragrafos`;
  }

  private showGlossary(): void {
    if (!this.detail) return;
    openGlossary(this.detail.title, store.settings.targetLang, { usesAi: this.engineFor() === 'llm' }, () => {
      // o glossario mudou: o que ja' foi traduzido usou os nomes antigos. O texto fica na
      // tela ate' a nova traducao chegar, mas todo paragrafo volta para a fila
      this.translated.delete(this.cacheKey());
      for (const p of this.paras) p.pt = undefined;
      if (this.engineFor() === 'llm') toast('glossario atualizado — aperte traduzir para aplicar os termos');
    });
  }

  private scrollTo(index: number): void {
    const target = this.paras[index]?.row;
    if (target) target.scrollIntoView({ block: 'start' });
    else this.article.scrollTop = 0;
  }

  /** Primeiro paragrafo visivel — e' o "onde parei" do livro, equivalente a pagina. */
  private currentIndex(): number {
    const top = this.article.getBoundingClientRect().top;
    const found = this.paras.findIndex((p) => p.row.getBoundingClientRect().bottom > top);
    return found < 0 ? 0 : found;
  }

  private paintReadProgress(): void {
    const max = this.article.scrollHeight - this.article.clientHeight;
    this.readFill.style.width = `${max > 0 ? Math.min(100, (this.article.scrollTop / max) * 100) : 0}%`;
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
    this.switchTo(next);
  }

  private goToChapter(id: string): void {
    const next = this.detail?.chapters.find((c) => c.id === id);
    if (next && next.id !== this.chapter?.id) this.switchTo(next);
    // o select fica com o foco e engoliria as teclas do leitor
    this.host.focus({ preventScroll: true });
  }

  private switchTo(next: ChapterRef): void {
    if (!this.detail) return;
    this.saveNow();
    this.onChapterChange?.(this.detail, next);
    void this.open(this.detail, next, 0);
  }

  private onKey(e: KeyboardEvent): void {
    // digitando no sumario (ou em qualquer campo) as letras nao sao atalho
    const target = e.target as HTMLElement | null;
    if (e.key !== 'Escape' && target?.matches('select, input, textarea')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      this.toggleTranslate();
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      this.toggleBilingual();
    } else if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      this.showGlossary();
    } else if (e.key === '[') this.goChapter(-1);
    else if (e.key === ']') this.goChapter(1);
  }
}
