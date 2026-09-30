import { HttpError } from './http.ts';

/** MangaKatana serves real JPEG/PNG/WebP pages as octet-stream. Verify the bytes. */
export async function normalizeProviderImage(response: Response, host: string): Promise<Response> {
  if (!/^i[1-3]\.mangakatana\.com$/.test(host) || response.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream') return response;
  const maxBytes = 32 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError('imagem sem conteudo', 415);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new HttpError('imagem excede o limite', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const head = Buffer.from(bytes.subarray(0, 12));
  const type = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'image/jpeg'
    : head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined;
  if (!type) throw new HttpError('conteudo de imagem invalido', 415);
  const headers = new Headers(response.headers);
  headers.set('Content-Type', type);
  headers.set('Content-Length', String(size));
  headers.delete('Content-Encoding');
  return new Response(bytes, { status: response.status, headers });
}
