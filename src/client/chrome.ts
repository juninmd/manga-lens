import { el, toast } from './ui.ts';
import { fmtVersion, getUpdate, onUpdate, openUpdateDialog, startUpdateChecks } from './update.ts';

/**
 * Casca da nova UI: aurora ambiente, trilho lateral, paleta de comandos (Ctrl K)
 * e inclinacao 3D das capas. Nao tem logica propria de catalogo: toda acao
 * clica nos botoes que o Catalog ja' monta (`data-act`), entao nenhum recurso
 * muda de comportamento.
 */

type Action = { label: string; hint: string; run: () => void };

const ICONS: Record<string, string> = {
  explore: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  fav: '<path d="M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z"/>',
  resume: '<path d="M5 4v16l14-8z"/>',
  sources: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  ai: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  backup: '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3"/>',
  restore: '<path d="M12 21V9m0 0-4 4m4-4 4 4M4 7V4h16v3"/>',
  update: '<circle cx="12" cy="12" r="9"/><path d="m8 12 4-4 4 4M12 8v8"/>',
};

const svg = (key: string): SVGSVGElement => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ml-ico');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[key] ?? '';
  return s;
};

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** clica no controle real do catalogo; some em silencio se a tela ainda nao o montou */
const press = (act: string): void => {
  document.querySelector<HTMLElement>(`[data-act="${act}"]`)?.click();
};

const resume = (): void => {
  const first = document.querySelector<HTMLElement>('.ml-resume');
  if (first) first.click();
  else toast('nada para continuar ainda: abra uma obra primeiro');
};

const focusSearch = (): void => {
  document.querySelector<HTMLInputElement>('input.ml-search')?.focus();
};

const toggleTheme = (): void => {
  const root = document.documentElement;
  const dark = (root.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'dark';
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('ml:theme', root.dataset.theme);
  } catch {
    // modo privado: o tema vale so' nesta sessao
  }
};

/** Item fixo no pe' do trilho: versao instalada sempre visivel e selo quando ha' release nova. */
function buildVersionItem(): HTMLElement {
  const label = el('span', {}, 'Atualização');
  const ver = el('small', { class: 'ml-ver' }, 'v—');
  const btn = el(
    'button',
    { class: 'ml-rail-item ml-rail-update', type: 'button', 'aria-label': 'Versão e atualizações', onclick: openUpdateDialog },
    svg('update'),
    label,
  );
  const render = (): void => {
    const i = getUpdate();
    if (i) ver.textContent = fmtVersion(i.current);
    btn.classList.toggle('has-update', Boolean(i?.available));
    label.textContent = i?.available ? `Atualizar para v${i.latest}` : 'Atualização';
    btn.setAttribute('aria-label', i?.available ? `Versão ${i.latest} disponível` : 'Versão e atualizações');
    btn.title = i ? `Instalada: ${fmtVersion(i.current)}${i.latest ? ` · Disponível: ${fmtVersion(i.latest)}` : ''}` : '';
  };
  onUpdate(render);
  return el('div', { class: 'ml-rail-ver-wrap' }, btn, ver);
}

function buildRail(): HTMLElement {
  const item = (icon: string, label: string, run: () => void, act?: string): HTMLButtonElement =>
    el(
      'button',
      { class: 'ml-rail-item', type: 'button', 'data-nav': act ?? icon, 'aria-label': label, onclick: run },
      svg(icon),
      el('span', {}, label),
    );
  const rail = el(
    'nav',
    { class: 'ml-rail', 'aria-label': 'Principal' },
    el('div', { class: 'ml-rail-logo' }, el('i', { class: 'ml-lens' }), el('span', {}, 'MangaLens')),
    item('explore', 'Explorar', focusSearch),
    item('fav', 'Favoritos', () => press('fav')),
    item('resume', 'Continuar lendo', resume),
    item('sources', 'Fontes', () => press('sources')),
    item('ai', 'IA e motores', () => press('ai')),
    item('backup', 'Backup', () => press('backup')),
    item('restore', 'Importar backup', () => press('import')),
    el('div', { class: 'ml-rail-grow' }),
    buildVersionItem(),
    el('button', { class: 'ml-rail-item', type: 'button', 'aria-label': 'Paleta de comandos', onclick: openPalette }, el('kbd', {}, 'Ctrl K'), el('span', {}, 'Comandos')),
  );
  return rail;
}

// ---------- paleta ----------

let palette: HTMLElement | undefined;
let paletteSel = 0;
let paletteItems: Action[] = [];
let lastFocus: Element | null = null;

const ACTIONS: Action[] = [
  { label: 'Buscar no catálogo', hint: '/', run: focusSearch },
  { label: 'Continuar lendo', hint: 'Leitor', run: resume },
  { label: 'Mostrar só favoritos', hint: 'Catálogo', run: () => press('fav') },
  { label: 'Abrir filtros', hint: 'Catálogo', run: () => press('filters') },
  { label: 'Escolher fontes', hint: 'Gaveta', run: () => press('sources') },
  { label: 'Configurar IA e motores', hint: 'Gaveta', run: () => press('ai') },
  { label: 'Baixar backup', hint: 'Dados', run: () => press('backup') },
  { label: 'Importar backup', hint: 'Dados', run: () => press('import') },
  { label: 'Versão e atualizações', hint: 'Sobre', run: openUpdateDialog },
  { label: 'Alternar tema claro/escuro', hint: 'Aparência', run: toggleTheme },
];

function renderPalette(query: string): void {
  if (!palette) return;
  const q = norm(query.trim());
  const search: Action[] = q
    ? [
        {
          label: `Buscar “${query.trim()}” no catálogo`,
          hint: 'Enter',
          run: () => {
            const input = document.querySelector<HTMLInputElement>('input.ml-search');
            if (!input) return;
            input.value = query.trim();
            input.focus();
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          },
        },
      ]
    : [];
  paletteItems = [...ACTIONS.filter((a) => norm(a.label).includes(q)), ...search];
  paletteSel = Math.min(paletteSel, Math.max(0, paletteItems.length - 1));
  const list = palette.querySelector('ul');
  if (!list) return;
  list.replaceChildren(
    ...paletteItems.map((a, i) =>
      el(
        'li',
        {
          class: i === paletteSel ? 'is-sel' : '',
          role: 'option',
          'aria-selected': String(i === paletteSel),
          onclick: () => runPalette(i),
        },
        el('span', {}, a.label),
        el('small', {}, a.hint),
      ),
    ),
  );
}

function runPalette(i: number): void {
  const action = paletteItems[i];
  closePalette(false);
  action?.run();
}

function closePalette(restore = true): void {
  palette?.remove();
  palette = undefined;
  if (restore && lastFocus instanceof HTMLElement) lastFocus.focus();
}

function openPalette(): void {
  if (palette) return;
  lastFocus = document.activeElement;
  paletteSel = 0;
  const input = el('input', {
    class: 'ml-pal-input',
    placeholder: 'Digite um comando ou o nome de uma obra…',
    'aria-label': 'Paleta de comandos',
    oninput: () => {
      paletteSel = 0;
      renderPalette(input.value);
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1);
        renderPalette(input.value);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        paletteSel = Math.max(0, paletteSel - 1);
        renderPalette(input.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runPalette(paletteSel);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePalette();
      }
    },
  });
  palette = el(
    'div',
    { class: 'ml-pal-wrap' },
    el('div', { class: 'ml-pal-scrim', onclick: () => closePalette() }),
    el('div', { class: 'ml-pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Paleta de comandos' }, input, el('ul', { role: 'listbox' })),
  );
  document.body.append(palette);
  renderPalette('');
  input.focus();
}

// ---------- capas 3D ----------

function wireTilt(): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  document.addEventListener('pointermove', (e) => {
    if (reduced.matches || e.pointerType !== 'mouse') return;
    const cover = (e.target as Element | null)?.closest?.('.ml-card .ml-cover') as HTMLElement | null;
    if (!cover) return;
    const r = cover.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    cover.style.setProperty('--ry', `${(x - 0.5) * 12}deg`);
    cover.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
    cover.style.setProperty('--gx', `${x * 100}%`);
    cover.style.setProperty('--gy', `${y * 100}%`);
  });
  document.addEventListener('pointerout', (e) => {
    const cover = (e.target as Element | null)?.closest?.('.ml-card .ml-cover') as HTMLElement | null;
    if (!cover || cover.contains(e.relatedTarget as Node | null)) return;
    cover.style.removeProperty('--rx');
    cover.style.removeProperty('--ry');
  });
}

/** indicador deslizante sob a aba ativa (Manga / HQ / Livro) */
function wireTabPill(): void {
  const place = (): void => {
    const bar = document.querySelector<HTMLElement>('.ml-typetabs');
    const on = bar?.querySelector<HTMLElement>('.ml-typetab.is-on');
    if (!bar || !on) return;
    bar.style.setProperty('--pill-x', `${on.offsetLeft}px`);
    bar.style.setProperty('--pill-w', `${on.offsetWidth}px`);
  };
  new MutationObserver(place).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  addEventListener('resize', place);
  place();
}

export function mountChrome(): void {
  try {
    const saved = localStorage.getItem('ml:theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch {
    // sem storage: segue o tema do sistema
  }
  document.body.classList.add('ml-v2');
  document.body.prepend(el('div', { class: 'ml-aurora', 'aria-hidden': 'true' }, el('i', {}), el('i', {})));
  document.body.append(buildRail());
  wireTilt();
  wireTabPill();
  startUpdateChecks();
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (palette) closePalette();
      else openPalette();
      return;
    }
    const t = e.target as HTMLElement | null;
    if (e.key === '/' && !t?.closest('input, textarea, select, [contenteditable]') && !document.body.classList.contains('is-reading')) {
      e.preventDefault();
      focusSearch();
    }
  });
}
