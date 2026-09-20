import { describe, expect, test } from 'bun:test';
import { scanText } from '../scripts/secret-scan.ts';

const rules = (text: string): string[] => scanText('x.ts', text).map((f) => f.rule);

describe('varredura de credencial', () => {
  test('pega as chaves que vazam na pratica', () => {
    expect(rules(`const k = "sk-or-v1-${'a1b2c3d4e5'.repeat(4)}";`)).toContain('chave OpenAI/OpenRouter');
    expect(rules(`ghp_${'A1b2C3d4E5'.repeat(4)}`)).toContain('token GitHub');
    expect(rules('AKIAIOSFODNN7EXAMPLE')).toContain('chave AWS');
    expect(rules(`AIza${'A1b2C3d4E5'.repeat(3)}abcde`)).toContain('chave Google');
    expect(rules('-----BEGIN RSA PRIVATE KEY-----')).toContain('chave privada');
    expect(rules('https://joao:senha123@interno.example.com/x')).toContain('credencial na URL');
  });

  test('placeholder de documentacao nao pode reprovar o build', () => {
    // o README e o campo da UI precisam mostrar o formato da chave
    expect(scanText('README.md', 'OPENROUTER_API_KEY=sk-or-v1-...')).toEqual([]);
    expect(scanText('.env.example', 'OPENROUTER_API_KEY=')).toEqual([]);
    expect(scanText('c.ts', "placeholder: 'sk-or-v1-...'")).toEqual([]);
  });

  test('chave lida do ambiente e do corpo da requisicao passa; literal no codigo nao', () => {
    expect(scanText('a.ts', "apiKey: env('OPENROUTER_API_KEY')")).toEqual([]);
    expect(scanText('a.ts', 'patch.apiKey = body.apiKey.trim();')).toEqual([]);
    expect(rules('const cfg = { apiKey: "wJalrXUtnFEMIK7MDENGbPxRfiCY" };')).toContain('segredo escrito no codigo');
  });

  test('credencial falsa de teste segue permitida, mas so por igualdade exata', () => {
    // `ALLOWED` por "contem" viraria porta dos fundos: bastaria colar a chave
    // de verdade ao lado da palavra permitida
    expect(scanText('t.ts', "apiKey: 'test-token'")).toEqual([]);
    expect(rules(`apiKey: 'test-token-${'Z9y8x7w6v5'.repeat(3)}'`)).toContain('segredo escrito no codigo');
  });

  test('caminho pessoal e dado pessoal; o redigido e o do runner nao sao', () => {
    expect(rules('C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'joao' + String.fromCharCode(92) + 'app')).toContain('caminho pessoal');
    expect(rules('/home/joao/app')).toContain('caminho pessoal');
    expect(scanText('log.txt', 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + '<usuario>' + String.fromCharCode(92) + 'app')).toEqual([]);
    expect(scanText('ci.yml', '/home/runner/work/repo')).toEqual([]);
  });

  test('o achado aponta a linha e nao imprime o segredo inteiro', () => {
    const chave = `sk-${'a1b2c3d4e5'.repeat(4)}`;
    const [found] = scanText('src/x.ts', `linha 1\nconst k = "${chave}";`);
    expect(found?.line).toBe(2);
    // vazar o segredo no log do CI seria trocar um vazamento por outro
    expect(found?.excerpt).not.toContain(chave);
    expect(found?.excerpt).toContain('43 chars');
  });
});
