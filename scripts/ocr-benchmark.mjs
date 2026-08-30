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
 */
import { createWorker } from 'tesseract.js';
import { readFile } from 'node:fs/promises';
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

async function runSet(label, dir, groundTruthFile, lang, psm, idFilter = () => true) {
  const gt = JSON.parse(await readFile(path.join(ROOT, groundTruthFile), 'utf8'));
  const worker = await createWorker(lang, 1, { logger: () => {} });
  await worker.setParameters({ tessedit_pageseg_mode: String(psm) });

  const rows = [];
  let totalCer = 0;
  let totalMs = 0;
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
    rows.push({ id, ref, hyp, cer: c, ms: Math.round(ms), confidence: Math.round(data.confidence ?? 0) });
  }
  await worker.terminate();

  console.log(`\n=== ${label} (${rows.length} itens) ===`);
  for (const r of rows) {
    console.log(
      `  [${r.id}] CER=${r.cer.toFixed(2)} conf=${r.confidence} ${r.ms}ms\n    ref: ${JSON.stringify(r.ref.slice(0, 60))}\n    hyp: ${JSON.stringify(r.hyp.slice(0, 60))}`,
    );
  }
  console.log(
    `  -> CER medio: ${(totalCer / rows.length).toFixed(3)} · latencia media: ${Math.round(totalMs / rows.length)}ms`,
  );
  return { label, meanCer: totalCer / rows.length, meanMs: totalMs / rows.length, rows };
}

const results = [];
results.push(await runSet('Tesseract.js — eng (PSM 6, config atual do app)', 'crops', 'ocr-ground-truth.json', 'eng', 6));
results.push(
  await runSet('Tesseract.js — jpn (PSM 6, so os horizontais)', 'crops-jp', 'ocr-ground-truth-jp.json', 'jpn', 6, (id) =>
    id.includes('horizontal'),
  ),
);
results.push(
  await runSet(
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
