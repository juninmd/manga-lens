/** Utilitarios sem estado do leitor: carregar imagem, rotulos e tipos de execucao. */
import type { FitMode, ReadingMode, TranslateEngine, TranslateMode } from './state.ts';
import { el } from './ui.ts';

/**
 * Pagina que nao esta' no palco nao tem <img>: carrega uma so' para o OCR.
 * `crossOrigin` e' obrigatorio, senao o canvas fica "tainted" e o OCR nao le.
 */
export function loadPageImage(url: string, signal: AbortSignal, timeoutMs = 20_000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    // host que aceita a conexao e nunca responde travaria a fila com `busy` para sempre
    const timer = window.setTimeout(() => finish(new Error('imagem demorou demais')), timeoutMs);
    const onAbort = (): void => finish(new DOMException('OCR cancelado', 'AbortError'));
    const finish = (err: Error | null): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (err) {
        // `src = ''` dispara outro `error`: sem soltar os handlers virava loop infinito
        img.onload = null;
        img.onerror = null;
        img.src = '';
        reject(err);
      } else resolve(img);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    img.onload = () => finish(img.naturalWidth > 0 ? null : new Error('imagem vazia'));
    img.onerror = () => finish(new Error('imagem nao carregou'));
    img.src = url;
  });
}

/** "1 pagina" / "3 paginas" — ui.ts ganha o mesmo helper em outra frente; local ate' la' */
export const plural = (n: number, s: string, p = `${s}s`): string => `${n} ${n === 1 ? s : p}`;

/**
 * Espera a imagem do sheet ficar utilizavel. Ouvir so' `load` era uma armadilha:
 * pagina que responde 404 (ou host bloqueado no proxy) nunca emite `load`, a
 * promessa nunca resolvia e o leitor ficava com `busy = true` para sempre — OCR,
 * traducao e fila morriam no capitulo inteiro ate' recarregar o app.
 */
export function imageReady(img: HTMLImageElement, timeoutMs = 20_000): Promise<boolean> {
  if (img.complete) return Promise.resolve(img.naturalWidth > 0);
  return new Promise((resolve) => {
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      resolve(ok);
    };
    const onLoad = (): void => done(img.naturalWidth > 0);
    const onError = (): void => done(false);
    const timer = window.setTimeout(() => done(false), timeoutMs);
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
  });
}

/**
 * "🪄 Traduzir" vira icone + <span class="ml-btn-label">Traduzir</span>: em tela
 * estreita o CSS esconde so' o texto. Como display:none tira o texto do nome
 * acessivel, o rotulo inteiro vai para aria-label.
 */
export function iconLabel(text: string): { children: (string | HTMLElement)[]; aria: Record<string, string> } {
  const m = /^(\S+)\s+(.+)$/.exec(text);
  if (!m) return { children: [text], aria: {} };
  return { children: [`${m[1]} `, el('span', { class: 'ml-btn-label' }, m[2]!)], aria: { 'aria-label': text } };
}

export const MODES: [ReadingMode, string][] = [
  ['single', 'pagina'],
  ['double', 'dupla'],
  ['strip', 'tira'],
];
export const FITS: [FitMode, string][] = [
  ['page', 'ajustar'],
  ['width', 'largura'],
  ['height', 'altura'],
];

/** motor/idioma fixados no inicio da execucao — trocar no meio nao mistura carimbos */
export interface RunCtx {
  mode: TranslateMode;
  engine: TranslateEngine;
  provider: string;
  /** idioma de destino fixado no inicio: trocar no meio nao pode carimbar espanhol como pt-BR */
  target: string;
  stamp: string;
  modeLabel: string;
  signal: AbortSignal;
}

export interface RunStats {
  translated: number;
  failedBalloons: number;
  failed: string[];
}

export const normalizeSame = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

