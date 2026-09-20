import { describe, expect, test } from 'bun:test';
import { bumpOf, nextVersion, releaseNotes, type Commit } from '../scripts/release-notes.ts';

const c = (subject: string, body?: string): Commit => ({ subject, body });

describe('bump pela mensagem do commit', () => {
  test('feat sobe a minor, fix e o resto sobem a patch', () => {
    expect(bumpOf([c('feat: leitor de livro'), c('fix: proxy 403')])).toBe('minor');
    expect(bumpOf([c('fix: proxy 403')])).toBe('patch');
    // um push na principal sempre vira release: assunto fora do padrao nao pode
    // deixar a versao parada, senao a proxima release junta duas mudancas
    expect(bumpOf([c('ajusta texto do botao')])).toBe('patch');
  });

  test('quebra de contrato sobe a major, pelo ! ou pelo rodape', () => {
    expect(bumpOf([c('feat!: troca o formato do token de capitulo')])).toBe('major');
    expect(bumpOf([c('fix(api)!: remove /api/v1')])).toBe('major');
    expect(bumpOf([c('refactor: move o provider', 'BREAKING CHANGE: o id mudou')])).toBe('major');
    // major vence mesmo vindo depois de um feat
    expect(bumpOf([c('feat: x'), c('feat!: y')])).toBe('major');
  });

  test('merge do GitHub nao conta como mudanca', () => {
    // o merge repete o que os commits de dentro ja' dizem; contar os dois
    // subiria a versao duas vezes pelo mesmo trabalho
    expect(bumpOf([c('Merge pull request #11 from juninmd/feat/x')])).toBeNull();
    expect(bumpOf([c('Merge pull request #11 from juninmd/feat/x'), c('fix: y')])).toBe('patch');
  });

  test('sem commit novo nao ha release', () => {
    expect(bumpOf([])).toBeNull();
  });
});

describe('proxima versao', () => {
  test('zera o que esta a direita do que subiu', () => {
    expect(nextVersion('v0.4.0', 'minor')).toBe('0.5.0');
    expect(nextVersion('v0.4.7', 'patch')).toBe('0.4.8');
    expect(nextVersion('v0.4.7', 'minor')).toBe('0.5.0');
    expect(nextVersion('v1.2.3', 'major')).toBe('2.0.0');
  });

  test('repo sem tag nenhuma comeca do zero', () => {
    expect(nextVersion('0.0.0', 'minor')).toBe('0.1.0');
    expect(nextVersion('0.0.0', 'patch')).toBe('0.0.1');
  });
});

describe('notas da release', () => {
  test('agrupa por prefixo e mostra o escopo', () => {
    const notes = releaseNotes([
      c('feat(leitor): barra de progresso'),
      c('fix: proxy 403 na pagina de HQ'),
      c('chore: troca oxlint por biome'),
      c('Merge pull request #11 from juninmd/feat/x'),
      c('mexe no css sem prefixo'),
    ]);
    expect(notes).toContain('### Novidades\n- **leitor**: barra de progresso');
    expect(notes).toContain('### Correcoes\n- proxy 403 na pagina de HQ');
    expect(notes).toContain('### Por dentro\n- troca oxlint por biome');
    expect(notes).toContain('### Outros\n- mexe no css sem prefixo');
    // o merge nao descreve nada: repetir na nota so' polui
    expect(notes).not.toContain('Merge pull request');
  });

  test('secao sem item nao aparece', () => {
    const notes = releaseNotes([c('fix: so isso')]);
    expect(notes).toBe('### Correcoes\n- so isso');
  });
});
