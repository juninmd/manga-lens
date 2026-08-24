/** Monta uma biblioteca local de teste (CBZ + pasta de imagens) para exercitar o provider local. */
import { chromium } from 'playwright';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'D:/Solutions/pessoal/manga-lens/.testlib');
await rm(root, { recursive: true, force: true });
const pagesDir = join(root, '.pages');
await mkdir(pagesDir, { recursive: true });
await mkdir(join(root, 'HQ Solta', 'Capitulo 01'), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 1200 } });
const texts = ['PAGINA UM', 'PAGINA DOIS', 'PAGINA TRES'];
for (const [i, text] of texts.entries()) {
  await page.setContent(
    `<div style="width:800px;height:1200px;background:#fff;display:grid;place-items:center;
       font:700 90px system-ui">${text}</div>`,
  );
  const buf = await page.screenshot();
  const name = `${String(i + 1).padStart(3, '0')}.png`;
  await writeFile(join(pagesDir, name), buf);
  if (i < 2) await writeFile(join(root, 'HQ Solta', 'Capitulo 01', name), buf);
}
await browser.close();

// Compress-Archive gera zip deflate padrao — e' o que o leitor de CBZ precisa ler
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${pagesDir}\\*' -DestinationPath '${root}\\Manga Teste.zip' -Force"`,
  { stdio: 'inherit' },
);
await mkdir(join(root, 'Manga Teste'), { recursive: true });
execSync(`powershell -NoProfile -Command "Move-Item '${root}\\Manga Teste.zip' '${root}\\Manga Teste\\Capitulo 01.cbz' -Force"`);
await rm(pagesDir, { recursive: true, force: true });

console.log(`biblioteca de teste em ${root}`);
