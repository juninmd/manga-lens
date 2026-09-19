import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('public', { recursive: true });

const result = await Bun.build({
  entrypoints: ['src/client/main.ts'],
  outdir: 'public',
  naming: '[dir]/app.[ext]',
  target: 'browser',
  minify: true,
  sourcemap: 'linked',
  define: { 'process.env.NODE_ENV': '"production"' },
});

// worker do detector de texto: bundle proprio, carregado por `new Worker('/detector-worker.js')`
const worker = await Bun.build({
  entrypoints: ['src/client/detector-worker.ts'],
  outdir: 'public',
  naming: '[dir]/detector-worker.[ext]',
  target: 'browser',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

for (const build of [result, worker]) {
  if (build.success) continue;
  for (const log of build.logs) console.error(log);
  process.exit(1);
}

await copyFile('src/client/index.html', 'public/index.html');
await copyFile('src/client/styles.css', 'public/styles.css');

// Worker/core do Tesseract entram no bundle: no app desktop nao existe node_modules.
await mkdir('public/vendor/tesseract', { recursive: true });
const vendor = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  // so' as variantes LSTM: o worker roda com OEM 1, as legacy nunca sao pedidas
  ...['lstm', 'simd-lstm'].flatMap((variant) => {
    const name = `tesseract-core-${variant}`;
    return [
      [`node_modules/tesseract.js-core/${name}.wasm.js`, `${name}.wasm.js`],
      [`node_modules/tesseract.js-core/${name}.wasm`, `${name}.wasm`],
    ];
  }),
] as [string, string][];

let copied = 0;
for (const [from, to] of vendor) {
  if (!(await Bun.file(from).exists())) continue;
  await copyFile(from, `public/vendor/tesseract/${to}`);
  copied++;
}

// Runtime WASM do onnxruntime (detector de texto): o loader ja' vem no bundle, so' o .wasm e' buscado
await mkdir('public/vendor/ort', { recursive: true });
await copyFile('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'public/vendor/ort/ort-wasm-simd-threaded.wasm');

console.log(`client compilado (${result.outputs.length} artefatos, ${copied} arquivos do tesseract, runtime ONNX)`);
