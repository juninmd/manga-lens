import { getSeries, type ChapterRef, type SeriesDetail } from './api.ts';
import { appendAll, el, langLabel, STATUS_LABEL, toast } from './ui.ts';
import {
  getProgress,
  isChapterRead,
  isFavorite,
  markChapterRead,
  markUpTo,
  readCount,
  toggleFavorite,
} from './state.ts';

export class SeriesPanel {
  private host = el('aside', { class: 'ml-series' });
  private detail?: SeriesDetail;
  private lang = '';

  constructor(private onRead: (detail: SeriesDetail, chapter: ChapterRef) => void) {
    document.body.append(this.host);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.host.classList.contains('is-open')) this.close();
    });
  }

  close(): void {
    this.host.classList.remove('is-open');
  }

  async open(provider: string, id: string): Promise<SeriesDetail | undefined> {
    this.host.classList.add('is-open');
    this.host.innerHTML = '';
    this.host.append(el('div', { class: 'ml-loading' }, 'carregando serie...'));
    try {
      this.detail = await getSeries(provider, id);
      const langs = this.detail.availableLangs ?? [];
      this.lang = langs.includes('pt-br') ? 'pt-br' : (langs[0] ?? '');
      this.render();
      return this.detail;
    } catch (err) {
      this.host.innerHTML = '';
      this.host.append(el('div', { class: 'ml-loading' }, `falhou: ${(err as Error).message}`));
      toast(`serie nao carregou: ${(err as Error).message}`, 'error');
      return undefined;
    }
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
    const langs = d.availableLangs ?? [];

    this.host.innerHTML = '';
    appendAll(
      this.host,
      // Escape sozinho nao basta: quem abre com o mouse nao tem como fechar
      el(
        'button',
        { class: 'ml-series-close', title: 'fechar (Esc)', onclick: () => this.close() },
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
            el('span', { class: 'ml-badge' }, d.provider),
            d.year ? el('span', {}, String(d.year)) : null,
            d.status ? el('span', {}, STATUS_LABEL[d.status] ?? d.status) : null,
            d.type ? el('span', {}, d.type) : null,
            d.rating ? el('span', {}, `★ ${d.rating}`) : null,
          ),
          d.authors?.length ? el('p', { class: 'ml-authors' }, d.authors.join(', ')) : null,
          el(
            'div',
            { class: 'ml-actions' },
            el(
              'button',
              {
                class: `ml-btn ${isFavorite(d.provider, d.id) ? 'is-on' : ''}`,
                onclick: (e: Event) => {
                  const on = toggleFavorite({ provider: d.provider, id: d.id, title: d.title, cover: d.cover });
                  (e.currentTarget as HTMLElement).classList.toggle('is-on', on);
                },
              },
              '★ favorito',
            ),
            progress
              ? el(
                  'button',
                  {
                    class: 'ml-btn ml-btn-primary',
                    onclick: () => {
                      const ch = d.chapters.find((c) => c.id === progress.chapterId);
                      if (ch) this.onRead(d, ch);
                    },
                  },
                  `continuar: ${progress.chapterLabel}`,
                )
              : null,
            d.url ? el('a', { class: 'ml-btn ml-btn-ghost', href: d.url, target: '_blank', rel: 'noreferrer' }, 'fonte') : null,
            el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.close() }, '✕'),
          ),
        ),
      ),
      el('div', { class: 'ml-tags' }, ...(d.tags ?? []).map((t) => el('span', {}, t))),
      d.description ? el('p', { class: 'ml-desc' }, d.description) : null,
      el(
        'div',
        { class: 'ml-read-summary' },
        el('span', {}, `${readCount(d.provider, d.id)} de ${this.chaptersForLang().length} capitulos lidos`),
        el(
          'button',
          {
            class: 'ml-btn ml-btn-sm ml-btn-ghost',
            onclick: () => {
              markUpTo(
                d.provider,
                d.id,
                this.chaptersForLang().map((c) => c.id),
                false,
              );
              this.render();
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
                  onclick: () => {
                    this.lang = l;
                    this.render();
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

  private chapterList(currentId?: string): HTMLElement {
    const d = this.detail!;
    const list = el('div', { class: 'ml-chapters' });
    const chapters = this.chaptersForLang();
    const total = d.chapters?.length ?? 0;

    // Culpar o idioma quando a obra nao tem capitulo nenhum manda o leitor
    // procurar no lugar errado — sao duas causas diferentes, com saidas diferentes.
    if (!total) {
      list.append(
        el(
          'div',
          { class: 'ml-empty-note' },
          el('strong', {}, 'Esta fonte nao tem capitulo legivel desta obra.'),
          el(
            'span',
            {},
            'O site so lista edicoes licenciadas, que apontam para fora e abrem sem paginas. ' +
              'Troque a fonte pelas abas do card no catalogo.',
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
                this.render();
              },
            },
            `ver os ${total} capitulos de todos os idiomas`,
          ),
        ),
      );
    }

    for (const [i, c] of chapters.entries()) {
      const read = isChapterRead(d.provider, d.id, c.id);
      const row = el(
        'div',
        { class: `ml-chapter ${c.id === currentId ? 'is-current' : ''} ${read ? 'is-read' : ''}` },
        el(
          'button',
          {
            class: 'ml-chapter-check',
            title: read ? 'marcar como nao lido' : 'marcar como lido',
            onclick: (e: Event) => {
              e.stopPropagation();
              markChapterRead(d.provider, d.id, c.id, !read);
              this.render();
            },
          },
          read ? '✓' : '○',
        ),
        el(
          'button',
          { class: 'ml-chapter-open', onclick: () => this.onRead(d, c) },
          el('span', { class: 'ml-chapter-n' }, c.number ? `Cap. ${c.number}` : (c.title ?? '—')),
          el('span', { class: 'ml-chapter-t' }, c.title && c.number ? c.title : ''),
          el('small', {}, [c.group, c.publishedAt?.slice(0, 10)].filter(Boolean).join(' · ')),
        ),
        el(
          'button',
          {
            class: 'ml-chapter-upto',
            title: 'marcar este e todos os anteriores como lidos',
            onclick: (e: Event) => {
              e.stopPropagation();
              markUpTo(
                d.provider,
                d.id,
                chapters.slice(0, i + 1).map((x) => x.id),
              );
              this.render();
            },
          },
          '⤓',
        ),
      );
      list.append(row);
    }
    return list;
  }
}
