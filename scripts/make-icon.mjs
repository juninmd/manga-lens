/** Gera o PNG base do icone (1024px) renderizando no chromium — evita dependencia de editor. */
import { chromium } from 'playwright';

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:1024px;height:1024px}
  .bg{width:1024px;height:1024px;display:grid;place-items:center;
      background:linear-gradient(135deg,#1b1f27 0%,#0d0f13 100%)}
  .card{position:relative;width:600px;height:760px;border-radius:44px;background:#f4f1ea;
        box-shadow:0 40px 90px rgba(0,0,0,.55)}
  .spine{position:absolute;left:0;top:0;bottom:0;width:74px;border-radius:44px 0 0 44px;background:#ff7a45}
  .line{position:absolute;left:140px;height:34px;border-radius:17px;background:#20242c}
  .lens{position:absolute;right:-70px;bottom:-70px;width:400px;height:400px;border-radius:50%;
        border:36px solid #4aa8ff;background:rgba(74,168,255,.16)}
  .handle{position:absolute;right:-150px;bottom:-150px;width:150px;height:46px;border-radius:23px;
          background:#4aa8ff;transform:rotate(45deg)}
</style><div class="bg"><div class="card">
  <div class="spine"></div>
  <div class="line" style="top:120px;width:300px"></div>
  <div class="line" style="top:196px;width:390px"></div>
  <div class="line" style="top:272px;width:240px"></div>
  <div class="lens"></div><div class="handle"></div>
</div></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(html);
await page.screenshot({ path: 'src-tauri/icon-source.png' });
await browser.close();
console.log('icone base gerado em src-tauri/icon-source.png');
