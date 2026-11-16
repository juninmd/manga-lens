import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.ts';
import { HttpError, httpFetch } from './http.ts';
import { REPO, type UpdateInfo } from './version.ts';

/**
 * Atualizacao dentro do app: baixa o instalador da release, confere o SHA-256 que
 * o GitHub publica para o arquivo e deixa o `.exe` pronto na pasta de updates. Quem
 * ABRE o instalador e' o shell Rust (comando `install_update`), que revalida o
 * caminho — este modulo so' baixa e prova que o arquivo e' o da release.
 *
 * O atualizador oficial do Tauri verifica uma assinatura minisign; ela exige um par
 * de chaves que so' o dono do repositorio pode criar. Sem ele, o que garante o
 * arquivo e': HTTPS, URL presa a este repositorio, hosts presos ao GitHub a cada
 * redirect e o hash publicado. O hash vem da mesma API que a URL — protege de
 * download corrompido ou de CDN trocando o arquivo, nao de conta comprometida.
 */

export type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  received: number;
  total: number;
  /** caminho do instalador verificado (so' com `phase: 'ready'`) */
  file: string | null;
  error: string | null;
}

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 422 | 502 = 422,
  ) {
    super(message);
  }
}

const idle = (): UpdateState => ({ phase: 'idle', version: null, received: 0, total: 0, file: null, error: null });
let state: UpdateState = idle();
let job: { version: string; abort: AbortController; done: Promise<void> } | undefined;

/** Teto de seguranca: o instalador real tem ~40 MB. */
const MAX_INSTALLER = 300_000_000;
const MAX_HOPS = 5;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** So' o instalador desta release, deste repositorio: nao e' URL que o cliente escolhe. */
const ASSET_URL = new RegExp(`^https://github\\.com/${escapeRe(REPO)}/releases/download/v(\\d+\\.\\d+\\.\\d+)/([A-Za-z0-9._-]+\\.exe)$`);
/** O GitHub entrega o arquivo por github.com e por CDN `*.githubusercontent.com`. */
const hostOk = (host: string): boolean => host === 'github.com' || host.endsWith('.githubusercontent.com');

/** O app desktop avisa o sidecar por ambiente; no navegador nao ha' o que instalar. */
export const isDesktopApp = (): boolean => process.env['MANGA_LENS_DESKTOP'] === '1';

export const updatesDir = (): string => join(config.cacheDir, 'updates');

export const getUpdateState = (): UpdateState => ({ ...state });

/** so' para teste */
export function resetUpdateState(): void {
  job?.abort.abort();
  job = undefined;
  state = idle();
}

export async function cancelUpdateDownload(): Promise<UpdateState> {
  if (job && (state.phase === 'downloading' || state.phase === 'verifying')) {
    job.abort.abort();
    await job.done;
  }
  return getUpdateState();
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest('hex');
}

/** Um salto por vez, como o proxy de imagem: cada destino tem de continuar no GitHub. */
async function openDownload(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:' || !hostOk(parsed.hostname)) throw new UpdateError('o download foi redirecionado para fora do GitHub', 502);
    const res = await httpFetch(current, { accept: 'application/octet-stream', timeoutMs: 30_000, bodyTimeoutMs: 60_000, retries: 2, redirect: 'manual', signal });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) throw new UpdateError(`o GitHub respondeu ${res.status} ao baixar o instalador`, 502);
    return res;
  }
  throw new UpdateError('redirects demais ao baixar o instalador', 502);
}

async function run(info: UpdateInfo, name: string, sha256: string, abort: AbortController): Promise<void> {
  const dir = updatesDir();
  const finalPath = join(dir, name);
  const partPath = `${finalPath}.part`;
  try {
    await mkdir(dir, { recursive: true });
    // ja' baixado antes (cancelou a instalacao, o app fechou): so' reconfere
    if (await stat(finalPath).then((s) => s.size > 0, () => false)) {
      state = { ...state, phase: 'verifying' };
      if ((await sha256OfFile(finalPath)) === sha256) {
        state = { ...state, phase: 'ready', file: finalPath, received: state.total, error: null };
        return;
      }
      await rm(finalPath, { force: true });
    }

    const res = await openDownload(info.downloadUrl!, abort.signal);
    const declared = Number(res.headers.get('content-length') ?? 0);
    const total = info.installerSize ?? (declared || 0);
    if (total > MAX_INSTALLER) throw new UpdateError('o instalador e grande demais', 422);
    state = { ...state, total, received: 0 };

    const hash = createHash('sha256');
    const writer = Bun.file(partPath).writer();
    const reader = res.body?.getReader();
    if (!reader) throw new UpdateError('o GitHub nao enviou o arquivo', 502);
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_INSTALLER) throw new UpdateError('o instalador e grande demais', 422);
        hash.update(value);
        writer.write(value);
        state = { ...state, received };
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    } finally {
      await writer.end();
    }

    state = { ...state, phase: 'verifying' };
    if (info.installerSize && received !== info.installerSize) throw new UpdateError(`o download veio incompleto (${received} de ${info.installerSize} bytes)`, 502);
    if (hash.digest('hex') !== sha256) throw new UpdateError('o arquivo baixado nao confere com o hash publicado pela release — nao foi instalado', 422);
    // MZ: um instalador do Windows; pagina de erro em HTML com status 200 nao passa nem com hash "certo"
    const head = new Uint8Array(await Bun.file(partPath).slice(0, 2).arrayBuffer());
    if (head[0] !== 0x4d || head[1] !== 0x5a) throw new UpdateError('o arquivo baixado nao e um instalador do Windows', 422);

    await rename(partPath, finalPath);
    // so' a versao nova fica: instaladores velhos somem para nao acumular dezenas de MB por release
    for (const f of await readdir(dir).catch(() => [] as string[])) if (f !== name) await rm(join(dir, f), { force: true });
    state = { ...state, phase: 'ready', file: finalPath, received, error: null };
  } catch (err) {
    await rm(partPath, { force: true });
    const cancelled = abort.signal.aborted;
    state = {
      ...state,
      phase: cancelled ? 'idle' : 'error',
      file: null,
      received: 0,
      error: cancelled ? null : err instanceof UpdateError || err instanceof HttpError ? err.message : `falha ao baixar: ${(err as Error).message}`,
    };
    if (cancelled) state = { ...idle() };
  } finally {
    if (job?.abort === abort) job = undefined;
  }
}

/**
 * Comeca o download da versao `info.latest` (idempotente: se ja' esta' baixando a
 * mesma versao, devolve o estado atual). Tudo sai de `info`, nunca do cliente.
 */
export async function startUpdateDownload(info: UpdateInfo): Promise<UpdateState> {
  if (!info.available || !info.latest || !info.downloadUrl) throw new UpdateError('nao ha atualizacao disponivel', 409);
  const m = ASSET_URL.exec(info.downloadUrl);
  if (!m || m[1] !== info.latest) throw new UpdateError('o instalador da release nao esta no repositorio do app', 422);
  if (!info.installerSha256) throw new UpdateError('esta release nao publicou o hash do instalador: baixe e instale manualmente', 422);
  if (job && job.version === info.latest) return getUpdateState();
  if (job) await cancelUpdateDownload();
  if (state.phase === 'ready' && state.version === info.latest && state.file) return getUpdateState();

  const abort = new AbortController();
  state = { phase: 'downloading', version: info.latest, received: 0, total: info.installerSize ?? 0, file: null, error: null };
  job = { version: info.latest, abort, done: run(info, m[2]!, info.installerSha256, abort) };
  return getUpdateState();
}

