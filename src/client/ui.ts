type Props = Record<string, unknown>;
type Child = Node | string | null | undefined | false;

/** Helper minimo de DOM — evita framework para manter o bundle leve. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') node.innerHTML = String(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** append que aceita null/false — deixa o JSX-like condicional legivel. */
export function appendAll(node: ParentNode, ...children: Child[]): void {
  for (const child of children) if (child) node.append(child);
}

export const qs = <T extends Element>(sel: string, root: ParentNode = document): T => {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`elemento nao encontrado: ${sel}`);
  return found;
};

/**
 * Erro ficava 4,2s como o aviso comum — "OCR falhou: ..." sumia antes de ser
 * lido. Erro dura mais, e' `role=alert`, e qualquer toast pausa o relogio
 * enquanto o mouse/foco esta' sobre ele e pode ser fechado no ✕.
 */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = document.getElementById('toasts') ?? document.body;
  const ttl = kind === 'error' ? 8000 : 4200;
  let hideTimer: number | undefined;
  let removeTimer: number | undefined;
  // depois do ✕ o mouse sai do toast e `arm` ressuscitava um no' invisivel por ate' 8s
  let closed = false;
  const dismiss = (): void => {
    closed = true;
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    node.classList.add('is-out');
    removeTimer = window.setTimeout(() => node.remove(), 600);
  };
  const arm = (): void => {
    if (closed) return;
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    hideTimer = window.setTimeout(dismiss, ttl);
  };
  const pause = (): void => {
    if (closed) return;
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    node.classList.remove('is-out');
  };
  const node = el(
    'div',
    {
      class: `ml-toast ${kind === 'error' ? 'is-error' : ''}`,
      role: kind === 'error' ? 'alert' : 'status',
      onmouseenter: pause,
      onmouseleave: arm,
      onfocusin: pause,
      onfocusout: arm,
    },
    el('span', { class: 'ml-toast-text' }, message),
    el('button', { class: 'ml-toast-close', type: 'button', 'aria-label': 'fechar', onclick: dismiss }, '✕'),
  );
  host.append(node);
  arm();
}

export const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) => {
  let t: number | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
};

export const STATUS_LABEL: Record<string, string> = {
  ongoing: 'em publicacao',
  completed: 'completo',
  hiatus: 'hiato',
  cancelled: 'cancelado',
  upcoming: 'em breve',
};

export const LANG_LABEL: Record<string, string> = {
  'pt-br': 'Portugues (BR)',
  en: 'Ingles',
  ja: 'Japones',
  ko: 'Coreano',
  zh: 'Chines',
  es: 'Espanhol',
  'es-la': 'Espanhol (LA)',
  fr: 'Frances',
  it: 'Italiano',
  de: 'Alemao',
  ru: 'Russo',
  id: 'Indonesio',
  local: 'arquivo local',
  // codigos que o MangaDex devolve crus (translatedLanguage)
  pt: 'Portugues (PT)',
  'zh-hk': 'Chines (HK)',
  vi: 'Vietnamita',
  tr: 'Turco',
  pl: 'Polones',
  uk: 'Ucraniano',
  ar: 'Arabe',
  th: 'Tailandes',
  hu: 'Hungaro',
  nl: 'Holandes',
  ro: 'Romeno',
  cs: 'Tcheco',
  bg: 'Bulgaro',
  fa: 'Persa',
  he: 'Hebraico',
  ms: 'Malaio',
  tl: 'Filipino',
  'ja-ro': 'Japones (romaji)',
  'zh-ro': 'Chines (romanizado)',
  'ko-ro': 'Coreano (romanizado)',
};

export const langLabel = (code: string): string => LANG_LABEL[code] ?? code;

/** tipo da obra como vem do provider ('comic') -> rotulo do filtro ('HQ / OEL') */
export const TYPE_LABEL: Record<string, string> = {
  manga: 'Manga',
  manhwa: 'Manhwa',
  manhua: 'Manhua',
  comic: 'HQ / OEL',
  oel: 'HQ / OEL',
  local: 'arquivo local',
};

/** `plural(1, 'pagina')` -> '1 pagina'; `plural(2, 'balao', 'baloes')` -> '2 baloes' */
export const plural = (n: number, sing: string, plur = `${sing}s`): string =>
  `${n.toLocaleString('pt-BR')} ${n === 1 ? sing : plur}`;
