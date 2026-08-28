import { describe, expect, test } from 'bun:test';
import { cleanOcrText, isOcrNoise } from '../src/client/ocr.ts';
import { isNoise } from '../src/server/translators.ts';

describe('OCR text cleaner and noise detection', () => {
  test('cleanOcrText strips stray border artifacts and whitespace', () => {
    expect(cleanOcrText('| HELLO WORLD |')).toBe('HELLO WORLD');
    expect(cleanOcrText('~--- SOME TEXT ---~')).toBe('SOME TEXT');
    expect(cleanOcrText(' "HELLO" ')).toBe('HELLO');
    expect(cleanOcrText('LINE 1\n\n\nLINE 2')).toBe('LINE 1\nLINE 2');
  });

  test('isOcrNoise identifies artifacts and non-words', () => {
    // Noise symbols and screentones
    expect(isOcrNoise('||||', 90)).toBe(true);
    expect(isOcrNoise('.....', 90)).toBe(true);
    expect(isOcrNoise('~^~^~', 90)).toBe(true);
    expect(isOcrNoise('_--_', 80)).toBe(true);
    expect(isOcrNoise('1234', 80)).toBe(true);
    expect(isOcrNoise('x', 70)).toBe(true);
    expect(isOcrNoise('|| a ||', 80)).toBe(true);

    // Low confidence
    expect(isOcrNoise('SHORT', 20)).toBe(true);
    expect(isOcrNoise('ABC', 30)).toBe(true);

    // Legitimate speech bubble text
    expect(isOcrNoise('HELLO WORLD', 85)).toBe(false);
    expect(isOcrNoise('O que aconteceu aqui?', 75)).toBe(false);
    expect(isOcrNoise('NARUTO!', 80)).toBe(false);
    expect(isOcrNoise('こんにちは', 80)).toBe(false);
  });

  test('server-side isNoise matches noise patterns', () => {
    expect(isNoise('|| ~~ 4 @')).toBe(true);
    expect(isNoise('....')).toBe(true);
    expect(isNoise('123')).toBe(true);
    expect(isNoise('A')).toBe(true);
    expect(isNoise('HELLO')).toBe(false);
    expect(isNoise('Ola, tudo bem?')).toBe(false);
  });
});
