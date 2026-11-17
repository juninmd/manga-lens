import { isDesktop } from './base.ts';
import { getTargets, type TargetLangInfo } from './api.ts';
import { edits } from './edits.ts';
import { TESS_LANG_OPTIONS } from './ocr.ts';
import { persist, resetSettings, store, type Settings } from './state.ts';
import { applyTheme, getThemeMode, type ThemeMode } from './theme.ts';
import { getSyncConfig, setSyncConfig, syncNow } from './sync.ts';
import { el, plural, toast } from './ui.ts';
import {
  REPO_URL,
  checkUpdate,
  fmtVersion,
  getUpdate,
  getUpdatePrefs,
  offUpdate,
  onUpdate,
  openExternal,
  runUpdate,
  setUpdatePrefs,
  type UpdateInfo,
} from './update.ts';

/**
 * Tela de configuracoes: o que antes vivia espalhado (popover do leitor, gaveta de
 * IA, paleta) num lugar so', mais a versao e as preferencias de atualizacao.
 *
 * Nao tem estado proprio: cada controle le e grava em `store.settings` (a mesma
 * fonte do leitor) e avisa por `ml:settings-changed`, para o leitor reaplicar o que
 * guarda por conta propria.
 */

type SectionId = 'geral' | 'leitura' | 'traducao' | 'livros' | 'atualizacao' | 'dados' | 'sobre';

interface Section {
  id: SectionId;
  label: string;
  render(): (HTMLElement | null)[];
}

let root: HTMLElement | undefined;
let active: SectionId = 'geral';
let targets: TargetLangInfo[] = [];
let lastFocus: Element | null = null;
let onInfo: ((i: UpdateInfo | undefined) => void) | undefined;

/** Um ajuste mudou: grava e avisa o leitor. */
function changed(): void {
  persist();
  window.dispatchEvent(new CustomEvent('ml:settings-changed'));
}

const rerender = (): void => {
  if (root) paint();
};

// ---------- sincronizacao ----------

let syncDirCache: string | undefined;

/**
 * Pasta sincronizada: o caminho fica no servidor local (e' ele que grava o
 * arquivo), entao a linha carrega o valor atual depois de desenhada.
 */
function syncRow(): HTMLElement {
  const input = el('input', {
    class: 'ml-input ml-set-input',
    type: 'text',
    placeholder: 'ex.: C:\\Users\\voce\\Dropbox\\MangaLens',
    value: syncDirCache ?? '',
    'aria-label': 'Pasta de sincronização',
  }) as HTMLInputElement;
  if (syncDirCache === undefined) {
    void getSyncConfig()
      .then((c) => {
        syncDirCache = c.dir;
        if (!input.value) input.value = c.dir;
      })
      .catch(() => undefined);
  }
  const save = button('Salvar e sincronizar', () => {
    void setSyncConfig(input.value)
      .then(async (c) => {
        syncDirCache = c.dir;
        if (!c.enabled) return toast('sincronização desligada');
        const r = await syncNow();
        toast(r.ok ? 'progresso sincronizado com a pasta' : `não consegui sincronizar: ${r.error}`, r.ok ? 'info' : 'error');
        if (r.ok && r.changed) window.dispatchEvent(new CustomEvent('ml:favorites-updated'));
      })
      .catch((err) => toast(`pasta recusada: ${(err as Error).message}`, 'error'));
  });
  return row(
    'Sincronizar entre máquinas',
    'Escolha uma pasta que você já sincroniza (Dropbox, OneDrive, Syncthing). Favoritos, progresso, marcadores e capítulos lidos vão para um arquivo lá a cada 5 minutos. Deixe vazio para desligar.',
    [input, save],
  );
}

// ---------- controles ----------

function row(label: string, hint: string | undefined, control: HTMLElement | HTMLElement[]): HTMLElement {
  return el(
    'div',
    { class: 'ml-set-row' },
    el('div', { class: 'ml-set-text' }, el('b', {}, label), hint ? el('small', {}, hint) : null),
    el('div', { class: 'ml-set-control' }, ...(Array.isArray(control) ? control : [control])),
  );
}

function toggle(label: string, on: boolean, onChange: (next: boolean) => void, disabled = false): HTMLElement {
  return el('button', {
    class: 'ml-switch',
    type: 'button',
    role: 'switch',
    'aria-checked': String(on),
    'aria-label': label,
    disabled,
    onclick: (e: Event) => {
      const btn = e.currentTarget as HTMLElement;
      const next = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(next));
      onChange(next);
    },
  });
}

function select<T extends string>(label: string, value: T, options: readonly (readonly [T, string])[], onChange: (next: T) => void): HTMLElement {
  return el(
    'select',
    {
      class: 'ml-select',
      'aria-label': label,
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T),
    },
    ...options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)),
  );
}

type Key = keyof Settings;

/** Seletor ligado direto a uma chave de `store.settings`. */
function bound<K extends Key>(key: K, label: string, options: readonly (readonly [Settings[K] & string, string])[], then?: () => void): HTMLElement {
  return select(label, store.settings[key] as Settings[K] & string, options, (next) => {
    store.settings[key] = next as Settings[K];
    changed();
    then?.();
  });
}

function flag<K extends Key>(key: K, label: string, then?: () => void, disabled = false): HTMLElement {
  return toggle(label, Boolean(store.settings[key]), (next) => {
    (store.settings as unknown as Record<string, unknown>)[key] = next;
    changed();
    then?.();
  }, disabled);
}

const button = (label: string, onclick: () => void, kind: 'primary' | 'ghost' | '' = ''): HTMLButtonElement =>
  el('button', { class: `ml-btn ${kind ? `ml-btn-${kind}` : ''}`, type: 'button', onclick }, label);

/** Clica no controle real do catalogo (backup, IA...): a tela fecha antes para nao ficar por cima. */
const press = (act: string): void => {
  closeSettings();
  setTimeout(() => document.querySelector<HTMLElement>(`[data-act="${act}"]`)?.click(), 50);
};

// ---------- secoes ----------

const sections: Section[] = [
  {
    id: 'geral',
    label: 'Geral',
    render: () => [
      row(
        'Tema',
        'Claro, escuro, ou o que o sistema estiver usando.',
        select<ThemeMode>('Tema', getThemeMode(), [['system', 'Seguir o sistema'], ['light', 'Claro'], ['dark', 'Escuro']], (m) => applyTheme(m)),
      ),
      row(
        'Traduzir para',
        'Idioma de chegada de mangás, HQs e livros.',
        select('Idioma de chegada', store.settings.targetLang, targets.length ? targets.map((t) => [t.id, t.name] as const) : ([[store.settings.targetLang, store.settings.targetLang]] as const), (v) => {
          store.settings.targetLang = v;
          changed();
        }),
      ),
      row('Traduzir ao abrir o capítulo', 'Começa a traduzir sozinho, sem apertar Traduzir.', flag('autoTranslate', 'Traduzir ao abrir')),
      row('Detector neural de balões', 'Acha balões e texto solto com um modelo local (11 MB, baixado uma vez). Desligado, volta à detecção por manchas brancas.', flag('neuralDetect', 'Detector neural')),
    ],
  },
  {
    id: 'leitura',
    label: 'Leitura',
    render: () => [
      row('Modo de leitura', undefined, bound('mode', 'Modo de leitura', [['single', 'Página'], ['double', 'Dupla'], ['strip', 'Tira (webtoon)']])),
      row('Ajuste da página', undefined, bound('fit', 'Ajuste', [['page', 'Página inteira'], ['width', 'Largura'], ['height', 'Altura'], ['free', 'Livre (zoom manual)']])),
      row('Mangá: da direita para a esquerda', 'HQ ocidental e PDF abrem da esquerda para a direita, qualquer que seja esta opção.', flag('rtl', 'Direita para a esquerda')),
      row('Abrir mostrando o texto original', 'A tradução continua a um toque de distância (tecla T).', flag('showOriginal', 'Mostrar o original')),
      row('Inverter o sentido da rolagem', undefined, flag('invertScroll', 'Inverter rolagem')),
      row('Letra dos balões', 'Família usada para letrear a tradução dentro do balão.', bound('font', 'Letra dos balões', [['comic', 'Balão de HQ'], ['sans', 'Moderna (limpa)'], ['serif', 'Clássica (livro)']])),
      row(
        'Idioma do OCR',
        'Automático segue o idioma que a fonte declara para o capítulo; corrija aqui se o scan sair com letras erradas.',
        select('Idioma do OCR', store.settings.ocrLang, [['auto', 'Automático (pelo capítulo)'], ...TESS_LANG_OPTIONS.map((o) => [o.code, o.label] as const)] as const, (v) => {
          store.settings.ocrLang = v;
          changed();
        }),
      ),
    ],
  },
  {
    id: 'traducao',
    label: 'Tradução',
    render: () => {
      const ai = store.settings.translateMode !== 'ocr';
      return [
        row(
          'Modo de tradução',
          'Tradutor Web usa Google/MyMemory sobre o texto do OCR (sem chave). IA usa o modelo configurado, com glossário e contexto da obra.',
          bound('translateMode', 'Modo de tradução', [['ocr', 'Tradutor Web'], ['ai', 'IA (contexto)'], ['vision', 'IA com visão']], rerender),
        ),
        ai
          ? row('Provedor e modelos de IA', 'Ollama, OpenRouter ou qualquer endpoint compatível com OpenAI.', button('Configurar IA…', () => press('ai')))
          : row('Motor do Tradutor Web', 'Automático tenta o Google e recorre ao MyMemory.', bound('engine', 'Motor', [['auto', 'Automático'], ['google', 'Google'], ['mymemory', 'MyMemory']])),
        row('Tom', ai ? 'Natural: fluida. Literal: colada no original. Localizada: adapta piada e referência cultural.' : 'Só vale nos modos de IA.', bound('tone', 'Tom da tradução', [['natural', 'Natural'], ['literal', 'Literal'], ['localized', 'Localizada']])),
        row('Honoríficos (-san, senpai)', ai ? undefined : 'Só vale nos modos de IA.', bound('honorifics', 'Honoríficos', [['keep', 'Manter'], ['adapt', 'Adaptar ao idioma']])),
        row('Onomatopeias', ai ? 'Mantida, a arte original fica na página e o balão não é repintado.' : 'Só vale nos modos de IA.', bound('sfx', 'Onomatopeias', [['translate', 'Traduzir'], ['keep', 'Manter a arte original']])),
        ai ? row('Mandar a página para o modelo de visão', 'Gasta mais tokens por página, mas acerta melhor quem fala e o gênero. Exige um modelo de visão no provedor.', flag('aiSeesPage', 'IA vê a página')) : null,
        row(
          'Correções feitas à mão',
          `${plural(edits.count(), 'correção', 'correções')} guardada${edits.count() === 1 ? '' : 's'} neste aparelho. Valem sempre que a página é traduzida de novo.`,
          button('Apagar todas', () => {
            if (!edits.count() || !confirm('Apagar todas as correções de tradução feitas à mão?')) return;
            edits.clear();
            toast('correções apagadas');
            rerender();
          }),
        ),
      ];
    },
  },
  {
    id: 'livros',
    label: 'Livros',
    render: () => [
      row('Papel', undefined, bound('bookTheme', 'Papel', [['dark', 'Escuro'], ['sepia', 'Sépia'], ['light', 'Claro']])),
      row('Letra', undefined, bound('bookFont', 'Letra', [['serif', 'Com serifa'], ['sans', 'Sem serifa']])),
      row(
        'Tamanho da letra',
        `${store.settings.bookFontSize} px`,
        el('input', {
          class: 'ml-set-range',
          type: 'range',
          min: '14',
          max: '28',
          step: '2',
          value: String(store.settings.bookFontSize),
          'aria-label': 'Tamanho da letra',
          oninput: (e: Event) => {
            store.settings.bookFontSize = Number((e.target as HTMLInputElement).value);
            changed();
            const hint = (e.target as HTMLElement).closest('.ml-set-row')?.querySelector('small');
            if (hint) hint.textContent = `${store.settings.bookFontSize} px`;
          },
        }),
      ),
      row('Original e tradução lado a lado', 'No celular, um em cima do outro.', flag('bookBilingual', 'Modo bilíngue')),
    ],
  },
  {
    id: 'atualizacao',
    label: 'Atualização',
    render: () => {
      const i = getUpdate();
      const prefs = getUpdatePrefs();
      const status = !i
        ? 'Não consegui falar com o servidor interno.'
        : i.devBuild
          ? 'Build de desenvolvimento: sem versão carimbada, não há o que comparar.'
          : i.disabled
            ? 'A checagem está desligada por UPDATE_CHECK=off.'
            : !prefs.check
              ? 'A verificação automática está desligada.'
              : i.error
                ? `Não consegui consultar as releases (${i.error}).`
                : i.available
                  ? `Há uma versão nova: ${fmtVersion(i.latest ?? '')}.`
                  : 'Você está na versão mais recente.';
      const desktop = isDesktop();
      return [
        el(
          'div',
          { class: 'ml-set-ver-card' },
          el('div', {}, el('small', {}, 'Instalada'), el('strong', {}, i ? fmtVersion(i.current) : '—')),
          el('div', { class: i?.available ? 'is-new' : '' }, el('small', {}, 'Disponível'), el('strong', {}, i?.latest ? fmtVersion(i.latest) : '—')),
        ),
        el('p', { class: 'ml-set-status', role: 'status' }, status),
        el(
          'div',
          { class: 'ml-set-actions' },
          i?.available && i.canInstall
            ? button(`Atualizar para v${i.latest} agora`, () => {
                closeSettings();
                void runUpdate({ auto: false });
              }, 'primary')
            : i?.available && (i.downloadUrl ?? i.url)
              ? button(`Baixar v${i.latest}`, () => openExternal((i.downloadUrl ?? i.url)!), 'primary')
              : null,
          button('Verificar agora', async () => {
            await checkUpdate(true);
            rerender();
          }),
          i?.url ? button('Notas da release', () => openExternal(i.url!), 'ghost') : null,
        ),
        row('Verificar atualizações automaticamente', 'Ao abrir o app e a cada 6 horas. Só o número da versão é consultado; nada seu sai da máquina.', toggle('Verificar atualizações', prefs.check, (v) => {
          setUpdatePrefs({ check: v });
          rerender();
        })),
        row(
          'Instalar sozinho quando houver versão nova',
          desktop
            ? 'Baixa, confere o hash (SHA-256) e reabre o app na versão nova. A tela de atualização aparece com uma contagem de 5 segundos para recusar.'
            : 'Só existe no app instalado (no navegador não há o que instalar).',
          toggle('Instalar sozinho', prefs.install && desktop, (v) => setUpdatePrefs({ install: v }), !desktop || !prefs.check),
        ),
        row('Origem das versões', 'Releases publicadas no GitHub a cada commit semântico que entra na principal.', button('Abrir repositório', () => openExternal(`${REPO_URL}/releases`), 'ghost')),
      ];
    },
  },
  {
    id: 'dados',
    label: 'Dados',
    render: () => [
      row('Backup', 'Baixa um .json com favoritos, progresso, marcadores e capítulos lidos.', button('Baixar backup', () => press('backup'))),
      row('Importar backup', 'Restaura esse arquivo, em qualquer máquina.', button('Importar…', () => press('import'))),
      syncRow(),
      row(
        'Restaurar preferências',
        'Volta modo, ajuste, motor, idioma e letra ao padrão. Favoritos e progresso ficam.',
        button('Restaurar padrões', () => {
          if (!confirm('Restaurar as preferências para o padrão? Favoritos e progresso não são afetados.')) return;
          const provider = store.settings.aiProvider;
          resetSettings();
          store.settings.aiProvider = provider;
          changed();
          toast('preferências restauradas');
          rerender();
        }),
      ),
      el('p', { class: 'ml-set-note' }, 'Tudo fica neste aparelho: progresso, favoritos e correções vivem no armazenamento do app (e na pasta de sincronização, se você ligar). Só o texto reconhecido vai ao tradutor que você escolheu.'),
    ],
  },
  {
    id: 'sobre',
    label: 'Sobre',
    render: () => {
      const i = getUpdate();
      return [
        el('div', { class: 'ml-set-about' }, el('i', { class: 'ml-lens' }), el('div', {}, el('strong', {}, 'MangaLens'), el('small', {}, i ? `${fmtVersion(i.current)}${i.devBuild ? ' · desenvolvimento' : ''}` : 'versão —'))),
        row('Repositório', 'Código, releases e problemas conhecidos.', button('Abrir no GitHub', () => openExternal(REPO_URL), 'ghost')),
        el(
          'div',
          { class: 'ml-set-keys' },
          el('b', {}, 'Atalhos'),
          ...[
            ['Ctrl K', 'paleta de comandos'],
            ['Ctrl ,', 'estas configurações'],
            ['/', 'buscar no catálogo'],
            ['?', 'atalhos do leitor (com o leitor aberto)'],
          ].map(([k, d]) => el('div', {}, el('kbd', {}, k!), el('span', {}, d!))),
        ),
      ];
    },
  },
];

// ---------- janela ----------

function paint(): void {
  if (!root) return;
  const nav = root.querySelector('.ml-set-nav');
  const panel = root.querySelector('.ml-set-panel');
  if (!nav || !panel) return;
  const section = sections.find((s) => s.id === active) ?? sections[0]!;
  for (const tab of nav.querySelectorAll<HTMLElement>('[role=tab]')) {
    const on = tab.dataset['id'] === section.id;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  panel.setAttribute('aria-label', section.label);
  panel.replaceChildren(el('h3', {}, section.label), ...section.render().filter((n): n is HTMLElement => n !== null));
}

export function closeSettings(): void {
  if (!root) return;
  root.remove();
  root = undefined;
  if (onInfo) offUpdate(onInfo);
  onInfo = undefined;
  if (lastFocus instanceof HTMLElement) lastFocus.focus();
}

export function openSettings(section?: SectionId): void {
  if (section && sections.some((s) => s.id === section)) active = section;
  if (root) {
    paint();
    return;
  }
  lastFocus = document.activeElement;
  const i = getUpdate();
  const nav = el(
    'div',
    { class: 'ml-set-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Seções' },
    ...sections.map((s) =>
      el('button', {
        class: 'ml-set-tab',
        type: 'button',
        role: 'tab',
        'data-id': s.id,
        onclick: () => {
          active = s.id;
          paint();
        },
        onkeydown: (e: KeyboardEvent) => {
          const at = sections.findIndex((x) => x.id === s.id);
          const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? at - 1 : null;
          if (next === null) return;
          e.preventDefault();
          const target = sections[(next + sections.length) % sections.length]!;
          active = target.id;
          paint();
          nav.querySelector<HTMLElement>(`[data-id="${target.id}"]`)?.focus();
        },
      }, s.label),
    ),
  );
  const version = el('span', { class: 'ml-set-version', title: 'Versão instalada' }, i ? fmtVersion(i.current) : 'v—');
  root = el(
    'div',
    {
      class: 'ml-pal-wrap ml-settings',
      onkeydown: (e: KeyboardEvent) => {
        // o leitor/catalogo por baixo tambem ouvem teclas: nada daqui vaza para eles
        e.stopPropagation();
        if (e.key === 'Escape') closeSettings();
      },
    },
    el('div', { class: 'ml-pal-scrim', onclick: closeSettings }),
    el(
      'div',
      { class: 'ml-pal ml-set-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Configurações', tabindex: '-1' },
      el('header', { class: 'ml-set-head' }, el('h2', {}, 'Configurações'), version, el('button', { class: 'ml-btn ml-btn-ghost ml-btn-sm', type: 'button', 'aria-label': 'Fechar configurações', onclick: closeSettings }, '✕')),
      el('div', { class: 'ml-set-body' }, nav, el('section', { class: 'ml-set-panel', role: 'tabpanel' })),
    ),
  );
  document.body.append(root);
  // a versao e o estado da atualizacao acompanham a consulta, que pode terminar depois de abrir
  onInfo = (next) => {
    version.textContent = next ? fmtVersion(next.current) : 'v—';
    if (active === 'atualizacao' || active === 'sobre') paint();
  };
  onUpdate(onInfo);
  paint();
  nav.querySelector<HTMLElement>('[aria-selected=true]')?.focus();
  // os idiomas de chegada vem do servidor; a lista entra assim que chegar
  if (!targets.length) {
    void getTargets()
      .then((t) => {
        targets = t;
        if (active === 'geral') rerender();
      })
      .catch(() => undefined);
  }
}

window.addEventListener('ml:open-settings', (e) => openSettings((e as CustomEvent<SectionId | undefined>).detail));
