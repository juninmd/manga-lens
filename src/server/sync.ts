import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { config } from './config.ts';

/**
 * Sincronizacao por pasta: o progresso vai para um arquivo numa pasta que o
 * proprio usuario ja' sincroniza (Dropbox, OneDrive, Syncthing, rede). Sem
 * servidor nosso, sem conta, e o arquivo continua legivel por ele.
 */
export const SYNC_FILE = 'manga-lens-sync.json';
/** Progresso de anos de leitura cabe folgado; mais que isso e' arquivo errado. */
export const MAX_SYNC_BYTES = 5 * 1024 * 1024;

export class SyncError extends Error {}

const confPath = (): string => join(config.cacheDir, 'sync-config.json');

let dir: string = process.env['SYNC_DIR']?.trim() || loadDir();

function loadDir(): string {
  try {
    const raw = JSON.parse(readFileSync(confPath(), 'utf-8')) as { dir?: unknown };
    return typeof raw.dir === 'string' ? raw.dir : '';
  } catch {
    return '';
  }
}

export const syncDir = (): string => dir;

/** Troca a pasta. Vazio desliga. Pasta tem de existir: criar no lugar errado esconderia o erro de digitacao. */
export function setSyncDir(raw: string): void {
  const next = raw.trim();
  if (next) {
    if (next.length > 500 || !isAbsolute(next)) throw new SyncError('informe o caminho completo da pasta');
    let ok = false;
    try {
      ok = statSync(next).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new SyncError('pasta nao encontrada');
  }
  dir = next;
  mkdirSync(config.cacheDir, { recursive: true });
  writeFileSync(confPath(), JSON.stringify({ dir }), { encoding: 'utf-8', mode: 0o600 });
}

/** Conteudo atual do arquivo de sincronizacao, ou `null` se ainda nao existe. */
export function readSync(): unknown {
  if (!dir) throw new SyncError('sincronizacao desligada');
  const path = join(dir, SYNC_FILE);
  if (!existsSync(path)) return null;
  if (statSync(path).size > MAX_SYNC_BYTES) throw new SyncError('arquivo de sincronizacao grande demais');
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // arquivo pela metade (o servico de nuvem ainda baixando): trata como ausente
    // em vez de sobrescrever com o estado local e perder o da outra maquina
    throw new SyncError('arquivo de sincronizacao ilegivel agora; tente de novo em instantes');
  }
}

export function writeSync(data: unknown): void {
  if (!dir) throw new SyncError('sincronizacao desligada');
  const body = JSON.stringify(data);
  if (body.length > MAX_SYNC_BYTES) throw new SyncError('dados grandes demais para sincronizar');
  const path = join(dir, SYNC_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, 'utf-8');
  renameSync(tmp, path);
}
