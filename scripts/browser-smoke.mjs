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

// Traducao ligada, em modo automatico. Fixar 'google' amarrava a homologacao da
// UI inteira a um provider so': quando o Google devolve 429 (acontece em rajada)
// nenhum balao traduz e o teste acusa defeito nosso. O 'auto' tenta Google,
// MyMemory e so' entao a IA — e o que cada motor faz sozinho ja' e' coberto
// pelo `bun run smoke`.
await page.addInitScript(() => {
  localStorage.setItem(
    'manga-lens:v1',
    JSON.stringify({ settings: { autoTranslate: true, engine: 'auto', font: 'comic' } }),
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
      return img?.complete && img.naturalWidth > 0;
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
      return img?.complete && img.naturalWidth > 0;
    },
    null,
    { timeout: 60_000 },
  );

  // OCR de verdade (baixa o modelo e reconhece a pagina). Com `autoTranslate`
  // ligado a execucao do capitulo ja' comecou sozinha e o botao virou "cancelar":
  // clicar ali abortaria justamente o que o teste quer medir.
  const ocrBtn = page.locator('button:has-text("OCR")');
  if (await ocrBtn.count()) await ocrBtn.first().click();
  // Esperar pelo TEXTO da barra de status era corrida: com a fila adiantando
  // paginas em paralelo, o "N baloes" que aparece pode ser de outra pagina, e a
  // medicao saia da capa em vez da pagina aberta. O cache e' o sinal exato — a
  // chave e' `capitulo:pagina:tipo` (`:10:t` = pagina 11, reconhecida pelo OCR).
  await page.waitForFunction(
    () => (window.__mangaLens?.translatedKeys?.() ?? []).some((k) => /:10:[tv]$/.test(k)),
    null,
    { timeout: 300_000 },
  );
  // o OCR grava a pagina no cache antes de a traducao voltar: medir aqui lia
  // sempre `pt` vazio e acusava defeito onde havia so' corrida
  await page
    .waitForFunction(
      () => {
        const key = (window.__mangaLens?.translatedKeys?.() ?? []).find((k) => /:10:[tv]$/.test(k));
        const blocks = window.__mangaLens?.blocksFor?.(key) ?? [];
        return blocks.some((b) => (b.pt ?? '').trim());
      },
      null,
      { timeout: 120_000 },
    )
    .catch(() => undefined);
  const ocrStatus = await page.locator('.ml-ocr-status').innerText();
  // a traducao e' composta no canvas, nao em DOM: os baloes so' existem no cache
  const blocks = await page.evaluate(() => {
    const key = (window.__mangaLens?.translatedKeys?.() ?? []).find((k) => /:10:[tv]$/.test(k));
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

  // tooltip do texto original: some rapido demais e' o defeito classico aqui —
  // ele precisa sobreviver a caminhada do mouse ate' ele e a um pixel fora da caixa
  const ttBox = await page.evaluate(() => {
    // `.ml-sheet` nao carrega o indice da pagina: o rotulo da barra ("12 / 59") diz
    // qual esta' no palco, e em modo pagina ha' exatamente uma folha montada
    const shown = Number((document.querySelector('.ml-page-label')?.textContent ?? '').split('/')[0]?.trim()) - 1;
    const sheet = document.querySelector('.ml-sheet');
    if (!sheet || !Number.isInteger(shown)) return null;
    const key = (window.__mangaLens?.translatedKeys?.() ?? []).find((k) => new RegExp(`:${shown}:[tv]$`).test(k));
    const b = (window.__mangaLens?.blocksFor?.(key) ?? [])
      .filter((x) => (x.text ?? '').trim())
      .sort((p, q) => q.w * q.h - p.w * p.h)[0];
    if (!b) return null;
    const r = sheet.getBoundingClientRect();
    const img = sheet.querySelector('img');
    const sx = r.width / (img?.naturalWidth || 1);
    const sy = r.height / (img?.naturalHeight || 1);
    return { left: r.left + b.x * sx, top: r.top + b.y * sy, w: b.w * sx, h: b.h * sy };
  });
  if (ttBox) {
    const ttVisible = () => page.evaluate(() => !document.querySelector('.ml-balloon-tooltip')?.hidden);
    await page.mouse.move(ttBox.left + ttBox.w / 2 - 12, ttBox.top + ttBox.h / 2 - 12);
    await page.mouse.move(ttBox.left + ttBox.w / 2, ttBox.top + ttBox.h / 2);
    const aberto = await ttVisible();
    const alvo = await page.evaluate(() => {
      const r = document.querySelector('.ml-balloon-tooltip').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(alvo.x, alvo.y, { steps: 6 });
    await new Promise((r) => setTimeout(r, 150));
    const sobreviveu = await ttVisible();
    // longe do balao e do tooltip ele precisa fechar, passada a carencia
    await page.mouse.move(8, 8, { steps: 4 });
    await new Promise((r) => setTimeout(r, 700));
    const fechou = !(await ttVisible());
    record(
      'tooltip do original sobrevive ao mouse indo ate ele',
      aberto && sobreviveu && fechou,
      `abriu=${aberto} sobreviveu=${sobreviveu} fechou-ao-sair=${fechou}`,
    );
  } else {
    record('tooltip do original sobrevive ao mouse indo ate ele', false, 'nenhum balao com texto para medir');
  }

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
  const bar = await page.evaluate(() => {
    const host = document.querySelector('.ml-progress-item');
    const fill = document.querySelector('.ml-progress-fill');
    const p = window.__mangaLens?.progress?.() ?? { done: 0, total: 0 };
    return { visible: Boolean(host) && !host.hidden, width: fill?.style.width ?? '', text: document.querySelector('.ml-progress-text')?.textContent ?? '', ...p };
  });
  record(
    'barra de progresso do capitulo',
    bar.visible && bar.total > 0 && bar.done > 0,
    `${bar.text || 'sem rotulo'} (largura ${bar.width || '0'})`,
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

  // a lista de capitulos mostra o que ja' foi lido. Seletor preso ao leitor de
  // imagem: o leitor de livro tem o mesmo botao e vive no DOM mesmo fechado
  await page.locator('.ml-reader-top button:has-text("voltar")').click();
  // espera fixa aqui virava corrida: com o OCR paralelo ocupando a CPU, a lista
  // as vezes ainda nao repintou em 600ms. O estado ja' foi conferido acima.
  await page
    .waitForFunction(() => document.querySelectorAll('.ml-chapter.is-read').length > 0, null, { timeout: 15_000 })
    .catch(() => undefined);
  const readRows = await page.locator('.ml-chapter.is-read').count();
  record('lista marca capitulo lido', readRows > 0, `${readRows} capitulo(s) marcados`);

  // os motores e os modos vivem no popover de opcoes, nao mais na barra de cima
  await page.locator('.ml-chapter-open').first().click();
  await page.waitForSelector('.ml-reader.is-open .ml-sheet img', { timeout: 60_000 });
  await page.locator('#ml-btn-options').first().click();
  await page.waitForSelector('.ml-popover .ml-segmented', { timeout: 15_000 });
  const modes = await page.locator('.ml-popover .ml-segmented .ml-segmented-btn').allInnerTexts();
  const engineOptions = await page.locator('.ml-popover select option').allInnerTexts();
  record('motor de traducao selecionavel', engineOptions.length >= 2, engineOptions.join(' / '));
  record(
    'modos de traducao: web, IA e visao',
    modes.length === 3 && modes.some((m) => /visao/i.test(m)),
    modes.join(' / '),
  );
  // o motor que exige IA tem modo proprio: oferecer no select do Tradutor Web
  // levaria o usuario a escolher visao "sem IA" e receber erro de configuracao
  record(
    'select do Tradutor Web nao oferece motor de IA',
    !engineOptions.some((o) => /visao|contexto/i.test(o)),
    engineOptions.slice(0, 4).join(' / '),
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ml-popover', { state: 'hidden', timeout: 10_000 }).catch(() => undefined);

  // troca de modo de leitura
  await page.locator('button:has-text("tira")').click();
  await page.waitForTimeout(500);
  const sheets = await page.locator('.ml-sheet').count();
  record('modo tira (webtoon)', sheets > 1, `${sheets} paginas empilhadas`);

  await page.screenshot({ path: 'scripts/.smoke-reader.png' });

  // O Back do navegador tem de sair da leitura. Sair pelo botao da barra sempre
  // funcionou (ele chama history.back()); o caminho inverso deixava o leitor
  // aberto por cima do painel de serie, em tela cheia, tapando tudo.
  await page.goBack();
  const leftReader = await page
    .waitForFunction(() => !document.querySelector('.ml-reader.is-open'), null, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  record('Back do navegador fecha o leitor', leftReader, leftReader ? 'voltou para a serie' : 'leitor continuou aberto');
  // Leitor de livro (EPUB local). So' roda quando a LOCAL_LIBRARY do servidor
  // tem um EPUB: sem acervo local a aba Livro esta' legitimamente vazia.
  const livros = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/search?providers=local&contentType=livro&limit=24`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.items.filter((i) => i.type === 'book').map((i) => i.id);
  }, BASE);
  if (!livros.length) {
    console.log('PULA  leitor de livro — nenhum EPUB na biblioteca local do servidor');
  } else {
    await page.goto(`${BASE}/#/s/local/${encodeURIComponent(livros[0])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ml-chapter', { timeout: 30_000 });
    await page.locator('.ml-chapter').first().click();
    const paras = await page
      .waitForFunction(() => document.querySelectorAll('.ml-book.is-open .ml-book-p').length, null, { timeout: 30_000 })
      .then((h) => h.jsonValue())
      .catch(() => 0);
    record('leitor de livro abre o capitulo em paragrafos', paras > 0, `${paras} paragrafos`);
    // o livro nao tem pagina: o leitor de imagem nao pode ter sido aberto junto
    const semLeitorDeImagem = !(await page.locator('.ml-reader.is-open').count());
    record('EPUB nao cai no leitor de paginas', semLeitorDeImagem, semLeitorDeImagem ? 'apenas o leitor de livro' : 'os dois abriram');
    // autoTranslate esta' ligado no smoke: o capitulo tem de terminar traduzido
    const traduzidos = await page
      .waitForFunction(() => document.querySelectorAll('.ml-book-p.is-translated').length, null, { timeout: 120_000 })
      .then((h) => h.jsonValue())
      .catch(() => 0);
    record('livro traduz sozinho com autoTranslate', traduzidos > 0, `${traduzidos} paragrafos traduzidos`);
    await page.goBack();
  }

} catch (err) {
  record('execucao', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} falha(s)` : '\ntudo verde no browser');
process.exit(failed.length ? 1 : 0);
