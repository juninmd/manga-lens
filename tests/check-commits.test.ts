import { describe, expect, test } from 'bun:test';
import { problemWith } from '../scripts/check-commits.ts';

describe('assunto de commit', () => {
  test('aceita o padrao, com escopo e com !', () => {
    expect(problemWith('feat: leitor de livro')).toBeNull();
    expect(problemWith('fix(proxy): 403 na capa')).toBeNull();
    expect(problemWith('feat(api)!: remove /v1')).toBeNull();
  });
  test('recusa o que nao tem tipo ou tem tipo inventado', () => {
    expect(problemWith('ajusta botao')).not.toBeNull();
    expect(problemWith('feature: x')).not.toBeNull();
  });
  test('merge e revert do GitHub passam', () => {
    expect(problemWith('Merge pull request #1 from a/b')).toBeNull();
    expect(problemWith('Revert "feat: x"')).toBeNull();
  });
});
