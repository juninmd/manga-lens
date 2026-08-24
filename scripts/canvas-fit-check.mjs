/**
 * Homologacao do letreiramento: prova, pixel a pixel, que a traducao fica DENTRO
 * do balao e ainda assim OCUPA o espaco dele.
 *
 * Nao depende de site externo nem de OCR: monta baloes sinteticos (elipses) com
 * a mesma estrutura de mascara que `detectBalloons` produz e mede o resultado.
 * Uso: node scripts/canvas-fit-check.mjs
 */
import { chromium } from 'playwright';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-fit-'));
const entry = join(dir, 'entry.js');
const bundle = join(dir, 'bundle.js');

await writeFile(
  entry,
  `import { paintPage } from ${JSON.stringify(resolve('src/client/ocr.ts'))};\nwindow.__paintPage = paintPage;\n`,
);

// o teste roda o mesmo `paintPage` do app, compilado do fonte — nada de copia
await promisify(execFile)('bun', ['build', entry, '--outfile', bundle, '--target', 'browser'], { shell: true });

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${name} — ${detail}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200));
});
await page.setContent('<canvas id="c"></canvas>');
await page.addScriptTag({ content: await readFile(bundle, 'utf8'), type: 'module' });
await page.waitForFunction(() => typeof window.__paintPage === 'function', { timeout: 15_000 });

/**
 * Cada caso e' um balao eliptico. `pt` e' o texto letreirado; o esperado e' que
 * nenhum pixel de tinta caia fora da elipse e que a mancha de texto encha o balao.
 */
const CASES = [
  { name: 'balao largo, frase curta', w: 320, h: 180, pt: 'ISSO NAO E O FIM DA LINHA' },
  { name: 'balao alto e estreito', w: 130, h: 300, pt: 'ele nunca soube o que aconteceu naquela noite' },
  { name: 'balao redondo, texto longo', w: 240, h: 240, pt: 'precisamos sair daqui antes que eles percebam que fugimos' },
  { name: 'balao pequeno', w: 90, h: 70, pt: 'corre!' },
  { name: 'palavra maior que o balao', w: 110, h: 90, pt: 'incompreensibilidades' },
];

const measured = await page.evaluate((cases) => {
  const out = [];
  for (const c of cases) {
    // mascara eliptica na escala reduzida da deteccao, como detectBalloons entrega
    const mw = Math.round(c.w / 2);
    const mh = Math.round(c.h / 2);
    const data = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const dx = (x - (mw - 1) / 2) / ((mw - 1) / 2);
        const dy = (y - (mh - 1) / 2) / ((mh - 1) / 2);
        if (dx * dx + dy * dy <= 1) data[y * mw + x] = 1;
      }
    }

    const pad = 20;
    const canvas = document.getElementById('c');
    const block = {
      id: 0,
      text: 'ORIGINAL',
      pt: c.pt,
      confidence: 90,
      x: pad,
      y: pad,
      w: c.w,
      h: c.h,
      mask: { w: mw, h: mh, data },
      bg: 'rgb(255, 255, 255)',
      fg: 'rgb(20, 20, 20)',
      upper: false,
    };
    window.__paintPage(canvas, [block], {
      showOriginal: false,
      font: 'sans',
      width: c.w + pad * 2,
      height: c.h + pad * 2,
    });

    const ctx = canvas.getContext('2d');
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let outside = 0;
    let inkX0 = Infinity;
    let inkY0 = Infinity;
    let inkX1 = -1;
    let inkY1 = -1;

    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const p = (y * canvas.width + x) * 4;
        if (px[p + 3] < 40) continue;
        const luma = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
        if (luma > 120) continue; // so' a tinta interessa; o balao e' branco
        if (x < inkX0) inkX0 = x;
        if (y < inkY0) inkY0 = y;
        if (x > inkX1) inkX1 = x;
        if (y > inkY1) inkY1 = y;
        // o pixel de tinta esta' dentro da elipse?
        const mx = Math.floor(((x - pad) / c.w) * mw);
        const my = Math.floor(((y - pad) / c.h) * mh);
        const inside = mx >= 0 && my >= 0 && mx < mw && my < mh && data[my * mw + mx] === 1;
        if (!inside) outside++;
      }
    }

    // "ocupar o balao" nao e' cobrir area: uma linha unica nunca cobre muito de um
    // balao alto. O que prova aproveitamento e' a mancha encostar em alguma parede.
    const usableW = c.w * 0.76;
    const usableH = c.h * 0.76;
    const inkW = inkX1 < 0 ? 0 : inkX1 - inkX0 + 1;
    const inkH = inkY1 < 0 ? 0 : inkY1 - inkY0 + 1;
    out.push({
      name: c.name,
      outside,
      inkW,
      inkH,
      usableW,
      usableH,
      fill: Math.max(inkW / usableW, inkH / usableH),
      painted: inkX1 >= 0,
    });
  }
  return out;
}, CASES);

for (const m of measured) {
  record(`${m.name}: texto dentro do balao`, m.painted && m.outside === 0, `${m.outside} px de tinta fora da elipse`);
  // letreirar minusculo dentro de um balao grande passaria no teste de vazamento
  // e ainda assim estaria errado: aqui cobra-se o aproveitamento do espaco
  record(
    `${m.name}: texto ocupa o balao`,
    m.fill >= 0.6,
    `mancha ${m.inkW}x${m.inkH} px em ${m.usableW.toFixed(0)}x${m.usableH.toFixed(0)} uteis (${(m.fill * 100).toFixed(0)}%)`,
  );
}

await browser.close();
const failures = results.filter((r) => !r.ok);
console.log(failures.length ? `\n${failures.length} verificacao(oes) falharam` : '\ntudo verde');
process.exit(failures.length ? 1 : 0);
