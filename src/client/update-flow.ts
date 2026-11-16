import { compareVersions, parseVersion } from '../shared/semver.ts';

/**
 * Regras da atualizacao que nao dependem de tela: quando o app se atualiza sozinho,
 * se acabou de ser atualizado, como mostrar o progresso. Ficam separadas para ter teste.
 */

export interface UpdatePrefs {
  /** consulta as releases ao abrir e a cada 6 h */
  check: boolean;
  /** ao achar versao nova, baixa e instala sozinho (so' no app desktop) */
  install: boolean;
}

export const DEFAULT_PREFS: UpdatePrefs = { check: true, install: true };

export function parsePrefs(raw: string | null): UpdatePrefs {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<UpdatePrefs>;
    return { check: typeof v.check === 'boolean' ? v.check : DEFAULT_PREFS.check, install: typeof v.install === 'boolean' ? v.install : DEFAULT_PREFS.install };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Depois de tentar instalar a versao X, nao insiste sozinho por este tempo: instalador que falha nao pode virar laco a cada abertura. */
export const RETRY_AFTER_MS = 24 * 3600_000;

export interface AutoInstallInput {
  prefs: UpdatePrefs;
  canInstall: boolean;
  available: boolean;
  latest: string | null;
  /** ultima tentativa automatica registrada */
  tried: { version: string; at: number } | null;
  now: number;
}

export function shouldAutoInstall(i: AutoInstallInput): boolean {
  if (!i.prefs.check || !i.prefs.install || !i.canInstall || !i.available || !i.latest) return false;
  if (i.tried && i.tried.version === i.latest && i.now - i.tried.at < RETRY_AFTER_MS) return false;
  return true;
}

/** `{from, to}` quando a versao em execucao e' mais nova que a da ultima abertura; senao `null`. */
export function justUpdated(last: string | null, current: string): { from: string; to: string } | null {
  if (!last || !parseVersion(last) || !parseVersion(current)) return null;
  return compareVersions(current, last) > 0 ? { from: last, to: current } : null;
}

/**
 * Notas da release (markdown do `release-notes.ts`) como texto de tela: o diálogo
 * mostra em `<pre>`, e `### Novidades` / `**fontes**` crus parecem erro.
 */
export function plainNotes(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) return heading[1]!.trim().toUpperCase();
      return line.replace(/^(\s*)[-*]\s+/, '$1• ');
    })
    .join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} KB`;
  return `${(n / 1024 / 1024).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

export interface DownloadState {
  phase: 'idle' | 'downloading' | 'verifying' | 'ready' | 'error';
  received: number;
  total: number;
  error: string | null;
}

/** Fracao 0..1 para a barra; `null` quando nao da' para saber (barra indeterminada). */
export function progressOf(s: DownloadState): number | null {
  if (s.phase === 'verifying' || s.phase === 'ready') return 1;
  if (s.phase !== 'downloading' || s.total <= 0) return null;
  return Math.min(1, Math.max(0, s.received / s.total));
}

/** O que a tela diz em cada etapa — e' o que torna a atualizacao "visivel". */
export function statusText(s: DownloadState, version: string): string {
  switch (s.phase) {
    case 'downloading':
      return s.total > 0
        ? `Baixando a v${version}… ${fmtBytes(s.received)} de ${fmtBytes(s.total)} (${Math.round((progressOf(s) ?? 0) * 100)}%)`
        : `Baixando a v${version}… ${fmtBytes(s.received)}`;
    case 'verifying':
      return 'Conferindo a integridade do arquivo (SHA-256)…';
    case 'ready':
      return 'Abrindo o instalador… o MangaLens fecha e reabre sozinho na versão nova.';
    case 'error':
      return s.error ?? 'Não consegui atualizar.';
    default:
      return 'Preparando…';
  }
}
