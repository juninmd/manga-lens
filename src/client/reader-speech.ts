import { readingOrder } from '../server/page-text.ts';
import type { OcrBlock } from './ocr.ts';
import type { SpeechItem } from './tts.ts';

/**
 * Baloes de uma pagina na ordem de leitura (RTL para manga), prontos para a voz.
 * Le a traducao quando existe; sem traducao, e so' se `allowOriginal`, o texto
 * reconhecido. Onomatopeia curta ("BAM!", "ドン") nao se le em voz alta.
 */
export function speakablePage(blocks: OcrBlock[], rtl: boolean, allowOriginal = false): SpeechItem[] {
  const ordered = readingOrder(blocks, rtl);
  const items: SpeechItem[] = [];
  for (const b of ordered) {
    const text = (b.pt?.trim() || (allowOriginal ? b.text.trim() : '')).replace(/\s+/g, ' ');
    if (!text || isSoundEffect(text)) continue;
    items.push({ index: b.id, text });
  }
  return items;
}

/** Ate' 2 palavras so' com maiusculas/exclamacao, ou so' pontuacao: efeito sonoro. */
export function isSoundEffect(text: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  const words = text.split(/\s+/);
  return words.length <= 2 && text === text.toUpperCase() && /[!]|^[\p{Lu}-]{2,}$/u.test(text) && /\p{Lu}/u.test(text);
}
