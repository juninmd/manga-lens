/**
 * Proxima versao e notas a partir dos commits desde a ultima tag.
 *
 * A regra e' a do Conventional Commits, que o AGENTS.md ja' exige: `feat:` sobe
 * a minor, `fix:` sobe a patch, `!` ou `BREAKING CHANGE` sobe a major. Qualquer
 * outro assunto conta como patch — um push na principal sempre vira release, que
 * e' o combinado; release vazia so' acontece quando nao ha' commit nenhum.
 *
 * Fica como modulo, e nao inline no YAML, porque errar o calculo publica uma
 * versao que nao da' para despublicar — entao tem teste.
 */

export type Bump = 'major' | 'minor' | 'patch';

/** Assunto de commit ja' sem o corpo. */
export interface Commit {
  subject: string;
  body?: string;
}

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<desc>.+)$/i;

/** Merge do GitHub nao descreve mudanca nenhuma: quem descreve sao os commits dentro dele. */
const isMerge = (subject: string): boolean => /^Merge (pull request|branch|remote-tracking)\b/i.test(subject);

export function bumpOf(commits: Commit[]): Bump | null {
  const real = commits.filter((c) => !isMerge(c.subject));
  if (!real.length) return null;
  let bump: Bump = 'patch';
  for (const c of real) {
    const m = CONVENTIONAL.exec(c.subject.trim());
    const breaking = Boolean(m?.groups?.['breaking']) || /^BREAKING[ -]CHANGE:/m.test(c.body ?? '');
    if (breaking) return 'major';
    if (m?.groups?.['type']?.toLowerCase() === 'feat') bump = 'minor';
  }
  return bump;
}

export function nextVersion(current: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = current.replace(/^v/, '').split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const SECTIONS: { title: string; types: string[] }[] = [
  { title: 'Novidades', types: ['feat'] },
  { title: 'Correcoes', types: ['fix'] },
  { title: 'Desempenho', types: ['perf'] },
  { title: 'Por dentro', types: ['refactor', 'chore', 'build', 'ci', 'test', 'docs', 'style'] },
];

/** Notas em markdown, agrupadas pelo prefixo. O que nao segue o padrao vai em "Outros". */
export function releaseNotes(commits: Commit[]): string {
  const buckets = new Map<string, string[]>();
  for (const c of commits) {
    if (isMerge(c.subject)) continue;
    const m = CONVENTIONAL.exec(c.subject.trim());
    const type = m?.groups?.['type']?.toLowerCase() ?? '';
    const scope = m?.groups?.['scope'];
    const desc = m?.groups?.['desc'] ?? c.subject.trim();
    const title = SECTIONS.find((s) => s.types.includes(type))?.title ?? 'Outros';
    const line = `- ${scope ? `**${scope}**: ` : ''}${desc}`;
    buckets.set(title, [...(buckets.get(title) ?? []), line]);
  }
  const order = [...SECTIONS.map((s) => s.title), 'Outros'];
  return order
    .filter((t) => buckets.get(t)?.length)
    .map((t) => `### ${t}\n${buckets.get(t)!.join('\n')}`)
    .join('\n\n');
}

const run = async (cmd: string[]): Promise<string> => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`falhou: ${cmd.join(' ')}`);
  return text;
};

/** Ultima tag `vX.Y.Z` por ordem de versao, nao por data: tag antiga refeita nao pode mandar. */
async function lastTag(): Promise<string | null> {
  const tags = (await run(['git', 'tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*', '--sort=-v:refname']))
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
  return tags[0] ?? null;
}

if (import.meta.main) {
  const from = await lastTag();
  const range = from ? `${from}..HEAD` : 'HEAD';
  // \x1f separa assunto de corpo e \x1e separa commits: nenhum dos dois aparece
  // em mensagem de commit, ao contrario de qualquer texto que se invente
  const raw = await run(['git', 'log', range, '--format=%s%x1f%b%x1e']);
  const commits: Commit[] = raw
    .split('\x1e')
    .map((e) => e.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((e) => {
      const [subject = '', body = ''] = e.split('\x1f');
      return { subject: subject.trim(), body };
    })
    .filter((c) => c.subject);

  const bump = bumpOf(commits);
  const version = bump ? nextVersion(from ?? '0.0.0', bump) : null;
  const notes = bump ? releaseNotes(commits) : '';

  console.log(
    JSON.stringify(
      version
        ? { release: true, tag: `v${version}`, version, bump, previous: from, notes }
        : { release: false, reason: 'nenhum commit novo desde a ultima tag' },
      null,
      2,
    ),
  );

  // dentro do Actions o passo seguinte le por `steps.<id>.outputs.*`; as notas
  // sao multilinha e vao por arquivo, que nao precisa de escape nenhum
  const out = process.env['GITHUB_OUTPUT'];
  if (!out) process.exit(0);
  const lines = version ? [`release=true`, `tag=v${version}`, `version=${version}`] : ['release=false'];
  await Bun.write(out, (await Bun.file(out).text().catch(() => '')) + lines.join('\n') + '\n');
  if (version) await Bun.write('release-notes.md', notes);
}
