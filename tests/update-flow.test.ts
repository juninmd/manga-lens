import { describe, expect, test } from 'bun:test';
import { DEFAULT_PREFS, fmtBytes, justUpdated, parsePrefs, plainNotes, progressOf, RETRY_AFTER_MS, shouldAutoInstall, statusText, type AutoInstallInput } from '../src/client/update-flow.ts';

const NOW = 1_800_000_000_000;
const base = (over: Partial<AutoInstallInput> = {}): AutoInstallInput => ({
  prefs: { check: true, install: true },
  canInstall: true,
  available: true,
  latest: '0.10.0',
  tried: null,
  now: NOW,
  ...over,
});

describe('quando o app se atualiza sozinho', () => {
  test('desktop, versao nova, preferencias ligadas', () => {
    expect(shouldAutoInstall(base())).toBe(true);
  });

  test('cada condicao ausente impede', () => {
    expect(shouldAutoInstall(base({ canInstall: false }))).toBe(false);
    expect(shouldAutoInstall(base({ available: false }))).toBe(false);
    expect(shouldAutoInstall(base({ latest: null }))).toBe(false);
    expect(shouldAutoInstall(base({ prefs: { check: true, install: false } }))).toBe(false);
    // sem verificar nao ha' o que instalar, mesmo com "instalar sozinho" ligado
    expect(shouldAutoInstall(base({ prefs: { check: false, install: true } }))).toBe(false);
  });

  test('instalador que falhou nao vira laco: so tenta a mesma versao de novo depois de um dia', () => {
    expect(shouldAutoInstall(base({ tried: { version: '0.10.0', at: NOW - 60_000 } }))).toBe(false);
    expect(shouldAutoInstall(base({ tried: { version: '0.10.0', at: NOW - RETRY_AFTER_MS + 1 } }))).toBe(false);
    expect(shouldAutoInstall(base({ tried: { version: '0.10.0', at: NOW - RETRY_AFTER_MS } }))).toBe(true);
    // versao diferente da que falhou: tenta
    expect(shouldAutoInstall(base({ tried: { version: '0.9.0', at: NOW - 1000 } }))).toBe(true);
  });
});

describe('preferencias guardadas', () => {
  test('padrao: verifica e instala sozinho', () => {
    expect(DEFAULT_PREFS).toEqual({ check: true, install: true });
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
  });

  test('valor ausente, lixo ou de tipo errado volta ao padrao campo a campo', () => {
    expect(parsePrefs('{"install":false}')).toEqual({ check: true, install: false });
    expect(parsePrefs('{"check":"nao","install":0}')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{nao e json')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('null')).toEqual(DEFAULT_PREFS);
  });
});

describe('acabou de atualizar', () => {
  test('so quando a versao em execucao e mais nova que a da ultima abertura', () => {
    expect(justUpdated('0.9.0', '0.10.0')).toEqual({ from: '0.9.0', to: '0.10.0' });
    // 0.10 > 0.9: compara por numero, nao por texto
    expect(justUpdated('0.9.0', '0.9.1')).toEqual({ from: '0.9.0', to: '0.9.1' });
  });

  test('primeira abertura, mesma versao, volta de versao ou build de desenvolvimento nao anunciam', () => {
    expect(justUpdated(null, '0.9.0')).toBeNull();
    expect(justUpdated('0.9.0', '0.9.0')).toBeNull();
    expect(justUpdated('0.10.0', '0.9.0')).toBeNull();
    expect(justUpdated('0.9.0', 'dev')).toBeNull();
    expect(justUpdated('dev', '0.9.0')).toBeNull();
  });
});

describe('o que a tela mostra', () => {
  test('tamanhos legiveis', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2 KB');
    expect(fmtBytes(37_955_988)).toBe('36,2 MB');
    expect(fmtBytes(-1)).toBe('—');
    expect(fmtBytes(Number.NaN)).toBe('—');
  });

  test('barra: fracao enquanto baixa, cheia depois, indeterminada sem tamanho', () => {
    const s = (over: Record<string, unknown>) => ({ phase: 'downloading' as const, received: 0, total: 0, error: null, ...over });
    expect(progressOf(s({ received: 25, total: 100 }))).toBe(0.25);
    expect(progressOf(s({ received: 500, total: 100 }))).toBe(1);
    expect(progressOf(s({ received: 10, total: 0 }))).toBeNull();
    expect(progressOf(s({ phase: 'verifying' }))).toBe(1);
    expect(progressOf(s({ phase: 'ready' }))).toBe(1);
    expect(progressOf(s({ phase: 'idle' }))).toBeNull();
  });

  test('cada etapa diz o que esta acontecendo', () => {
    const s = (over: Record<string, unknown>) => ({ phase: 'downloading' as const, received: 0, total: 0, error: null, ...over });
    expect(statusText(s({ received: 12_000_000, total: 36_000_000 }), '0.10.0')).toBe('Baixando a v0.10.0… 11,4 MB de 34,3 MB (33%)');
    expect(statusText(s({ received: 3000 }), '0.10.0')).toContain('Baixando a v0.10.0…');
    expect(statusText(s({ phase: 'verifying' }), '0.10.0')).toContain('SHA-256');
    expect(statusText(s({ phase: 'ready' }), '0.10.0')).toContain('reabre sozinho');
    expect(statusText(s({ phase: 'error', error: 'o hash nao confere' }), '0.10.0')).toBe('o hash nao confere');
  });
});

describe('notas da release como texto de tela', () => {
  test('titulos, listas e destaques do markdown da release viram texto limpo', () => {
    const md = '### Novidades\n- **fontes**: catalogos OPDS e `PDF` (#42)\n- [link](http://x.test) aqui\n\n\n\n### Correcoes\n* um conserto';
    expect(plainNotes(md)).toBe('NOVIDADES\n• fontes: catalogos OPDS e PDF (#42)\n• link aqui\n\nCORRECOES\n• um conserto');
  });

  test('texto sem marcacao passa intacto; CRLF vira LF', () => {
    expect(plainNotes('so um paragrafo')).toBe('so um paragrafo');
    expect(plainNotes('a\r\nb')).toBe('a\nb');
    expect(plainNotes('')).toBe('');
  });
});
