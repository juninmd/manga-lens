/**
 * Varredura de credencial e dado pessoal nos arquivos versionados.
 *
 * Roda dentro do `bun run check`, entao um segredo colado por engano reprova
 * antes do commit — depois de entrar no historico, tirar exige reescrever o git
 * e rotacionar a chave assim mesmo.
 *
 * Uso: bun run scripts/secret-scan.ts [--all]
 *   sem flag  -> arquivos versionados como estao no disco
 *   --all     -> todo blob de todo commit, para auditar o passado (mais lento)
 */

export interface Finding {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

/**
 * Cada padrao exige tamanho minimo de corpo: e' o que separa a chave de verdade
 * do placeholder que a documentacao precisa mostrar ("sk-or-v1-..." nao casa).
 */
const RULES: { name: string; re: RegExp }[] = [
  { name: 'chave OpenAI/OpenRouter', re: /\bsk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9]{20,}\b/ },
  { name: 'token GitHub', re: /\b(?:gh[posur]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: 'chave AWS', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'chave Google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'token Slack', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'chave privada', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'credencial na URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"']+:[^\s/@"']+@/i },
  {
    name: 'segredo escrito no codigo',
    // so' casa literal entre aspas: `apiKey: process.env[...]` e `apiKey: body.apiKey` passam
    re: /\b(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|client[_-]?secret|password|passwd|secret)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
  { name: 'caminho pessoal', re: /(?:[A-Z]:\\Users\\|\/home\/|\/Users\/)(?!<)[A-Za-z0-9._-]{2,}[\\/]/ },
];

/**
 * Valores que PRECISAM aparecer: credencial falsa de teste, a chave literal que
 * o Ollama exige e os nomes genericos de runner. Comparado por igualdade ao
 * trecho casado, nunca por "contem" — senao vira porta dos fundos.
 */
const ALLOWED = new Set(['test-token', 'ollama', '/home/runner/', '/Users/runner/']);

const SKIP_FILE =
  /(?:^|\/)(?:bun\.lock|Cargo\.lock|package-lock\.json|tests\/secret-scan\.test\.ts)$|\.(?:png|jpe?g|webp|gif|bmp|avif|ico|pdf|epub|cbz|cbr|zip|traineddata|onnx|wasm|woff2?)$/i;

/** Mostra o suficiente para achar a linha, nunca o segredo inteiro. */
const mask = (hit: string): string =>
  hit.length <= 12 ? hit : `${hit.slice(0, 6)}...${hit.slice(-2)} (${hit.length} chars)`;

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of RULES) {
      const hit = rule.re.exec(line)?.[0];
      if (!hit || ALLOWED.has(hit)) continue;
      out.push({ file, line: i + 1, rule: rule.name, excerpt: mask(hit) });
    }
  });
  return out;
}

const run = async (cmd: string[]): Promise<string> => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`falhou: ${cmd.join(' ')}`);
  return text;
};

const lines = (text: string): string[] => text.split('\n').filter(Boolean);
const isBinary = (buf: Uint8Array): boolean => buf.subarray(0, 8000).includes(0);

/** Arquivos versionados como estao AGORA: o portao precisa reprovar antes do commit. */
async function scanWorktree(): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const file of lines(await run(['git', 'ls-files']))) {
    if (SKIP_FILE.test(file)) continue;
    const bytes = await Bun.file(file)
      .bytes()
      .catch(() => null);
    if (!bytes || isBinary(bytes)) continue;
    findings.push(...scanText(file, Buffer.from(bytes).toString('utf8')));
  }
  return findings;
}

/** Auditoria do passado: segredo apagado depois continua no historico. */
async function scanHistory(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const rev of lines(await run(['git', 'rev-list', '--all']))) {
    for (const file of lines(await run(['git', 'ls-tree', '-r', '--name-only', rev]))) {
      if (SKIP_FILE.test(file)) continue;
      // o mesmo conteudo se repete em dezenas de commits: agrupa pelo hash do blob
      const sha = (await run(['git', 'rev-parse', `${rev}:${file}`])).trim();
      if (seen.has(sha)) continue;
      seen.add(sha);
      const blob = Buffer.from(await run(['git', 'cat-file', 'blob', sha]), 'utf8');
      if (isBinary(blob)) continue;
      findings.push(...scanText(`${rev.slice(0, 8)}:${file}`, blob.toString('utf8')));
    }
  }
  return findings;
}

if (import.meta.main) {
  const all = process.argv.includes('--all');
  const escopo = all ? 'em todo o historico' : 'nos arquivos versionados';
  const findings = all ? await scanHistory() : await scanWorktree();
  if (!findings.length) {
    console.log(`nenhuma credencial ou dado pessoal ${escopo}`);
    process.exit(0);
  }
  for (const f of findings) console.error(`${f.file}:${f.line}  ${f.rule}: ${f.excerpt}`);
  console.error(`\n${findings.length} achado(s) ${escopo}`);
  process.exit(1);
}
