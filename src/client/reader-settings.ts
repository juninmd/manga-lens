/**
 * Selects e secoes do popover de opcoes do leitor. Separados do `reader.ts` para
 * ele caber na cabeca: aqui so' entra o que le/grava preferencia e avisa o leitor.
 */
import { clearSeriesMemory, humanizeError, saveAiConfig, seriesMemory } from './api.ts';
import { openGlossary } from './glossary.ts';
import { TESS_LANG_OPTIONS } from './ocr.ts';
import { plural } from './reader-util.ts';
import type { Reader } from './reader.ts';
import { persist, store, type AiProviderName, type LetterFont, type TranslateEngine } from './state.ts';
import { el, toast } from './ui.ts';

type ReaderHost = Reader;

/**
 * Modo IA: a memoria da obra (glossario de nomes/genero + resumo das paginas
 * anteriores) e a opcao de mandar a pagina numerada ao modelo de visao. Limpar
 * existe porque um nome ou genero gravado errado se repetiria no resto da obra.
 */
export function contextSection(host: ReaderHost): HTMLElement {
  const s = store.settings;
  const series = host.detail?.title;
  const vision = host.aiProviders.find((p) => p.id === s.aiProvider)?.visionModel;
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
  const seesPage = host.toggle(
    s.aiSeesPage ? '🖼️ IA ve a pagina (ligado)' : '🖼️ IA ve a pagina',
    s.aiSeesPage,
    () => {
      s.aiSeesPage = !s.aiSeesPage;
      persist();
      host.invalidateTranslations();
      host.buildPopover();
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
      class: 'ml-btn ml-btn-sm',
      disabled: !series,
      title: 'Corrija, fixe ou adicione nomes e termos: o que voce fixar a IA nao muda mais',
      onclick: () => {
        if (!series) return;
        host.togglePopover(false);
        openGlossary(series, s.targetLang, { usesAi: true }, () => {
          // traduzido com o glossario antigo: some da pagina ate' refazer com R
          host.translatedAs.clear();
          host.invalidateTranslations();
          showMemory();
        });
      },
    }, '📖 editar glossario'),
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
 * Estilo da traducao por IA. Sao as tres decisoes em que tradutor e leitor mais
 * discordam — sufixo de tratamento, o quanto adaptar e o que fazer com efeito
 * sonoro — e nenhuma tem resposta certa: vira preferencia, e vai no prompt.
 */
export function styleSection(host: ReaderHost): HTMLElement {
  const s = store.settings;
  const pick = <K extends 'tone' | 'honorifics' | 'sfx'>(key: K, label: string, title: string, options: [(typeof s)[K], string][]): HTMLElement[] => {
    const id = `ml-style-${key}`;
    return [
      el('label', { for: id }, label),
      el(
        'select',
        {
          id,
          class: 'ml-select ml-select-sm',
          title,
          onchange: (e: Event) => {
            s[key] = (e.target as HTMLSelectElement).value as (typeof s)[K];
            persist();
            host.invalidateTranslations();
          },
        },
        ...options.map(([value, text]) => el('option', { value, selected: value === s[key] }, text)),
      ),
    ];
  };
  return el(
    'div',
    { class: 'ml-popover-section' },
    el('span', { class: 'ml-popover-label' }, 'Estilo da traducao'),
    el(
      'div',
      { class: 'ml-style-grid' },
      ...pick('tone', 'Tom', 'Natural: fluida, como scanlation. Literal: colada no original. Localizada: adapta piada, giria e referencia cultural', [
        ['natural', 'Natural'],
        ['literal', 'Literal (colada no original)'],
        ['localized', 'Localizada (adapta referencias)'],
      ]),
      ...pick('honorifics', 'Honorificos', '-san, -kun, senpai, oppa: manter como no original ou trocar pelo tratamento do idioma de chegada', [
        ['keep', 'Manter (-san, senpai)'],
        ['adapt', 'Adaptar (senhor, dona)'],
      ]),
      ...pick('sfx', 'Onomatopeias', 'Traduzir o efeito sonoro, ou deixar a arte original na pagina', [
        ['translate', 'Traduzir'],
        ['keep', 'Manter a arte original'],
      ]),
    ),
  );
}

/**
 * Idioma do scan para o Tesseract. O 'auto' segue o idioma que a fonte declara
 * para o capitulo — e a fonte erra: scan em ingles marcado como "unknown" cai
 * no modelo japones e sai lixo. Aqui o usuario corrige.
 */
export function ocrLangSelect(host: ReaderHost): HTMLElement {
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
        host.ocrAbort?.abort();
        host.ocrCache.clear();
        host.translatedAs.clear();
        host.paintOverlays();
        host.ocrStatus.textContent = 'idioma do OCR alterado — pressione O ou R';
      },
    },
    ...TESS_LANG_OPTIONS.map((o) =>
      el('option', { value: o.code, selected: o.code === store.settings.ocrLang }, o.label),
    ),
  );
}

/** Idioma de chegada: vale para os tres motores; trocar reletreira o capitulo. */
export function targetSelect(host: ReaderHost): HTMLElement {
  return el(
    'select',
    {
      class: 'ml-select ml-select-sm',
      title: 'idioma de destino da traducao',
      onchange: (e: Event) => {
        store.settings.targetLang = (e.target as HTMLSelectElement).value;
        persist();
        host.invalidateTranslations();
      },
    },
    ...host.targets.map((t) =>
      el('option', { value: t.id, selected: t.id === store.settings.targetLang }, t.name),
    ),
  );
}

/** Motor de traducao: Google ou MyMemory (modo OCR tradicional). */
export function engineSelect(host: ReaderHost): HTMLElement {
  // este select e' o do Tradutor Web: motor que depende de IA tem modo proprio
  const traditionalEngines = host.engines.filter((eng) => !eng.needsAi);
  const select = el(
    'select',
    {
      class: 'ml-select ml-select-sm',
      title: 'motor de traducao dos baloes (modo Tradutor Web)',
      onchange: (e: Event) => {
        store.settings.engine = (e.target as HTMLSelectElement).value as TranslateEngine;
        persist();
        host.invalidateTranslations();
      },
    },
    ...(traditionalEngines.length ? traditionalEngines : host.engines).map((eng) =>
      el('option', { value: eng.id, selected: eng.id === store.settings.engine, title: eng.note }, eng.name),
    ),
  );
  return select;
}

export function fontSelect(host: ReaderHost): HTMLElement {
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
        host.paintOverlays();
      },
    },
    ...fonts.map(([id, label, desc]) =>
      el('option', { value: id, selected: id === store.settings.font, title: desc }, label),
    ),
  );
}

/** Provider de IA: openrouter, ollama, openaicompatible (via AI SDK). */
export function providerSelect(host: ReaderHost): HTMLElement {
  return el(
    'select',
    {
      class: 'ml-select ml-select-sm',
      title: 'provedor de IA (modo IA)',
      onchange: (e: Event) => {
        const active = (e.target as HTMLSelectElement).value as AiProviderName;
        store.settings.aiProvider = active;
        persist();
        host.invalidateTranslations();
        // trocar so' no cliente deixava servidor e leitor discordando do provedor
        void saveAiConfig({ active })
          .catch((err) => toast(`nao consegui ativar o provedor no servidor: ${humanizeError(err)}`, 'error'))
          .finally(() => void host.checkAi());
      },
    },
    ...host.aiProviders.map((p) =>
      el('option', { value: p.id, selected: p.id === store.settings.aiProvider }, `IA: ${p.name}`),
    ),
  );
}
