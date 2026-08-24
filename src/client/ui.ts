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

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = document.getElementById('toasts') ?? document.body;
  const node = el('div', { class: `ml-toast ${kind === 'error' ? 'is-error' : ''}` }, message);
  host.append(node);
  setTimeout(() => node.classList.add('is-out'), 4200);
  setTimeout(() => node.remove(), 4800);
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
};

export const langLabel = (code: string): string => LANG_LABEL[code] ?? code;
