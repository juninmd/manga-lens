/** Isola a qualidade do OCR: baixa uma pagina real e roda tesseract fora da UI. */
import { createWorker } from 'tesseract.js';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 7788}`;
const pageIndex = Number(process.argv[2] ?? 7);

const pages = await fetch(`${BASE}/api/pages?provider=mangapill&chapter=3069-10001000/naruto-chapter-1`).then((r) =>
  r.json(),
);
const url = BASE + pages.pages[pageIndex].url;
const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
console.log(`pagina ${pageIndex}: ${(buf.length / 1024).toFixed(0)} KB`);

const worker = await createWorker('eng', 1, { logger: () => {} });
const { data } = await worker.recognize(buf, {}, { blocks: true, text: true });
const blocks = data.blocks ?? [];
const paragraphs = blocks.flatMap((b) => b.paragraphs ?? []);
console.log(`blocks=${blocks.length} paragraphs=${paragraphs.length} textoTotal=${(data.text ?? '').trim().length}`);
for (const p of paragraphs.slice(0, 12)) {
  console.log(`  conf=${Math.round(p.confidence)} bbox=${p.bbox.x1 - p.bbox.x0}x${p.bbox.y1 - p.bbox.y0} :: ${JSON.stringify((p.text ?? '').trim().slice(0, 70))}`);
}
await worker.terminate();
