import { PAGE_IMAGE_RE, type ExplainInput, type VisionInput } from './ai.ts';

// Teto proprio: a pagina inteira (ate' 1400px de largura, JPEG) e' maior que o recorte do /api/ai/translate.
export const MAX_VISION_IMAGE = 8_000_000;
const MAX_QUESTION = 4_000;
const MAX_HISTORY = 12;
const MAX_HISTORY_CHARS = 20_000;
const MAX_PAGE_LINES = 300;
const MAX_LINE_CHARS = 1_000;

export class AiBodyError extends Error {}

const record = (raw: unknown): Record<string, unknown> => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new AiBodyError('corpo invalido');
  return raw as Record<string, unknown>;
};

/** Campo opcional de texto: ausente passa, tipo errado ou acima do teto e' recusado em vez de estourar 500 la' dentro. */
function text(o: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new AiBodyError(`${key} invalido`);
  return v;
}

function common(o: Record<string, unknown>): { series?: string; chapter?: string; provider?: string } {
  const out: { series?: string; chapter?: string; provider?: string } = {};
  const series = text(o, 'series', 300);
  const chapter = text(o, 'chapter', 40);
  const provider = text(o, 'provider', 40);
  if (series !== undefined) out.series = series;
  if (chapter !== undefined) out.chapter = chapter;
  if (provider !== undefined) out.provider = provider;
  return out;
}

export function parseVisionBody(raw: unknown): VisionInput {
  const o = record(raw);
  const image = o['imageDataUrl'];
  if (typeof image !== 'string' || image.length > MAX_VISION_IMAGE || !PAGE_IMAGE_RE.test(image)) {
    throw new AiBodyError('imagem da pagina invalida — recarregue a pagina e tente de novo');
  }
  return { imageDataUrl: image, ...common(o) };
}

export function parseExplainBody(raw: unknown): ExplainInput {
  const o = record(raw);
  const out: ExplainInput = common(o);
  const description = text(o, 'description', 20_000);
  const question = text(o, 'question', MAX_QUESTION);
  if (description !== undefined) out.description = description;
  if (question !== undefined) out.question = question;

  if (o['pageText'] !== undefined) {
    const lines = o['pageText'];
    if (!Array.isArray(lines) || lines.length > MAX_PAGE_LINES || lines.some((l) => typeof l !== 'string' || l.length > MAX_LINE_CHARS)) {
      throw new AiBodyError('pageText invalido');
    }
    out.pageText = lines as string[];
  }
  if (o['history'] !== undefined) {
    const h = o['history'];
    const ok = (m: unknown): m is { role: 'user' | 'assistant'; content: string } => {
      const r = m as { role?: unknown; content?: unknown } | null;
      return !!r && (r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string' && r.content.length <= MAX_HISTORY_CHARS;
    };
    if (!Array.isArray(h) || h.length > MAX_HISTORY || !h.every(ok)) throw new AiBodyError('history invalido');
    out.history = h.map(({ role, content }) => ({ role, content }));
  }
  return out;
}
