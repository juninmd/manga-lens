/**
 * Spike de benchmark (issue #5): mede o motor de OCR atual do app (Tesseract.js)
 * contra alternativas mais pesadas, nas mesmas imagens de teste, para decidir se
 * compensa perseguir integracao. Nao faz parte do bundle/produto — script solto,
 * roda fora do client. Ve tambem `scripts/ocr-benchmark-manga-ocr.py`.
 *
 * Uso: node scripts/ocr-benchmark.mjs
 * Le `.workflow/5-competitive-quality/ocr-ground-truth.json` + `crops/*.png`
 * (ingles, paginas reais) e `ocr-ground-truth-jp.json` + `crops-jp/*.png`
 * (japones, sintetico — Tesseract e' o unico motor deste script que le japones).
 *
 * `--gate`: compara com `ocr-gates.json` (teto de CER e piso de acerto exato por
 * conjunto) e sai com codigo 1 se algum piorou. E' o "criterio de promocao" do
 * FrankYomik: troca de motor, de PSM ou de pre-processamento so' entra se nao
 * regride nenhum conjunto. `--json <arquivo>` grava as linhas para comparar depois.
 */
import { createWorker } from 'tesseract.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '.workflow', '5-competitive-quality');

/** Distancia de Levenshtein a nivel de caractere, para CER (character error rate). */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

const norm = (s) => s.trim().replace(/\s+/g, ' ').toUpperCase();

function cer(hyp, ref) {
  const a = norm(hyp);
  const b = norm(ref);
  if (b.length === 0) return a.length === 0 ? 0 : 1;
  return levenshtein(a, b) / b.length;
}

async function runSet(key, label, dir, groundTruthFile, lang, psm, idFilter = () => true) {
  const gt = JSON.parse(await readFile(path.join(ROOT, groundTruthFile), 'utf8'));
  const worker = await createWorker(lang, 1, { logger: () => {} });
  await worker.setParameters({ tessedit_pageseg_mode: String(psm) });

  const rows = [];
  let totalCer = 0;
  let totalMs = 0;
  let exact = 0;
  for (const [id, ref] of Object.entries(gt.items).filter(([id]) => idFilter(id))) {
    const file = path.join(ROOT, dir, `${id}.png`);
    const buf = await readFile(file);
    const t0 = performance.now();
    const { data } = await worker.recognize(buf);
    const ms = performance.now() - t0;
    const hyp = (data.text ?? '').trim();
    const c = cer(hyp, ref);
    totalCer += c;
    totalMs += ms;
    if (norm(hyp) === norm(ref)) exact++;
    rows.push({ id, ref, hyp, cer: c, ms: Math.round(ms), confidence: Math.round(data.confidence ?? 0) });
  }
  await worker.terminate();

  console.log(`\n=== ${label} (${rows.length} itens) ===`);
  for (const r of rows) {
    console.log(
      `  [${r.id}] CER=${r.cer.toFixed(2)} conf=${r.confidence} ${r.ms}ms\n    ref: ${JSON.stringify(r.ref.slice(0, 60))}\n    hyp: ${JSON.stringify(r.hyp.slice(0, 60))}`,
    );
  }
  const exactRate = exact / Math.max(rows.length, 1);
  console.log(
    `  -> CER medio: ${(totalCer / rows.length).toFixed(3)} · acerto exato: ${(exactRate * 100).toFixed(0)}% · latencia media: ${Math.round(totalMs / rows.length)}ms`,
  );
  return { label, key, meanCer: totalCer / rows.length, exactRate, meanMs: totalMs / rows.length, rows };
}

const results = [];
results.push(await runSet('eng', 'Tesseract.js — eng (PSM 6, config atual do app)', 'crops', 'ocr-ground-truth.json', 'eng', 6));
results.push(
  await runSet('jpn', 'Tesseract.js — jpn (PSM 6, so os horizontais)', 'crops-jp', 'ocr-ground-truth-jp.json', 'jpn', 6, (id) =>
    id.includes('horizontal'),
  ),
);
results.push(
  await runSet(
    'jpn_vert',
    'Tesseract.js — jpn_vert (PSM 5, so os verticais)',
    'crops-jp',
    'ocr-ground-truth-jp.json',
    'jpn_vert',
    5,
    (id) => id.includes('vertical'),
  ),
);

console.log('\n=== Resumo ===');
for (const r of results) console.log(`  ${r.label}: CER medio ${r.meanCer.toFixed(3)}, ${Math.round(r.meanMs)}ms/item`);

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
if (jsonAt >= 0 && args[jsonAt + 1]) {
  await writeFile(args[jsonAt + 1], JSON.stringify(results, null, 2));
  console.log(`\nlinhas gravadas em ${args[jsonAt + 1]}`);
}
if (args.includes('--gate')) {
  const gates = JSON.parse(await readFile(path.join(ROOT, 'ocr-gates.json'), 'utf8'));
  const failures = [];
  for (const r of results) {
    const g = gates[r.key];
    if (!g) continue;
    if (r.meanCer > g.maxCer) failures.push(`${r.key}: CER ${r.meanCer.toFixed(3)} > teto ${g.maxCer}`);
    if (r.exactRate < g.minExact) failures.push(`${r.key}: acerto exato ${(r.exactRate * 100).toFixed(0)}% < piso ${g.minExact * 100}%`);
  }
  console.log(failures.length ? `\n=== Gate: REPROVADO ===\n  ${failures.join('\n  ')}` : '\n=== Gate: aprovado ===');
  if (failures.length) process.exit(1);
}
