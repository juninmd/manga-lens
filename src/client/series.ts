import { errorStatus, getSeries, humanizeError, type ChapterRef, type SeriesDetail } from './api.ts';
import { appendAll, el, langLabel, plural, STATUS_LABEL, toast, TYPE_LABEL } from './ui.ts';
import {
  getProgress,
  isChapterRead,
  isFavorite,
  nextUnreadChapter,
  markChapterRead,
  markUpTo,
  toggleFavorite,
} from './state.ts';

export class SeriesPanel {
  private host = el('aside', { class: 'ml-series', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'obra' });
  private detail?: SeriesDetail;
  private lang = '';
  private readSummary = el('span', {});
  /** um atualizador por linha: marcar capitulo mexe na linha, nao na lista toda */
  private rowSyncs: (() => void)[] = [];
  /** lista atual, para o chip de idioma trocar so' ela e nao o painel inteiro */
  private list?: HTMLElement;
  /** carrega o resto da lista de capitulos conforme a rolagem chega ao fim */
  private listObserver?: IntersectionObserver;
  /** quem tinha o foco antes de abrir: devolve ao fechar */
  private opener?: HTMLElement;

  constructor(private onRead: (detail: SeriesDetail, chapter: ChapterRef) => void) {
    document.body.append(this.host);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.host.classList.contains('is-open')) this.close();
    });
  }

  close(): void {
    if (!this.host.classList.contains('is-open')) return;
    this.host.classList.remove('is-open');
    // A hash `#/s/...` fica de proposito: o "voltar" do leitor faz history.back()
    // e precisa cair nela para reabrir o painel. Reabrir o mesmo card com a hash
    // igual e' tratado em main.ts (chama a rota direto).
    const opener = this.opener;
    this.opener = undefined;
    // o card pode ter sumido (busca refez a grade): sem fallback o foco caia no body
    if (opener?.isConnected) opener.focus();
    else document.querySelector<HTMLElement>('.ml-search')?.focus();
  }

  async open(provider: string, id: string): Promise<SeriesDetail | undefined> {
    if (!this.host.classList.contains('is-open')) {
      const active = document.activeElement;
      this.opener = active instanceof HTMLElement && !this.host.contains(active) ? active : undefined;
    }
    this.host.classList.add('is-open');
    this.host.innerHTML = '';
    this.host.append(
      el('div', { class: 'ml-loading' }, el('div', { class: 'ml-spinner' }), el('span', {}, 'carregando obra...')),
    );
    try {
      this.detail = await getSeries(provider, id);
      const langs = this.detail.availableLangs ?? [];
      this.lang = langs.includes('pt-br') ? 'pt-br' : (langs[0] ?? '');
      this.render();
      this.focusTitle();
      return this.detail;
    } catch (err) {
      const status = errorStatus(err);
      const why =
        status === 404
          ? 'serie nao encontrada nesta fonte'
          : status !== undefined && status >= 500
            ? 'fonte fora do ar'
            : humanizeError(err);
      this.host.innerHTML = '';
      this.host.append(
        el(
          'div',
          { class: 'ml-loading' },
          el('span', {}, `obra nao carregou: ${why}`),
          el('button', { class: 'ml-btn ml-btn-sm', onclick: () => void this.open(provider, id) }, 'tentar de novo'),
        ),
      );
      return undefined;
    }
  }

  private focusTitle(): void {
    const h2 = this.host.querySelector<HTMLElement>('h2');
    if (!h2) return;
    h2.tabIndex = -1;
    h2.focus({ preventScroll: true });
    // a lista pode ter 700 linhas: sem isto quem retoma a obra procura o
    // capitulo atual rolando 46vh de lista
    this.list?.querySelector('.ml-chapter.is-current')?.scrollIntoView({ block: 'center' });
  }

  private chaptersForLang(): ChapterRef[] {
    const all = this.detail?.chapters ?? [];
    if (!this.lang) return all;
    return all.filter((c) => (c.lang ?? '') === this.lang);
  }

  private render(): void {
    const d = this.detail;
    if (!d) return;
    const progress = getProgress(d.provider, d.id);
    const resumeChapter = progress ? d.chapters.find((c) => c.id === progress.chapterId) : undefined;
    const langs = d.availableLangs ?? [];

    this.host.setAttribute('aria-label', d.title);
    this.host.innerHTML = '';
    appendAll(
      this.host,
      // Escape sozinho nao basta: quem abre com o mouse nao tem como fechar
      el(
        'button',
        { class: 'ml-series-close', title: 'fechar (Esc)', 'aria-label': 'fechar', onclick: () => this.close() },
        '✕',
      ),
      el(
        'div',
        { class: 'ml-series-head' },
        d.cover ? el('img', { src: d.cover, alt: d.title }) : el('div', { class: 'ml-nocover' }),
        el(
          'div',
          {},
          el('h2', {}, d.title),
          el(
            'div',
            { class: 'ml-meta' },
            // `.ml-badge` e' a etiqueta absoluta da capa no card: aqui vazava para o canto do painel
            el('span', { class: 'ml-source-tag' }, d.provider),
            d.year ? el('span', {}, String(d.year)) : null,
            d.status ? el('span', {}, STATUS_LABEL[d.status] ?? d.status) : null,
            d.type ? el('span', {}, TYPE_LABEL[d.type] ?? d.type) : null,
            d.rating ? el('span', {}, `★ ${d.rating}`) : null,
          ),
          d.authors?.length ? el('p', { class: 'ml-authors' }, d.authors.join(', ')) : null,
          el(
            'div',
            { class: 'ml-actions' },
            this.favoriteButton(d),
            // capitulo salvo pode ter sumido da fonte: sem o botao, em vez de um
            // clique que nao faz nada
            // sem capitulos nao ha o que continuar
            resumeChapter && d.chapters.length
              ? el(
                  'button',
                  {
                    class: 'ml-btn ml-btn-primary',
                    // capitulo salvo ja' terminado: o esperado e' cair no seguinte, nao reler
                    onclick: () => this.onRead(d, nextUnreadChapter(d, resumeChapter, progress!.page) ?? resumeChapter),
                  },
                  `continuar: ${progress!.chapterLabel}`,
                )
              : progress
                ? el(
                    'button',
                    {
                      class: 'ml-btn ml-btn-ghost',
                      onclick: () => toast('capitulo salvo nao esta mais disponivel nesta fonte', 'error'),
                    },
                    `continuar: ${progress.chapterLabel}`,
                  )
                : null,
            // o ✕ do canto ja' fecha: um segundo aqui confundia
            d.url ? el('a', { class: 'ml-btn ml-btn-ghost', href: d.url, target: '_blank', rel: 'noreferrer' }, 'abrir no site') : null,
          ),
        ),
      ),
      el('div', { class: 'ml-tags' }, ...(d.tags ?? []).map((t) => el('span', {}, t))),
      d.description ? el('p', { class: 'ml-desc' }, d.description) : null,
      // "0 de 0 capitulos lidos" + "limpar leitura" nao fazem sentido sem capitulos
      !d.chapters.length ? null : el(
        'div',
        { class: 'ml-read-summary' },
        this.readSummary,
        el(
          'button',
          {
            class: 'ml-btn ml-btn-sm ml-btn-ghost',
            onclick: () => {
              if (!confirm('Desmarcar todos os capitulos lidos desta obra?')) return;
              markUpTo(
                d.provider,
                d.id,
                this.chaptersForLang().map((c) => c.id),
                false,
              );
              this.syncRead();
            },
          },
          'limpar leitura',
        ),
      ),
      langs.length > 1
        ? el(
            'div',
            { class: 'ml-chips' },
            ...langs.map((l) =>
              el(
                'button',
                {
                  class: `ml-chip ${l === this.lang ? 'is-on' : ''}`,
                  'aria-pressed': String(l === this.lang),
                  onclick: (e: Event) => {
                    this.lang = l;
                    // troca so' a lista: re-renderizar o painel inteiro zerava a rolagem
                    const chips = (e.currentTarget as HTMLElement).parentElement;
                    for (const chip of chips?.children ?? []) {
                      const on = chip === e.currentTarget;
                      chip.classList.toggle('is-on', on);
                      chip.setAttribute('aria-pressed', String(on));
                    }
                    this.replaceList();
                  },
                },
                langLabel(l),
              ),
            ),
          )
        : null,
      this.chapterList(progress?.chapterId),
    );
  }

  private favoriteButton(d: SeriesDetail): HTMLElement {
    const paint = (btn: HTMLElement, on: boolean): void => {
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? '★ favoritado' : '☆ favoritar';
    };
    const btn = el('button', {
      class: 'ml-btn',
      onclick: (e: Event) => {
        const on = toggleFavorite({ provider: d.provider, id: d.id, title: d.title, cover: d.cover });
        paint(e.currentTarget as HTMLElement, on);
        toast(on ? 'adicionado aos favoritos' : 'removido dos favoritos');
      },
    });
    paint(btn, isFavorite(d.provider, d.id));
    return btn;
  }

  private replaceList(): void {
    const fresh = this.chapterList(getProgress(this.detail!.provider, this.detail!.id)?.chapterId);
    if (this.list?.isConnected) this.list.replaceWith(fresh);
    else this.host.append(fresh);
    this.list = fresh;
  }

  /**
   * Varios grupos lancam o mesmo capitulo: cada release e' uma linha, mas para o
   * usuario "12 de 10 capitulos lidos" nao faz sentido. Conta numeros distintos
   * (e cai no id quando a fonte nao numera).
   */
  private static chapterKey(c: ChapterRef): string {
    return c.number ? `n:${c.number}` : `id:${c.id}`;
  }

  private distinctCount(chapters: ChapterRef[]): number {
    return new Set(chapters.map(SeriesPanel.chapterKey)).size;
  }

  /**
   * Marcar capitulo chamava `render()`: em obra longa (Naruto tem 701 capitulos)
   * isso reconstroi a lista inteira a cada clique — e, pior, joga a rolagem de
   * volta ao topo, entao quem marca o capitulo 300 perde o lugar.
   */
  private syncRead(): void {
    const d = this.detail;
    if (!d) return;
    for (const sync of this.rowSyncs) sync();
    // conta so' o idioma em tela: `readCount` soma todos os idiomas e passava do total
    const chapters = this.chaptersForLang();
    const read = chapters.filter((c) => isChapterRead(d.provider, d.id, c.id));
    const total = this.distinctCount(chapters);
    this.readSummary.textContent = `${this.distinctCount(read).toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')} ${total === 1 ? 'capitulo lido' : 'capitulos lidos'}`;
  }

  private chapterList(currentId?: string): HTMLElement {
    const d = this.detail!;
    const list = el('div', { class: 'ml-chapters' });
    this.list = list;
    this.rowSyncs = [];
    const chapters = this.chaptersForLang();
    const total = d.chapters?.length ?? 0;

    // Culpar o idioma quando a obra nao tem capitulo nenhum manda o leitor
    // procurar no lugar errado — sao duas causas diferentes, com saidas diferentes.
    if (!total) {
      list.append(
        el(
          'div',
          { class: 'ml-empty-note' },
          el('strong', {}, 'Esta fonte nao tem capitulos legiveis aqui (obra licenciada ou so links externos).'),
          el('span', {}, 'O site so lista edicoes que apontam para fora e abrem sem paginas.'),
          el(
            'button',
            {
              class: 'ml-btn ml-btn-sm',
              onclick: () => {
                // o catalogo escuta e refaz a busca em todas as fontes
                window.dispatchEvent(new CustomEvent('ml:search', { detail: { q: d.title } }));
                this.close();
              },
            },
            'buscar em outras fontes',
          ),
        ),
      );
    } else if (!chapters.length) {
      list.append(
        el(
          'div',
          { class: 'ml-empty-note' },
          el('strong', {}, `Nenhum capitulo em ${langLabel(this.lang)}.`),
          el(
            'button',
            {
              class: 'ml-btn ml-btn-sm',
              onclick: () => {
                this.lang = '';
                this.replaceList();
              },
            },
            `ver ${plural(total, 'capitulo')} de todos os idiomas`,
          ),
        ),
      );
    }

    // Obra longa (701 capitulos) montava 2100 botoes de uma vez e travava o
    // clique no chip de idioma. Renderiza em blocos: o resto entra quando a
    // sentinela no fim da lista aparece na rolagem. Contadores e "ate aqui"
    // continuam usando `chapters` inteiro, nao so' as linhas em tela.
    const renderRow = (i: number): void => {
      const c = chapters[i]!;
      const check = el(
        'button',
        {
          class: 'ml-chapter-check',
          onclick: (e: Event) => {
            e.stopPropagation();
            markChapterRead(d.provider, d.id, c.id, !isChapterRead(d.provider, d.id, c.id));
            this.syncRead();
          },
        },
        '○',
      );
      const row = el(
        'div',
        { class: `ml-chapter ${c.id === currentId ? 'is-current' : ''}` },
        check,
        el(
          'button',
          { class: 'ml-chapter-open', onclick: () => this.onRead(d, c) },
          el('span', { class: 'ml-chapter-n' }, c.number ? `Cap. ${c.number}` : (c.title ?? '—')),
          // "Cap. 12 · Chapter 12": titulo que so' repete o numero nao acrescenta nada
          el(
            'span',
            { class: 'ml-chapter-t', title: redundantTitle(c) ? '' : (c.title ?? '') },
            c.title && c.number && !redundantTitle(c) ? c.title : '',
          ),
          el(
            'small',
            {},
            [c.group, relativeDate(c.publishedAt), c.pages ? `${c.pages} pag.` : ''].filter(Boolean).join(' · '),
          ),
        ),
        el(
          'button',
          {
            class: 'ml-chapter-upto',
            title: 'marcar este e todos os anteriores como lidos',
            'aria-label': `marcar ate ${c.number ? `capitulo ${c.number}` : 'aqui'} como lido`,
            onclick: (e: Event) => {
              e.stopPropagation();
              markUpTo(
                d.provider,
                d.id,
                chapters.slice(0, i + 1).map((x) => x.id),
              );
              this.syncRead();
            },
          },
          '⤓',
        ),
      );
      this.rowSyncs.push(() => {
        const on = isChapterRead(d.provider, d.id, c.id);
        row.classList.toggle('is-read', on);
        check.textContent = on ? '✓' : '○';
        check.title = on ? 'marcar como nao lido' : 'marcar como lido';
      });
      list.append(row);
    };

    const CHUNK = 120;
    let rendered = 0;
    const sentinel = el('div', { class: 'ml-chapters-more', 'aria-hidden': 'true' });
    const appendChunk = (): void => {
      const end = Math.min(rendered + CHUNK, chapters.length);
      for (let i = rendered; i < end; i++) renderRow(i);
      rendered = end;
      // a sentinela fica sempre depois da ultima linha; some quando acabou
      if (rendered < chapters.length) list.append(sentinel);
      else sentinel.remove();
      this.syncRead();
    };
    // o capitulo atual precisa existir no DOM para o scrollIntoView de `focusTitle`
    const currentIdx = currentId ? chapters.findIndex((c) => c.id === currentId) : -1;
    appendChunk();
    while (rendered <= currentIdx && rendered < chapters.length) appendChunk();

    this.listObserver?.disconnect();
    if (rendered < chapters.length) {
      this.listObserver = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          appendChunk();
          if (rendered >= chapters.length) this.listObserver?.disconnect();
        },
        { root: list, rootMargin: '200px' },
      );
      this.listObserver.observe(sentinel);
    }
    return list;
  }
}

/** "ha 3 dias" para o que e' recente; data curta para o resto; vazio sem data. */
/** "Cap. 12 · Chapter 12": o titulo so' repete o numero (mangapill/weebcentral/madara). */
function redundantTitle(c: ChapterRef): boolean {
  if (!c.title || !c.number) return false;
  const num = c.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // sites em portugues mandam "Capítulo 12" com acento: compara sem diacriticos
  const title = c.title
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  return new RegExp(`^(chapter|ch\\.?|cap\\.?|capitulo)\\s*0*${num}\\s*$`, 'i').test(title);
}

const startOfDay = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);

function relativeDate(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  // data que nao parseia (formato livre do site) nao vira string cortada
  if (Number.isNaN(t)) return '';
  // dia de calendario, nao horas decorridas: publicado ontem 23h nao e' "hoje"
  const days = Math.round((startOfDay(Date.now()) - startOfDay(t)) / 86_400_000);
  if (days === 0) return 'hoje';
  if (days === 1) return 'ontem';
  if (days > 1 && days < 30) return `ha ${days} dias`;
  return new Date(t).toLocaleDateString('pt-BR');
}
