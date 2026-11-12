/**
 * Confere se os commits do PR seguem o Conventional Commits, que e' o que o
 * release.yml le para decidir a versao. Um assunto fora do padrao ainda publica
 * (vira patch), mas some das notas em "Novidades/Correcoes" — entao o PR avisa.
 *
 *   bun run scripts/check-commits.ts [base]      # base padrao: origin/main
 */
import { CONVENTIONAL, isMerge } from './release-notes.ts';

export const TYPES = ['feat', 'fix', 'perf', 'refactor', 'chore', 'build', 'ci', 'test', 'docs', 'style', 'revert'];

/** null quando o assunto esta' bom; senao o motivo. */
export function problemWith(subject: string): string | null {
  const s = subject.trim();
  if (isMerge(s) || /^Revert "/.test(s)) return null;
  const m = CONVENTIONAL.exec(s);
  if (!m) return 'use `tipo(escopo): descricao` — ex. `feat(leitor): modo lupa`';
  if (!TYPES.includes(m.groups!['type']!.toLowerCase())) return `tipo "${m.groups!['type']}" desconhecido (${TYPES.join(', ')})`;
  if (s.length > 100) return 'assunto com mais de 100 caracteres';
  return null;
}

if (import.meta.main) {
  const base = process.argv[2] ?? 'origin/main';
  const proc = Bun.spawn(['git', 'log', `${base}..HEAD`, '--format=%h %s'], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    console.error(`nao consegui ler os commits desde ${base}`);
    process.exit(1);
  }
  // squash merge usa o titulo do PR como commit: ele tambem precisa estar no padrao
  const title = process.env['PR_TITLE'];
  const subjects = [
    ...(title ? [{ sha: 'titulo', subject: title }] : []),
    ...out
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ sha: line.slice(0, 7), subject: line.slice(8) })),
  ];
  const bad = subjects.map((c) => ({ ...c, why: problemWith(c.subject) })).filter((c) => c.why);
  for (const c of bad) console.error(`${c.sha} "${c.subject}" -> ${c.why}`);
  if (bad.length) process.exit(1);
  console.log('commits no padrao Conventional Commits');
}
