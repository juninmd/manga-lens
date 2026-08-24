/**
 * Homologa o app desktop DE VERDADE: sobe o executavel Tauri com o WebView2 em
 * modo depuracao, conecta via CDP e verifica que o front achou o sidecar
 * (porta dinamica + CORS) e que o OCR carrega do bundle, sem node_modules.
 */
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tem de ser o release: o binario de debug nao embute o front, depende do
// servidor estatico que o `tauri dev` sobe na 1430 e nao roda sozinho.
const EXE = 'src-tauri/target/release/manga-lens.exe';
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${name} — ${detail}`);
};

const running = () => {
  try {
    return execSync('tasklist /FI "IMAGENAME eq manga-lens.exe"').toString().includes('manga-lens.exe');
  } catch {
    return false;
  }
};

for (const image of ['manga-lens.exe', 'manga-lens-server.exe']) {
  try {
    execSync(`taskkill /IM ${image} /F`, { stdio: 'ignore' });
  } catch {
    /* nada rodando */
  }
}
// Instancia anterior ainda morrendo segura a porta 9222 e o CDP anexa na janela
// velha, cujo sidecar ja' morreu — o sintoma e' ERR_CONNECTION_REFUSED no front.
for (let i = 0; i < 15 && running(); i++) await sleep(1000);

// Perfil proprio por execucao: o WebView2 reaproveita o processo de browser da
// pasta de dados, e um sobrevivente de execucao anterior faz o CDP anexar numa
// janela velha, cujo sidecar ja' morreu (sintoma: ERR_CONNECTION_REFUSED).
const profile = join(tmpdir(), `manga-lens-smoke-${process.pid}`);
await mkdir(profile, { recursive: true });

const app = spawn(EXE, {
  detached: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
    WEBVIEW2_USER_DATA_FOLDER: profile,
  },
});
app.unref();

let browser;
for (let i = 0; i < 30 && !browser; i++) {
  await sleep(1000);
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222').catch(() => undefined);
}
if (!browser) {
  console.error('FALHA nao consegui conectar no WebView2 do app');
  process.exit(1);
}

try {
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 180));
  });

  await page.waitForSelector('.ml-card', { timeout: 90_000 });
  record('catalogo no app desktop', true, `${await page.locator('.ml-card').count()} cards`);

  const apiBase = await page.evaluate(async () => {
    const port = await window.__TAURI__.core.invoke('api_port');
    const res = await fetch(`http://127.0.0.1:${port}/api/providers`);
    return `${port} -> HTTP ${res.status}`;
  });
  record('sidecar em porta dinamica', apiBase.includes('200'), apiBase);

  const coverOrigin = await page.locator('.ml-card img').first().getAttribute('src');
  record('imagens apontam para o sidecar', /^http:\/\/127\.0\.0\.1:\d+\/api\/img/.test(coverOrigin ?? ''), (coverOrigin ?? '').slice(0, 60));

  const vendor = await page.evaluate(async () => {
    const res = await fetch('/vendor/tesseract/worker.min.js');
    return `${res.status} ${(await res.text()).length}`;
  });
  record('tesseract vem do bundle do app', vendor.startsWith('200'), vendor);

  // abre um capitulo: e' a imagem do leitor que o OCR precisa conseguir ler
  await page.goto('http://tauri.localhost/#/s/mangapill/3069%2Fnaruto').catch(() => undefined);
  await page.waitForSelector('.ml-chapter', { timeout: 60_000 });
  await page.locator('.ml-chapter').first().click();
  await page.waitForSelector('.ml-reader.is-open .ml-sheet img', { timeout: 90_000 });

  // o canvas so le os pixels se o CORS do sidecar estiver certo
  const canvasOk = await page.evaluate(async () => {
    const img = document.querySelector('.ml-sheet img');
    if (!img) return 'sem imagem';
    if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }));
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    c.getContext('2d').drawImage(img, 0, 0, 8, 8);
    try {
      c.getContext('2d').getImageData(0, 0, 8, 8);
      return 'canvas legivel';
    } catch (e) {
      return `tainted: ${String(e).slice(0, 80)}`;
    }
  });
  record('canvas do OCR nao fica tainted', canvasOk === 'canvas legivel', canvasOk);

  await page.screenshot({ path: 'scripts/.desktop.png' });
} catch (err) {
  record('execucao', false, String(err).slice(0, 250));
} finally {
  await browser.close().catch(() => undefined);
  try {
    execSync('taskkill /IM manga-lens.exe /F', { stdio: 'ignore' });
  } catch {
    /* ja' fechou */
  }
}

// o sidecar so' percebe o pai morto na proxima sondagem (5s)
await sleep(9000);
const orphan = (() => {
  try {
    return execSync('tasklist /FI "IMAGENAME eq manga-lens-server.exe"').toString().includes('manga-lens-server');
  } catch {
    return false;
  }
})();
record('sidecar morre junto com a janela', !orphan, orphan ? 'ficou processo orfao' : 'nenhum processo orfao');

await rm(profile, { recursive: true, force: true }).catch(() => undefined);

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} falha(s)` : '\ndesktop verde');
process.exit(failed ? 1 : 0);
