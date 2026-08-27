import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

/**
 * O segredo era sorteado a cada processo. Isso parecia inocente — a URL assinada
 * so' vale para a sessao — mas o cliente GUARDA a URL ja' assinada: favoritos,
 * "continuar lendo" e marcadores salvam `/api/img?u=..&s=..` no localStorage. A
 * cada reinicio do servidor toda capa guardada passava a responder 403 e a
 * biblioteca do usuario ficava sem imagem nenhuma.
 *
 * Ordem: env (fixa a chave entre replicas) > arquivo no cache > sorteia e grava.
 */
export function resolveSecret(cacheDir: string): string {
  const fromEnv = process.env['MANGA_LENS_SECRET']?.trim();
  if (fromEnv) return fromEnv;

  const file = join(cacheDir, 'secret');
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {
    /* primeira execucao: ainda nao existe */
  }

  const fresh = randomBytes(32).toString('hex');
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, fresh, { mode: 0o600 });
  } catch {
    // sem disco gravavel o app continua funcionando; so' volta a perder as capas
    // guardadas a cada reinicio, que e' o comportamento antigo
  }
  return fresh;
}

const secret = resolveSecret(config.cacheDir);

const mac = (payload: string): string => createHmac('sha256', secret).update(payload).digest('base64url');

export function signUrl(url: string, referer = ''): string {
  const u = Buffer.from(url, 'utf8').toString('base64url');
  const r = referer ? Buffer.from(referer, 'utf8').toString('base64url') : '';
  return `/api/img?u=${u}&r=${r}&s=${mac(`${u}.${r}`)}`;
}

export function verifyUrl(u: string, r: string, s: string): { url: string; referer?: string } {
  const expected = Buffer.from(mac(`${u}.${r}`));
  const got = Buffer.from(s);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    throw new Error('assinatura invalida');
  }
  return {
    url: Buffer.from(u, 'base64url').toString('utf8'),
    referer: r ? Buffer.from(r, 'base64url').toString('utf8') : undefined,
  };
}
