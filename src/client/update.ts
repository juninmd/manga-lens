import { api } from './base.ts';
import { el, toast } from './ui.ts';

/** Espelho de `UpdateInfo` do servidor (GET /api/version). */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  downloadUrl: string | null;
  notes: string | null;
  publishedAt: string | null;
  checkedAt: number;
  disabled?: boolean;
  devBuild?: boolean;
  error?: string;
}

/** `0.2.0` -> `v0.2.0`; "dev" fica como esta */
export const fmtVersion = (v: string): string => (/^\d/.test(v) ? `v${v}` : v);

let info: UpdateInfo | undefined;
const listeners = new Set<(i: UpdateInfo | undefined) => void>();

export const getUpdate = (): UpdateInfo | undefined => info;
export const onUpdate = (fn: (i: UpdateInfo | undefined) => void): void => {
  listeners.add(fn);
};

const SEEN = 'ml:update-seen';
const seen = (): string | null => {
  try {
    return localStorage.getItem(SEEN);
  } catch {
    return null;
  }
};
const markSeen = (v: string): void => {
  try {
    localStorage.setItem(SEEN, v);
  } catch {
    // sem storage: o aviso so' repete na proxima abertura
  }
};

export async function checkUpdate(force = false): Promise<UpdateInfo | undefined> {
  try {
    const res = await fetch(api(`/api/version${force ? '?refresh=1' : ''}`), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    info = (await res.json()) as UpdateInfo;
  } catch {
    // servidor fora do ar: mantem o que ja' se sabia
    return info;
  }
  // avisa uma vez por versao nova; depois disso so' o selo no trilho
  if (info.available && info.latest && seen() !== info.latest) {
    markSeen(info.latest);
    toast(`Nova versão ${info.latest} disponível — abra "Atualização" no trilho`);
  }
  for (const fn of listeners) fn(info);
  return info;
}

export function startUpdateChecks(): void {
  void checkUpdate();
  setInterval(() => void checkUpdate(), 6 * 3600_000);
}

/** No Tauri o webview nao abre links externos sozinho: passa pelo plugin shell. */
function openExternal(url: string): void {
  const shell = (window as unknown as { __TAURI__?: { shell?: { open?: (u: string) => Promise<void> } } }).__TAURI__?.shell;
  if (shell?.open) void shell.open(url);
  else window.open(url, '_blank', 'noopener');
}

let dialog: HTMLElement | undefined;

function closeDialog(): void {
  dialog?.remove();
  dialog = undefined;
}

function renderDialog(): void {
  if (!dialog) return;
  const i = info;
  const body = dialog.querySelector('.ml-upd-body');
  if (!body) return;
  const status = !i
    ? 'Não consegui falar com o servidor interno.'
    : i.devBuild
      ? 'Build de desenvolvimento: sem versão carimbada, a checagem de atualização não roda.'
      : i.disabled
      ? 'A checagem de atualização está desligada (UPDATE_CHECK=off).'
      : i.error
        ? `Não consegui consultar as releases agora (${i.error}).`
        : i.available
          ? `Há uma versão nova: ${fmtVersion(i.latest ?? '')}.`
          : 'Você está na versão mais recente.';
  const link = i?.downloadUrl ?? i?.url;
  const nodes: (Node | null)[] = [
    el(
      'div',
      { class: 'ml-upd-vers' },
      el('div', {}, el('small', {}, 'Instalada'), el('b', {}, i ? fmtVersion(i.current) : '—')),
      el('div', { class: i?.available ? 'is-new' : '' }, el('small', {}, 'Disponível'), el('b', {}, i?.latest ? `v${i.latest}` : '—')),
    ),
    el('p', { class: 'ml-upd-status', role: 'status' }, status),
    i?.available && i.notes ? el('pre', { class: 'ml-upd-notes' }, i.notes) : null,
    el(
      'div',
      { class: 'ml-upd-actions' },
      i?.available && link
        ? el('button', { class: 'ml-btn ml-btn-primary', type: 'button', onclick: () => openExternal(link) }, i.downloadUrl ? `Baixar v${i.latest}` : `Abrir release v${i.latest}`)
        : null,
      i?.available && i.url && i.downloadUrl
        ? el('button', { class: 'ml-btn', type: 'button', onclick: () => openExternal(i.url!) }, 'Ver notas da release')
        : null,
      el(
        'button',
        {
          class: 'ml-btn',
          type: 'button',
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = 'Verificando…';
            await checkUpdate(true);
            renderDialog();
          },
        },
        'Verificar agora',
      ),
      el('button', { class: 'ml-btn ml-btn-ghost', type: 'button', onclick: closeDialog }, 'Fechar'),
    ),
  ];
  body.replaceChildren(...nodes.filter((n): n is Node => n !== null));
}

export function openUpdateDialog(): void {
  if (dialog) return;
  dialog = el(
    'div',
    { class: 'ml-pal-wrap', onkeydown: (e: KeyboardEvent) => e.key === 'Escape' && closeDialog() },
    el('div', { class: 'ml-pal-scrim', onclick: closeDialog }),
    el('div', { class: 'ml-pal ml-upd', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Atualização', tabindex: '-1' }, el('h2', {}, 'Atualização'), el('div', { class: 'ml-upd-body' })),
  );
  document.body.append(dialog);
  renderDialog();
  dialog.querySelector<HTMLElement>('.ml-btn')?.focus();
  // checagem fresca ao abrir (o servidor limita a frequencia)
  void checkUpdate(true).then(renderDialog);
}
