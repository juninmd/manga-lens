import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Segredo efemero por processo, a menos que fixado por env (util atras de varias replicas).
const secret = process.env['MANGA_LENS_SECRET']?.trim() || randomBytes(32).toString('hex');

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
