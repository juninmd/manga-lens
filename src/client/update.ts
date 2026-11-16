import { api, desktopInvoke, isDesktop } from './base.ts';
import { el, toast } from './ui.ts';
import {
  justUpdated,
  plainNotes,
  parsePrefs,
  progressOf,
  shouldAutoInstall,
  statusText,
  type DownloadState,
  type UpdatePrefs,
} from './update-flow.ts';

/** Espelho de `UpdateInfo` do servidor (GET /api/version). */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  downloadUrl: string | null;
  installerSize?: number | null;
  notes: string | null;
  publishedAt: string | null;
  checkedAt: number;
  disabled?: boolean;
  devBuild?: boolean;
  error?: string;
  /** da' para instalar de dentro do app: desktop + hash do instalador publicado */
  canInstall?: boolean;
}

export const REPO_URL = 'https://github.com/juninmd/manga-lens';

/** `0.2.0` -> `v0.2.0`; "dev" fica como esta */
export const fmtVersion = (v: string): string => (/^\d/.test(v) ? `v${v}` : v);

let info: UpdateInfo | undefined;
const listeners = new Set<(i: UpdateInfo | undefined) => void>();

export const getUpdate = (): UpdateInfo | undefined => info;
export const onUpdate = (fn: (i: UpdateInfo | undefined) => void): void => {
  listeners.add(fn);
};
export const offUpdate = (fn: (i: UpdateInfo | undefined) => void): void => {
  listeners.delete(fn);
};
const notify = (): void => {
  for (const fn of listeners) fn(info);
};

// ---------- armazenamento (tudo em try/catch: modo privado nao pode derrubar o app) ----------

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // sem storage: o aviso so' repete na proxima abertura
  }
};

const SEEN = 'ml:update-seen';
const PREFS = 'ml:update-prefs';
const TRIED = 'ml:update-tried';
const LAST_VERSION = 'ml:last-version';

export const getUpdatePrefs = (): UpdatePrefs => parsePrefs(read(PREFS));
export function setUpdatePrefs(patch: Partial<UpdatePrefs>): UpdatePrefs {
  const next = { ...getUpdatePrefs(), ...patch };
  write(PREFS, JSON.stringify(next));
  // ligar a checagem agora deve valer agora, nao daqui a 6 h
  if (patch.check || patch.install) void checkUpdate(true);
  return next;
}

const readTried = (): { version: string; at: number } | null => {
  try {
    const v = JSON.parse(read(TRIED) ?? 'null') as { version?: unknown; at?: unknown } | null;
    return v && typeof v.version === 'string' && typeof v.at === 'number' ? { version: v.version, at: v.at } : null;
  } catch {
    return null;
  }
};

// ---------- consulta ----------

export async function checkUpdate(force = false): Promise<UpdateInfo | undefined> {
  const prefs = getUpdatePrefs();
  try {
    // checagem desligada: so' pergunta a versao instalada, sem o servidor ir ao GitHub
    const query = !prefs.check ? '?local=1' : force ? '?refresh=1' : '';
    const res = await fetch(api(`/api/version${query}`), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    info = (await res.json()) as UpdateInfo;
  } catch {
    // servidor fora do ar: mantem o que ja' se sabia
    return info;
  }
  notify();
  if (!info.available || !info.latest) return info;

  // atualiza sozinho (so' no desktop e so' uma vez por dia por versao): a tela cheia mostra tudo
  if (shouldAutoInstall({ prefs, canInstall: Boolean(info.canInstall), available: true, latest: info.latest, tried: readTried(), now: Date.now() })) {
    void runUpdate({ auto: true });
    return info;
  }
  // senao, avisa uma vez por versao nova; depois disso so' o selo no trilho
  if (read(SEEN) !== info.latest) {
    write(SEEN, info.latest);
    toast(`Nova versão ${fmtVersion(info.latest)} disponível — abra "Atualização" no trilho`);
  }
  return info;
}

export function startUpdateChecks(): void {
  void checkUpdate().then(announceUpdated);
  setInterval(() => {
    if (getUpdatePrefs().check) void checkUpdate();
  }, 6 * 3600_000);
}

/** No Tauri o webview nao abre links externos sozinho: passa pelo plugin shell. */
export function openExternal(url: string): void {
  const shell = (window as unknown as { __TAURI__?: { shell?: { open?: (u: string) => Promise<void> } } }).__TAURI__?.shell;
  if (shell?.open) void shell.open(url);
  else window.open(url, '_blank', 'noopener');
}

// ---------- dialogo ----------

let dialog: HTMLElement | undefined;

function closeDialog(): void {
  dialog?.remove();
  dialog = undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function renderDialog(): void {
  if (!dialog) return;
  const i = info;
  const body = dialog.querySelector('.ml-upd-body');
  if (!body) return;
  const desktopNoHash = Boolean(i?.available && isDesktop() && !i.canInstall && i.downloadUrl);
  const status = !i
    ? 'Não consegui falar com o servidor interno.'
    : i.devBuild
      ? 'Build de desenvolvimento: sem versão carimbada, a checagem de atualização não roda.'
      : i.disabled
        ? 'A checagem de atualização está desligada (UPDATE_CHECK=off).'
        : !getUpdatePrefs().check
          ? 'A verificação automática está desligada nas configurações.'
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
    desktopNoHash ? el('p', { class: 'ml-upd-status' }, 'Esta release não publicou o hash do instalador, então o app não instala sozinho: baixe e rode o instalador.') : null,
    i?.available && i.notes ? el('pre', { class: 'ml-upd-notes' }, plainNotes(i.notes)) : null,
    el(
      'div',
      { class: 'ml-upd-actions' },
      i?.available && i.canInstall
        ? el(
            'button',
            {
              class: 'ml-btn ml-btn-primary',
              type: 'button',
              onclick: () => {
                closeDialog();
                void runUpdate({ auto: false });
              },
            },
            `Atualizar para v${i.latest} agora`,
          )
        : i?.available && link
          ? el('button', { class: 'ml-btn ml-btn-primary', type: 'button', onclick: () => openExternal(link) }, i.downloadUrl ? `Baixar v${i.latest}` : `Abrir release v${i.latest}`)
          : null,
      i?.available && i.url && i.downloadUrl ? el('button', { class: 'ml-btn', type: 'button', onclick: () => openExternal(i.url!) }, 'Ver notas da release') : null,
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
      el(
        'button',
        {
          class: 'ml-btn ml-btn-ghost',
          type: 'button',
          onclick: () => {
            closeDialog();
            window.dispatchEvent(new CustomEvent('ml:open-settings', { detail: 'update' }));
          },
        },
        'Preferências…',
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

// ---------- atualizar agora: tela cheia, com tudo visivel ----------

let running = false;

const COUNTDOWN_S = 5;

const postJson = async <T>(path: string): Promise<{ ok: boolean; body: T }> => {
  const res = await fetch(api(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return { ok: res.ok, body: (await res.json().catch(() => ({}))) as T };
};

type ServerState = DownloadState & { version: string | null; file: string | null };

/**
 * Baixa, confere e instala a versao nova, mostrando cada etapa numa tela cheia.
 * `auto` (aberta sozinha pelo app) comeca com uma contagem que da' tempo de dizer
 * "agora nao"; o clique em "Atualizar agora" pula a contagem.
 *
 * Marca a tentativa ANTES de baixar: instalador que falha nao pode virar um laco
 * de "atualizando…" a cada abertura do app.
 */
export async function runUpdate(opts: { auto: boolean }): Promise<void> {
  const i = info;
  if (running || !i?.available || !i.latest) return;
  running = true;
  const version = i.latest;
  const from = i.current;

  const bar = el('div', { class: 'ml-upd-bar-fill' });
  const barHost = el('div', { class: 'ml-upd-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Progresso da atualização' }, bar);
  const statusEl = el('p', { class: 'ml-upd-live', role: 'status', 'aria-live': 'polite' }, 'Preparando…');
  const actions = el('div', { class: 'ml-upd-actions' });
  const overlay = el(
    'div',
    { class: 'ml-upd-overlay', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': `Atualizando para a versão ${version}` },
    el(
      'div',
      { class: 'ml-upd-card' },
      el('h2', {}, 'Atualizando o MangaLens'),
      el('div', { class: 'ml-upd-flow' }, el('b', {}, fmtVersion(from)), el('span', { 'aria-hidden': 'true' }, '→'), el('b', { class: 'is-new' }, fmtVersion(version))),
      barHost,
      statusEl,
      i.notes ? el('pre', { class: 'ml-upd-notes' }, plainNotes(i.notes)) : null,
      actions,
    ),
  );
  document.body.append(overlay);

  let cancelled = false;
  const finish = (): void => {
    overlay.remove();
    running = false;
  };
  const setBar = (fraction: number | null): void => {
    barHost.classList.toggle('is-indeterminate', fraction === null);
    bar.style.width = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
    if (fraction !== null) barHost.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    else barHost.removeAttribute('aria-valuenow');
  };
  const setButtons = (...buttons: HTMLElement[]): void => actions.replaceChildren(...buttons);
  const button = (label: string, onclick: () => void, primary = false): HTMLButtonElement =>
    el('button', { class: `ml-btn ${primary ? 'ml-btn-primary' : ''}`, type: 'button', onclick }, label);

  const fail = (message: string): void => {
    setBar(0);
    barHost.classList.add('is-error');
    statusEl.textContent = message;
    const dl = i.downloadUrl ?? i.url;
    setButtons(
      button('Tentar de novo', () => {
        finish();
        void runUpdate({ auto: false });
      }, true),
      ...(dl ? [button('Baixar manualmente', () => openExternal(dl))] : []),
      button('Fechar', finish),
    );
  };

  try {
    if (opts.auto) {
      // contagem regressiva visivel: da' tempo de recusar sem esconder que vai acontecer
      let skip = false;
      setBar(0);
      setButtons(
        button('Atualizar agora', () => (skip = true), true),
        button('Agora não', () => (cancelled = true)),
      );
      for (let s = COUNTDOWN_S; s > 0 && !skip && !cancelled; s--) {
        statusEl.textContent = `Nova versão ${fmtVersion(version)} disponível. Atualizando em ${s} s…`;
        await sleep(1000);
      }
      if (cancelled) {
        write(TRIED, JSON.stringify({ version, at: Date.now() }));
        statusEl.textContent = 'Tudo bem — o app pergunta de novo amanhã. Dá para atualizar quando quiser pelo trilho lateral.';
        await sleep(1800);
        return finish();
      }
    }

    write(TRIED, JSON.stringify({ version, at: Date.now() }));
    setBar(null);
    statusEl.textContent = 'Preparando o download…';
    setButtons(
      button('Cancelar', () => {
        cancelled = true;
        void postJson('/api/update/cancel');
      }),
    );

    const start = await postJson<{ error?: string }>('/api/update/download');
    if (!start.ok) return fail(start.body.error ?? 'O servidor recusou o download.');

    const began = Date.now();
    for (;;) {
      if (cancelled) {
        statusEl.textContent = 'Atualização cancelada.';
        await sleep(900);
        return finish();
      }
      const res = await fetch(api('/api/update/state')).catch(() => null);
      const s = res?.ok ? ((await res.json()) as ServerState) : null;
      if (s) {
        setBar(progressOf(s));
        statusEl.textContent = statusText(s, version);
        if (s.phase === 'error') return fail(s.error ?? 'Não consegui baixar a atualização.');
        if (s.phase === 'ready' && s.file) {
          // "Cancelar" nao vale mais: o instalador esta' prestes a abrir
          setButtons();
          await sleep(700);
          try {
            await desktopInvoke('install_update', { path: s.file });
            statusEl.textContent = 'O instalador abriu. O MangaLens fecha agora e reabre na versão nova…';
          } catch (err) {
            return fail(`Não consegui abrir o instalador: ${(err as Error).message ?? err}`);
          }
          return; // o app fecha sozinho; a tela fica ate' la'
        }
        // o servidor reiniciou ou cancelou por fora: nao deixa a tela esperando para sempre
        if (s.phase === 'idle' && Date.now() - began > 3000) return fail('O download foi interrompido.');
      }
      await sleep(350);
    }
  } catch (err) {
    fail(`Algo deu errado: ${(err as Error).message ?? err}`);
  }
}

// ---------- "acabou de atualizar" ----------

let updatedDialog: HTMLElement | undefined;

function announceUpdated(): void {
  const current = info?.current;
  if (!current || !/^\d/.test(current)) return;
  const last = read(LAST_VERSION);
  write(LAST_VERSION, current);
  const done = justUpdated(last, current);
  if (!done || updatedDialog) return;
  // as notas so' vem de graca quando a release mais nova e' esta mesma
  const notes = info?.latest === current ? info.notes : null;
  const close = (): void => {
    updatedDialog?.remove();
    updatedDialog = undefined;
  };
  updatedDialog = el(
    'div',
    { class: 'ml-pal-wrap', onkeydown: (e: KeyboardEvent) => e.key === 'Escape' && close() },
    el('div', { class: 'ml-pal-scrim', onclick: close }),
    el(
      'div',
      { class: 'ml-pal ml-upd', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'MangaLens atualizado', tabindex: '-1' },
      el('h2', {}, 'MangaLens atualizado'),
      el('div', { class: 'ml-upd-flow' }, el('b', {}, fmtVersion(done.from)), el('span', { 'aria-hidden': 'true' }, '→'), el('b', { class: 'is-new' }, fmtVersion(done.to))),
      el('p', { class: 'ml-upd-status', role: 'status' }, 'A atualização foi instalada. Novidades desta versão:'),
      notes ? el('pre', { class: 'ml-upd-notes' }, plainNotes(notes)) : el('p', { class: 'ml-upd-status' }, 'As notas ficam na página da release.'),
      el(
        'div',
        { class: 'ml-upd-actions' },
        el('button', { class: 'ml-btn ml-btn-primary', type: 'button', onclick: close }, 'Continuar'),
        el('button', { class: 'ml-btn', type: 'button', onclick: () => openExternal(`${REPO_URL}/releases/tag/v${done.to}`) }, 'Ver a release'),
      ),
    ),
  );
  document.body.append(updatedDialog);
  updatedDialog.querySelector<HTMLElement>('.ml-btn')?.focus();
}

