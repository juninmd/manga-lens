import { humanizeError, ttsSpeak, type TtsEngineId } from './api.ts';

/** Trecho por pedido: frase inteira, mas curto o bastante para o audio chegar rapido. */
const MAX_CHUNK = 400;
/** trechos baixados a frente do que esta' tocando — esconde a latencia do motor */
const PREFETCH = 2;

/**
 * Fatia um paragrafo em frases de ate' `max` letras. Frase maior que isso quebra
 * na virgula e, em ultimo caso, no espaco: motor SaaS cobra e demora por trecho,
 * e o Kokoro local engasga com bloco gigante.
 */
export function splitForSpeech(text: string, max = MAX_CHUNK): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["'»”)\]]*|$)\s*/g) ?? [clean];
  const out: string[] = [];
  let current = '';
  const push = (piece: string): void => {
    if ((current + piece).length <= max) {
      current += piece;
      return;
    }
    if (current.trim()) out.push(current.trim());
    current = '';
    if (piece.length <= max) {
      current = piece;
      return;
    }
    // frase sozinha maior que o teto: corta em virgula/espaco
    let rest = piece;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
      const at = cut > max / 3 ? cut + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    current = rest;
  };
  for (const s of sentences) push(s);
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

export interface SpeechItem {
  /** indice do paragrafo no capitulo — volta no `onPara` para o leitor destacar */
  index: number;
  text: string;
  /** idioma do texto (voz do sistema escolhe a voz por ele) */
  lang?: string;
}

interface Chunk {
  index: number;
  text: string;
  lang?: string;
  audio?: Promise<Blob>;
}

export interface SpeakerOptions {
  engine: TtsEngineId;
  voice?: string;
  rate: number;
  onPara: (index: number) => void;
  onEnd: () => void;
  onError: (message: string) => void;
  /** motor local fora do ar: segue na voz do sistema e avisa */
  onFallback?: (message: string) => void;
}

export const browserSpeechAvailable = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Vozes do sistema para o idioma; PT-BR primeiro quando o idioma e' portugues. */
export function systemVoices(lang = 'pt-BR'): SpeechSynthesisVoice[] {
  if (!browserSpeechAvailable()) return [];
  const base = lang.slice(0, 2).toLowerCase();
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith(base))
    .sort((a, b) => Number(b.lang.toLowerCase() === lang.toLowerCase()) - Number(a.lang.toLowerCase() === lang.toLowerCase()));
}

/**
 * Toca uma fila de paragrafos em voz alta. Motores de servidor (Kokoro, Piper,
 * SaaS) baixam o audio trecho a trecho, com alguns a frente; a voz do sistema
 * fala direto pelo `speechSynthesis`.
 */
export class Speaker {
  private chunks: Chunk[] = [];
  private at = 0;
  private audio = new Audio();
  private url?: string;
  private abort = new AbortController();
  private stopped = false;
  private engine: TtsEngineId;
  paused = false;

  constructor(private readonly opts: SpeakerOptions) {
    this.engine = opts.engine;
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('error', () => {
      if (!this.stopped && this.audio.src) this.fail('o navegador nao conseguiu tocar o audio');
    });
  }

  get engineInUse(): TtsEngineId {
    return this.engine;
  }

  start(items: SpeechItem[]): void {
    this.chunks = items.flatMap((it) => splitForSpeech(it.text).map((text) => ({ index: it.index, text, lang: it.lang })));
    this.at = 0;
    if (!this.chunks.length) {
      this.opts.onEnd();
      return;
    }
    this.play();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.audio.pause();
    this.audio.removeAttribute('src');
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
    if (browserSpeechAvailable()) speechSynthesis.cancel();
  }

  pause(): void {
    this.paused = true;
    if (this.engine === 'browser') speechSynthesis.pause();
    else this.audio.pause();
  }

  resume(): void {
    this.paused = false;
    if (this.engine === 'browser') speechSynthesis.resume();
    else void this.audio.play().catch(() => undefined);
  }

  private fetchChunk(i: number): void {
    const c = this.chunks[i];
    if (!c || c.audio) return;
    c.audio = ttsSpeak({ engine: this.engine, text: c.text, voice: this.opts.voice || undefined, speed: this.opts.rate }, this.abort.signal);
    // rejeicao de prefetch so' importa quando o trecho chega a vez; sem isto vira "unhandled"
    c.audio.catch(() => undefined);
  }

  private play(): void {
    if (this.stopped) return;
    const c = this.chunks[this.at];
    if (!c) {
      this.opts.onEnd();
      return;
    }
    if (this.at === 0 || this.chunks[this.at - 1]?.index !== c.index) this.opts.onPara(c.index);
    if (this.engine === 'browser') this.speakBrowser(c);
    else void this.playServer();
  }

  private next(): void {
    if (this.stopped) return;
    this.at++;
    this.play();
  }

  private async playServer(): Promise<void> {
    for (let i = this.at; i <= this.at + PREFETCH; i++) this.fetchChunk(i);
    const c = this.chunks[this.at]!;
    let blob: Blob;
    try {
      blob = await c.audio!;
    } catch (err) {
      if (this.stopped) return;
      const msg = humanizeError(err);
      // motor fora do ar ou sem chave: a voz do sistema assume em vez de parar a leitura
      if (browserSpeechAvailable() && this.opts.onFallback) {
        this.engine = 'browser';
        this.opts.onFallback(msg);
        this.speakBrowser(c);
        return;
      }
      this.fail(msg);
      return;
    }
    if (this.stopped) return;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.audio.src = this.url;
    if (this.paused) return;
    try {
      await this.audio.play();
    } catch (err) {
      if (!this.stopped) this.fail(humanizeError(err));
    }
  }

  private speakBrowser(c: Chunk): void {
    if (!browserSpeechAvailable()) {
      this.fail('este navegador nao tem voz do sistema');
      return;
    }
    const u = new SpeechSynthesisUtterance(c.text);
    const lang = c.lang && c.lang !== 'unknown' ? c.lang : 'pt-BR';
    u.lang = lang;
    u.rate = this.opts.rate;
    const voices = systemVoices(lang);
    // a voz salva so' vale se for do mesmo idioma do trecho
    u.voice = voices.find((v) => v.voiceURI === this.opts.voice) ?? voices[0] ?? null;
    u.onend = () => this.next();
    u.onerror = (e) => {
      if (!this.stopped && e.error !== 'interrupted' && e.error !== 'canceled') this.fail(`voz do sistema falhou: ${e.error}`);
    };
    speechSynthesis.speak(u);
  }

  private fail(message: string): void {
    this.stop();
    this.opts.onError(message);
  }
}
