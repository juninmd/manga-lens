import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

/**
 * Leitura em voz alta do leitor de livro. Os motores locais vem primeiro e sao o
 * padrao: Kokoro (Kokoro-FastAPI, rota `/v1/audio/speech` no formato da OpenAI) e
 * Piper (servidor HTTP do proprio Piper). Os SaaS ficam como opcao, cada um com a
 * sua chave. `browser` e' a voz do sistema (Web Speech API): roda no cliente e
 * nao passa por aqui, mas aparece na lista para o seletor ficar num lugar so'.
 */
export type TtsEngine = 'kokoro' | 'piper' | 'browser' | 'openai' | 'elevenlabs' | 'azure' | 'google';

export const TTS_ENGINES: TtsEngine[] = ['kokoro', 'piper', 'browser', 'openai', 'elevenlabs', 'azure', 'google'];

export interface TtsEngineConfig {
  /** URL do servidor local (Kokoro/Piper) ou base da API (OpenAI compativel) */
  baseUrl: string;
  apiKey: string;
  voice: string;
  model: string;
  /** Azure: regiao do recurso (brazilsouth, eastus...) */
  region: string;
}

interface EngineMeta {
  name: string;
  local: boolean;
  needsKey: boolean;
  /** vozes PT-BR conhecidas — o campo aceita qualquer id, isto e' so' sugestao */
  voices: { id: string; name: string }[];
  defaults: TtsEngineConfig;
}

const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const blank: TtsEngineConfig = { baseUrl: '', apiKey: '', voice: '', model: '', region: '' };

export const ENGINE_META: Record<TtsEngine, EngineMeta> = {
  kokoro: {
    name: 'Kokoro (local)',
    local: true,
    needsKey: false,
    voices: [
      { id: 'pf_dora', name: 'Dora (feminina)' },
      { id: 'pm_alex', name: 'Alex (masculina)' },
      { id: 'pm_santa', name: 'Santa (masculina)' },
    ],
    defaults: { ...blank, baseUrl: env('KOKORO_BASE_URL', 'http://127.0.0.1:8880/v1'), voice: env('KOKORO_VOICE', 'pf_dora'), model: 'kokoro' },
  },
  piper: {
    name: 'Piper (local)',
    local: true,
    needsKey: false,
    voices: [
      { id: 'pt_BR-faber-medium', name: 'Faber (masculina)' },
      { id: 'pt_BR-cadu-medium', name: 'Cadu (masculina)' },
      { id: 'pt_BR-jeff-medium', name: 'Jeff (masculina)' },
    ],
    defaults: { ...blank, baseUrl: env('PIPER_BASE_URL', 'http://127.0.0.1:5000'), voice: env('PIPER_VOICE', 'pt_BR-faber-medium') },
  },
  browser: {
    name: 'Voz do sistema (navegador)',
    local: true,
    needsKey: false,
    voices: [],
    defaults: { ...blank },
  },
  openai: {
    name: 'OpenAI TTS',
    local: false,
    needsKey: true,
    voices: ['nova', 'alloy', 'coral', 'echo', 'fable', 'onyx', 'sage', 'shimmer'].map((id) => ({ id, name: id })),
    defaults: {
      ...blank,
      baseUrl: env('OPENAI_TTS_BASE_URL', 'https://api.openai.com/v1'),
      apiKey: env('OPENAI_TTS_API_KEY'),
      voice: env('OPENAI_TTS_VOICE', 'nova'),
      model: env('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'),
    },
  },
  elevenlabs: {
    name: 'ElevenLabs',
    local: false,
    needsKey: true,
    // id de voz da biblioteca publica; o modelo multilingue fala PT-BR com qualquer uma
    voices: [
      { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
      { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' },
      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
    ],
    defaults: {
      ...blank,
      baseUrl: 'https://api.elevenlabs.io/v1',
      apiKey: env('ELEVENLABS_API_KEY'),
      voice: env('ELEVENLABS_VOICE', '21m00Tcm4TlvDq8ikWAM'),
      model: env('ELEVENLABS_MODEL', 'eleven_multilingual_v2'),
    },
  },
  azure: {
    name: 'Azure Speech',
    local: false,
    needsKey: true,
    voices: [
      { id: 'pt-BR-FranciscaNeural', name: 'Francisca (feminina)' },
      { id: 'pt-BR-AntonioNeural', name: 'Antonio (masculina)' },
      { id: 'pt-BR-ThalitaMultilingualNeural', name: 'Thalita (feminina)' },
    ],
    defaults: {
      ...blank,
      apiKey: env('AZURE_SPEECH_KEY'),
      region: env('AZURE_SPEECH_REGION', 'brazilsouth'),
      voice: env('AZURE_SPEECH_VOICE', 'pt-BR-FranciscaNeural'),
    },
  },
  google: {
    name: 'Google Cloud TTS',
    local: false,
    needsKey: true,
    voices: [
      { id: 'pt-BR-Neural2-A', name: 'Neural2 A (feminina)' },
      { id: 'pt-BR-Neural2-B', name: 'Neural2 B (masculina)' },
      { id: 'pt-BR-Neural2-C', name: 'Neural2 C (feminina)' },
      { id: 'pt-BR-Wavenet-A', name: 'Wavenet A (feminina)' },
    ],
    defaults: { ...blank, apiKey: env('GOOGLE_TTS_API_KEY'), voice: env('GOOGLE_TTS_VOICE', 'pt-BR-Neural2-A') },
  },
};

/** Configuracao viva de cada motor; o painel grava em `.cache/tts-config.json`. */
export const ttsConfig: Record<TtsEngine, TtsEngineConfig> = Object.fromEntries(
  TTS_ENGINES.map((e) => [e, { ...ENGINE_META[e].defaults }]),
) as Record<TtsEngine, TtsEngineConfig>;

export const isTtsEngine = (v: unknown): v is TtsEngine => typeof v === 'string' && (TTS_ENGINES as string[]).includes(v);

/** Teto por requisicao: o cliente fatia o paragrafo em frases antes; isto so' barra abuso. */
export const MAX_TTS_CHARS = 4000;
const FIELDS: (keyof TtsEngineConfig)[] = ['baseUrl', 'apiKey', 'voice', 'model', 'region'];
const configPath = (): string => join(config.cacheDir, 'tts-config.json');

export function loadTtsConfig(): void {
  for (const e of TTS_ENGINES) ttsConfig[e] = { ...ENGINE_META[e].defaults };
  try {
    if (!existsSync(configPath())) return;
    const data = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, Partial<TtsEngineConfig>>;
    for (const e of TTS_ENGINES) if (data[e]) applyTtsPatch(e, data[e], false);
  } catch {}
}

function saveTtsConfig(): void {
  try {
    mkdirSync(config.cacheDir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(ttsConfig, null, 2), 'utf-8');
  } catch (err) {
    console.error('[tts] erro ao salvar tts-config.json:', err);
  }
}

/** So' campos conhecidos e texto curto: o corpo vem da rede. */
export function applyTtsPatch(engine: TtsEngine, patch: Partial<Record<keyof TtsEngineConfig, unknown>>, persist = true): void {
  for (const f of FIELDS) {
    const v = patch[f];
    if (typeof v !== 'string') continue;
    const clean = v.trim().slice(0, 500);
    if (f === 'baseUrl' && clean && !/^https?:\/\//i.test(clean)) throw new Error('baseUrl precisa comecar com http:// ou https://');
    ttsConfig[engine][f] = f === 'baseUrl' ? clean.replace(/\/+$/, '') : clean;
  }
  if (persist) saveTtsConfig();
}

/** Lista para o painel. A chave nunca volta: so' se ha' uma. */
export function ttsEngines(): {
  id: TtsEngine;
  name: string;
  local: boolean;
  needsKey: boolean;
  hasKey: boolean;
  ready: boolean;
  voices: { id: string; name: string }[];
  baseUrl: string;
  voice: string;
  model: string;
  region: string;
}[] {
  return TTS_ENGINES.map((id) => {
    const m = ENGINE_META[id];
    const c = ttsConfig[id];
    return {
      id,
      name: m.name,
      local: m.local,
      needsKey: m.needsKey,
      hasKey: Boolean(c.apiKey),
      ready: !m.needsKey || Boolean(c.apiKey),
      voices: m.voices,
      baseUrl: c.baseUrl,
      voice: c.voice,
      model: c.model,
      region: c.region,
    };
  });
}

const escapeXml = (s: string): string =>
  s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!);

/** 1.0 = normal; os motores aceitam faixas diferentes, todo mundo fica em 0.5–2. */
const clampSpeed = (s: unknown): number => {
  const n = typeof s === 'number' && Number.isFinite(s) ? s : 1;
  return Math.min(2, Math.max(0.5, n));
};

export interface SpeakRequest {
  engine: TtsEngine;
  text: string;
  voice?: string;
  speed?: number;
}

export interface SpeakResult {
  audio: ArrayBuffer;
  type: string;
}

async function ok(res: Response, engine: string): Promise<Response> {
  if (res.ok) return res;
  const body = (await res.text().catch(() => '')).slice(0, 200);
  const hint = res.status === 401 || res.status === 403 ? ' (chave invalida?)' : '';
  throw new Error(`${ENGINE_META[engine as TtsEngine]?.name ?? engine} respondeu ${res.status}${hint}${body ? `: ${body}` : ''}`);
}

const audioOf = async (res: Response, fallbackType: string): Promise<SpeakResult> => ({
  audio: await res.arrayBuffer(),
  type: res.headers.get('content-type')?.split(';')[0] || fallbackType,
});

/** Sintetiza um trecho no motor escolhido e devolve o audio (mp3 ou wav). */
export async function speak(req: SpeakRequest): Promise<SpeakResult> {
  const { engine } = req;
  const c = ttsConfig[engine];
  const voice = (req.voice?.trim() || c.voice).slice(0, 120);
  const speed = clampSpeed(req.speed);
  const text = req.text;
  const signal = AbortSignal.timeout(60_000);
  if (ENGINE_META[engine].needsKey && !c.apiKey) throw new Error(`${ENGINE_META[engine].name}: configure a chave de API`);

  switch (engine) {
    case 'browser':
      throw new Error('a voz do sistema roda no navegador');
    case 'kokoro':
    case 'openai': {
      // Kokoro-FastAPI fala o mesmo dialeto da OpenAI
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
      const body: Record<string, unknown> = { model: c.model || 'kokoro', input: text, voice, speed, response_format: 'mp3' };
      if (engine === 'kokoro') body.lang_code = 'p';
      const res = await fetch(`${c.baseUrl}/audio/speech`, { method: 'POST', headers, body: JSON.stringify(body), signal });
      return audioOf(await ok(res, engine), 'audio/mpeg');
    }
    case 'piper': {
      // servidor HTTP do Piper: POST com JSON, devolve WAV
      const res = await fetch(`${c.baseUrl}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, length_scale: 1 / speed }),
        signal,
      });
      return audioOf(await ok(res, engine), 'audio/wav');
    }
    case 'elevenlabs': {
      const res = await fetch(`${c.baseUrl || 'https://api.elevenlabs.io/v1'}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': c.apiKey, Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: c.model || 'eleven_multilingual_v2', language_code: 'pt', voice_settings: { speed: Math.min(1.2, Math.max(0.7, speed)) } }),
        signal,
      });
      return audioOf(await ok(res, engine), 'audio/mpeg');
    }
    case 'azure': {
      if (!/^[a-z0-9-]+$/i.test(c.region)) throw new Error('Azure Speech: regiao invalida');
      const rate = `${Math.round((speed - 1) * 100)}%`;
      const ssml = `<speak version="1.0" xml:lang="pt-BR"><voice name="${escapeXml(voice)}"><prosody rate="${rate}">${escapeXml(text)}</prosody></voice></speak>`;
      const res = await fetch(`https://${c.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': c.apiKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'manga-lens',
        },
        body: ssml,
        signal,
      });
      return audioOf(await ok(res, engine), 'audio/mpeg');
    }
    case 'google': {
      const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(c.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { text }, voice: { languageCode: 'pt-BR', name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: speed } }),
        signal,
      });
      const data = (await (await ok(res, engine)).json()) as { audioContent?: string };
      if (!data.audioContent) throw new Error('Google Cloud TTS: resposta sem audio');
      const bytes = Buffer.from(data.audioContent, 'base64');
      return { audio: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, type: 'audio/mpeg' };
    }
  }
}

loadTtsConfig();
