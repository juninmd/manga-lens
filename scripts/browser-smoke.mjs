/**
 * Homologacao do lado do browser: grade -> serie -> leitor -> zoom no scroll ->
 * arrasto com o mouse -> OCR de verdade na pagina.
 * Uso: node scripts/browser-smoke.mjs   (servidor precisa estar no ar)
 */
import { chromium } from 'playwright';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 7788}`;
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${name} — ${detail}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200));
});

// traducao ligada e motor sem IA: a homologacao nao pode depender do LLM local
await page.addInitScript(() => {
  localStorage.setItem(
    'manga-lens:v1',
    JSON.stringify({ settings: { autoTranslate: true, engine: 'google', font: 'comic' } }),
  );
});

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ml-card', { timeout: 60_000 });
  const cards = await page.locator('.ml-card').count();
  record('catalogo carrega', cards > 0, `${cards} cards`);

  // Serie previsivel em ingles, boa para o OCR
  await page.goto(`${BASE}/#/s/mangapill/3069%2Fnaruto`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ml-chapter', { timeout: 60_000 });
  const chapters = await page.locator('.ml-chapter').count();
  record('painel de serie', chapters > 10, `${chapters} capitulos`);

  await page.locator('.ml-chapter').first().click();
  await page.waitForSelector('.ml-reader.is-open .ml-sheet img', { timeout: 90_000 });
  await page.waitForFunction(
    () => {
      const img = document.querySelector('.ml-sheet img');
      return img && img.complete && img.naturalWidth > 0;
    },
    null,
    { timeout: 90_000 },
  );
  record('leitor abre', true, await page.locator('.ml-page-label').innerText());

  const transform = () => page.locator('.ml-canvas').evaluate((n) => getComputedStyle(n).transform);
  const scaleOf = (m) => Number((/matrix\(([-\d.]+)/.exec(m) ?? [])[1] ?? 0);

  // zoom com a roda do mouse, ancorado no cursor
  const before = await transform();
  await page.mouse.move(700, 480);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(250);
  const afterZoom = await transform();
  const zoomPct = await page.locator('.ml-zoom-label').innerText();
  record('scroll da zoom', scaleOf(afterZoom) > scaleOf(before) * 1.5, `${scaleOf(before)} -> ${scaleOf(afterZoom)} (${zoomPct})`);

  // arrastar com o mouse move a pagina
  await page.mouse.move(700, 480);
  await page.mouse.down();
  await page.mouse.move(430, 300, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterDrag = await transform();
  // arrastar so' pode transladar: se a escala mudou, algo refez o ajuste no meio
  record(
    'arrastar com o mouse (sem perder o zoom)',
    afterDrag !== afterZoom && Math.abs(scaleOf(afterDrag) - scaleOf(afterZoom)) < 0.001,
    `escala ${scaleOf(afterZoom)} -> ${scaleOf(afterDrag)}`,
  );

  // duplo clique volta para o ajuste
  await page.mouse.dblclick(700, 480);
  await page.waitForTimeout(300);
  record('duplo clique alterna zoom', (await transform()) !== afterDrag, await page.locator('.ml-zoom-label').innerText());

  // navegador em miniatura aparece quando ampliado
  await page.mouse.move(700, 480);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(300);
  const navVisible = await page.locator('.ml-nav').isVisible();
  record('navegador em miniatura', navVisible, navVisible ? 'visivel ao ampliar' : 'nao apareceu');

  await page.keyboard.press('0');
  await page.waitForTimeout(200);

  // vai para uma pagina com dialogo de verdade antes do OCR
  await page.locator('.ml-thumb').nth(10).click();
  await page.waitForTimeout(1200);
  // o timeout precisa vir no TERCEIRO argumento: em waitForFunction(fn, arg, opts)
  // um objeto na segunda posicao vira argumento da funcao e o timeout volta ao
  // default de 30s sem avisar
  await page.waitForFunction(
    () => {
      const img = document.querySelector('.ml-sheet img');
      return img && img.complete && img.naturalWidth > 0;
    },
    null,
    { timeout: 60_000 },
  );

  // OCR de verdade (baixa o modelo e reconhece a pagina)
  await page.locator('button:has-text("OCR")').click();
  // "traduzindo N baloes..." ainda e' meio do caminho: esperar so' por /baloes/
  // media o canvas antes de existir pintura. O status final e' "N baloes".
  await page.waitForFunction(
    () => {
      const s = document.querySelector('.ml-ocr-status');
      return s && /^\d+ baloes$|sem texto|nao achou/.test((s.textContent ?? '').trim());
    },
    { timeout: 300_000 },
  );
  const ocrStatus = await page.locator('.ml-ocr-status').innerText();
  // a traducao e' composta no canvas, nao em DOM: os baloes so' existem no cache
  const blocks = await page.evaluate(() => {
    const keys = window.__mangaLens?.translatedKeys?.() ?? [];
    const key = keys.find((k) => k.endsWith(':10')) ?? keys.at(-1);
    return (window.__mangaLens?.blocksFor?.(key) ?? []).map((b) => ({ text: b.text, pt: b.pt ?? '' }));
  });
  record('OCR na pagina', blocks.length >= 3, `${ocrStatus} / ${blocks.length} baloes`);
  if (blocks.length) {
    const latin = blocks.filter((b) => /[A-Za-z]{3,}/.test(b.text)).length;
    record(
      'OCR usou o idioma do scan (ingles)',
      latin >= Math.ceil(blocks.length / 2),
      `${latin}/${blocks.length} baloes latinos: ${JSON.stringify(blocks.slice(0, 2).map((b) => b.text))}`,
    );
    const done = blocks.filter((b) => b.pt.trim()).length;
    record(
      'baloes traduzidos para o idioma de destino',
      done >= Math.ceil(blocks.length / 2),
      `${done}/${blocks.length} traduzidos: ${JSON.stringify(blocks.find((b) => b.pt.trim())?.pt ?? '')}`,
    );
  }

  // composicao: o canvas precisa ter pixels pintados sobre o balao
  const painted = await page.evaluate(() => {
    const c = document.querySelector('.ml-ocr');
    if (!c) return { ok: false, why: 'sem canvas' };
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) opaque++;
    return { ok: opaque > 500, opaque, total: data.length / 4 };
  });
  record(
    'traducao composta no canvas da pagina',
    painted.ok,
    `${painted.opaque ?? 0} pixels pintados de ${painted.total ?? 0}`,
  );

  // A fila trabalha uma pagina por vez e so' cruza para o capitulo seguinte depois
  // de esgotar o atual: cobrar essa virada no cronometro exigiria dezenas de OCRs.
  // O que da' para provar em tempo de teste e' o comportamento: ela avanca sozinha
  // e ja' enxerga o proximo capitulo na fila.
  const doneBefore = await page.evaluate(() => window.__mangaLens?.translatedKeys?.().length ?? 0);
  const advanced = await page
    .waitForFunction(
      (start) => (window.__mangaLens?.translatedKeys?.().length ?? 0) > start,
      doneBefore,
      { timeout: 180_000 },
    )
    .then(() => true)
    .catch(() => false);
  const queued = await page.evaluate(() => ({
    keys: window.__mangaLens?.translatedKeys?.().length ?? 0,
    chapters: (window.__mangaLens?.queuedChapters?.() ?? []).length,
    pending: window.__mangaLens?.queueSize?.() ?? 0,
  }));
  record(
    'fila adianta paginas sozinha',
    advanced,
    `${doneBefore} -> ${queued.keys} paginas traduzidas, ${queued.pending} na fila`,
  );
  record(
    'fila ja enfileira o proximo capitulo',
    queued.chapters >= 2,
    `${queued.chapters} capitulo(s) enfileirado(s)`,
  );

  // marcador de pagina
  await page.locator('button:has-text("marcar")').first().click();
  await page.waitForTimeout(400);
  const marked = await page.locator('button:has-text("marcado")').count();
  record('marcador de pagina', marked > 0, marked ? 'pagina marcada' : 'botao nao mudou de estado');

  // ultima pagina marca o capitulo como lido
  await page.locator('.ml-thumb').last().click();
  await page.waitForTimeout(800);
  const readState = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('manga-lens:v1') ?? '{}');
    const lidos = Object.values(raw.read ?? {}).flat().length;
    const marcadores = (raw.bookmarks ?? []).length;
    return { lidos, marcadores };
  });
  record(
    'capitulo lido + marcador persistidos',
    readState.lidos > 0 && readState.marcadores > 0,
    `lidos=${readState.lidos} marcadores=${readState.marcadores}`,
  );

  // a lista de capitulos mostra o que ja' foi lido
  await page.locator('button:has-text("voltar")').click();
  // espera fixa aqui virava corrida: com o OCR paralelo ocupando a CPU, a lista
  // as vezes ainda nao repintou em 600ms. O estado ja' foi conferido acima.
  await page
    .waitForFunction(() => document.querySelectorAll('.ml-chapter.is-read').length > 0, { timeout: 15_000 })
    .catch(() => undefined);
  const readRows = await page.locator('.ml-chapter.is-read').count();
  record('lista marca capitulo lido', readRows > 0, `${readRows} capitulo(s) marcados`);

  // motor de traducao sem IA aparece na barra
  await page.locator('.ml-chapter-open').first().click();
  await page.waitForSelector('.ml-reader.is-open .ml-sheet img', { timeout: 60_000 });
  const engineOptions = await page.locator('.ml-reader-top select option').allInnerTexts();
  record('motor de traducao selecionavel', engineOptions.length >= 2, engineOptions.join(' / '));

  // troca de modo de leitura
  await page.locator('button:has-text("tira")').click();
  await page.waitForTimeout(500);
  const sheets = await page.locator('.ml-sheet').count();
  record('modo tira (webtoon)', sheets > 1, `${sheets} paginas empilhadas`);

  await page.screenshot({ path: 'scripts/.smoke-reader.png' });
} catch (err) {
  record('execucao', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} falha(s)` : '\ntudo verde no browser');
process.exit(failed.length ? 1 : 0);
