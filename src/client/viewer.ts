import type { PageRef } from './api.ts';
import { store, type FitMode, type ReadingMode } from './state.ts';

interface Sheet {
  page: number;
  el: HTMLDivElement;
  img: HTMLImageElement;
  ocr: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
  loaded: boolean;
}

const GAP = 16; // espaco entre paginas, em pixels de imagem
const MIN_SCALE = 0.05;
export const MAX_SCALE = 12;
// toque: abaixo disso e' tap, nao arrasto; deslize horizontal rapido vira pagina
const TAP_SLOP = 8;
const SWIPE_MIN = 60;
const SWIPE_MAX_MS = 400;
const WHEEL_TURN_MS = 250;
// modo tira pode empilhar centenas de paginas na mesma tela; sem isso o navegador
// mantem todas decodificadas na memoria o capitulo inteiro. So' o que esta' perto
// da leitura fica carregado — o resto libera o `src` e recarrega ao reaproximar.
const RETAIN_BEHIND = 8;
const RETAIN_AHEAD = 20;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export interface ViewerEvents {
  onPageChange?: (page: number) => void;
  onTransform?: (info: { scale: number; fitScale: number; fit: FitMode }) => void;
  onSheetsChange?: (sheets: { page: number; img: HTMLImageElement; ocr: HTMLCanvasElement }[]) => void;
  /** tap na lateral / deslize / roda pediram virar pagina — o app decide o que fazer no fim do capitulo */
  onNavigate?: (dir: 1 | -1) => void;
  /** tap (sem arrasto) no palco; devolver true consome o toque — um balao nao vira a pagina */
  onTap?: (clientX: number, clientY: number) => boolean;
}

/**
 * Visualizador estilo Picasa: scroll da zoom ancorado no cursor, arrastar com o
 * mouse move a imagem, navegador em miniatura quando esta' ampliado.
 */
export class Viewer {
  private stage!: HTMLElement;
  private canvas!: HTMLDivElement;
  private nav!: HTMLDivElement;
  private navBox!: HTMLDivElement;

  private pages: PageRef[] = [];
  private sheets: Sheet[] = [];
  private spread = 0;

  private tx = 0;
  private ty = 0;
  private scale = 1;
  private fitScale = 1;
  private contentW = 1000;
  private contentH = 1500;

  mode: ReadingMode = 'single';
  fit: FitMode = 'page';
  rtl = true;

  private pointers = new Map<number, { x: number; y: number }>();
  private dragging = false;
  private last = { x: 0, y: 0, t: 0 };
  private velocity = { x: 0, y: 0 };
  private inertia = 0;
  private pinchStart: { dist: number; scale: number; cx: number; cy: number } | null = null;
  private lastEmittedPage = -1;
  /** onde o dedo/mouse desceu — decide entre tap, deslize e arrasto ao soltar */
  private gesture: { x: number; y: number; t: number; type: string; pinched: boolean } | null = null;
  private lastWheelTurn = 0;
  /** ultimo tap de toque: dois seguidos (< 300ms, < 24px) valem um duplo clique — iOS nao sintetiza dblclick com touch-action:none */
  private lastTap: { x: number; y: number; t: number } | null = null;
  /** pagina pedida antes das imagens da tira carregarem — reancorada a cada `load` */
  private stripStart: number | undefined;

  constructor(private events: ViewerEvents = {}) {}

  mount(stage: HTMLElement): void {
    this.stage = stage;
    stage.innerHTML = `
      <div class="ml-canvas"></div>
      <div class="ml-nav" hidden><div class="ml-nav-box"></div></div>`;
    this.canvas = stage.querySelector('.ml-canvas')!;
    this.nav = stage.querySelector('.ml-nav')!;
    this.navBox = stage.querySelector('.ml-nav-box')!;

    stage.addEventListener('wheel', this.onWheel, { passive: false });
    stage.addEventListener('pointerdown', this.onPointerDown);
    stage.addEventListener('pointermove', this.onPointerMove);
    stage.addEventListener('pointerup', this.onPointerUp);
    stage.addEventListener('pointercancel', this.onPointerUp);
    stage.addEventListener('dblclick', this.onDoubleClick);
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    this.nav.addEventListener('pointerdown', this.onNavDrag);
    // girar o celular / teclado do chat redimensiona o palco: na tira, sem preservar a rolagem, voltava ao topo
    new ResizeObserver(() => this.applyFit(this.fit, this.mode === 'strip')).observe(stage);
  }

  setPages(pages: PageRef[], startPage = 0): void {
    this.pages = pages;
    this.spread = this.spreadOf(startPage);
    // na tira nao existe folha: a pagina inicial vira rolagem depois de montar
    this.stripStart = this.mode === 'strip' && startPage > 0 ? startPage : undefined;
    this.build();
  }

  get pageCount(): number {
    return this.pages.length;
  }

  get currentPage(): number {
    if (this.mode === 'strip') return this.visibleStripPage();
    return this.pagesInSpread(this.spread)[0] ?? 0;
  }

  getTransform(): { tx: number; ty: number; scale: number } {
    return { tx: this.tx, ty: this.ty, scale: this.scale };
  }

  getSheets(): { page: number; el: HTMLDivElement; img: HTMLImageElement; ocr: HTMLCanvasElement; x: number; y: number; w: number; h: number }[] {
    return this.sheets;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  // ---------- layout ----------

  private perSpread(): number {
    return this.mode === 'double' ? 2 : 1;
  }

  /**
   * Deslocamento da dupla: manga com capa na pagina 0 desalinha todos os pares
   * ([0,1],[2,3]...). Com offset 1 a capa fica sozinha e as duplas viram [1,2],[3,4].
   */
  private offset: 0 | 1 = 0;

  private spreadOffset(): number {
    return this.mode === 'double' ? this.offset : 0;
  }

  private spreadOf(page: number): number {
    return this.mode === 'strip' ? 0 : Math.floor((page + this.spreadOffset()) / this.perSpread());
  }

  private pagesInSpread(spread: number): number[] {
    if (this.mode === 'strip') return this.pages.map((_, i) => i);
    const per = this.perSpread();
    const start = spread * per - this.spreadOffset();
    return this.pages.map((_, i) => i).slice(Math.max(0, start), start + per);
  }

  get coverOffset(): 0 | 1 {
    return this.offset;
  }

  /** Alterna o deslocamento mantendo a pagina atual em cena. */
  setCoverOffset(offset: 0 | 1): void {
    if (this.offset === offset) return;
    const page = this.currentPage;
    this.offset = offset;
    this.spread = this.spreadOf(page);
    this.build();
  }

  private build(): void {
    this.canvas.innerHTML = '';
    this.sheets = [];
    const indexes = this.pagesInSpread(this.spread);

    for (const page of indexes) {
      const el = document.createElement('div');
      el.className = 'ml-sheet';
      const img = document.createElement('img');
      // sem isso o canvas do OCR fica tainted quando a API roda em outra origem
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.draggable = false;
      img.alt = `pagina ${page + 1}`;
      // strip pode ter centenas de paginas: so carrega o que entra em cena
      img.loading = this.mode === 'strip' && page > indexes[0]! + 3 ? 'lazy' : 'eager';
      img.src = this.pages[page]!.url;
      // canvas em vez de divs: o texto e' composto no espaco da propria pagina
      const ocr = document.createElement('canvas');
      ocr.className = 'ml-ocr';
      el.append(img, ocr);
      this.canvas.append(el);

      const sheet: Sheet = { page, el, img, ocr, x: 0, y: 0, w: 800, h: 1200, loaded: false };
      img.addEventListener('load', () => {
        sheet.w = img.naturalWidth || 800;
        sheet.h = img.naturalHeight || 1200;
        sheet.loaded = true;
        this.relayout();
      });
      img.addEventListener('error', () => {
        el.classList.add('is-broken');
        sheet.loaded = true;
        // retangulo mudo nao diz se foi rede, 404 ou proxy: da' o numero e um retry
        if (!el.querySelector('.ml-sheet-retry')) {
          const retry = document.createElement('button');
          retry.className = 'ml-btn ml-btn-sm ml-sheet-retry';
          retry.type = 'button';
          retry.textContent = `pagina ${page + 1} nao carregou — tentar de novo`;
          retry.addEventListener('click', () => {
            el.classList.remove('is-broken');
            retry.remove();
            const url = this.pages[page]!.url;
            img.src = `${url}${url.includes('?') ? '&' : '?'}r=${Date.now()}`;
          });
          el.append(retry);
        }
        this.relayout();
      });
      this.sheets.push(sheet);
    }

    this.lastEmittedPage = -1;
    this.relayout(true);
    if (this.stripStart !== undefined) {
      this.goToPage(this.stripStart);
      this.stripStart = undefined;
    }
    this.preload();
    this.events.onSheetsChange?.(this.sheets.map((s) => ({ page: s.page, img: s.img, ocr: s.ocr })));
    this.events.onPageChange?.(this.currentPage);
  }

  private relayout(refit = false): void {
    if (!this.sheets.length) return;

    if (this.mode === 'strip') {
      // imagem que carrega acima da leitura muda a altura da pilha: guarda qual
      // pagina esta' no topo da tela (e quanto dela ja' passou) para recolocar
      // a rolagem no mesmo lugar depois de reempilhar
      const top = -this.ty / this.scale;
      const anchor = refit ? undefined : this.sheets.find((s) => s.y + s.h > top);
      const offset = anchor ? top - anchor.y : 0;
      const width = Math.max(...this.sheets.map((s) => s.w));
      let y = 0;
      for (const s of this.sheets) {
        s.x = (width - s.w) / 2;
        s.y = y;
        y += s.h + GAP;
      }
      this.contentW = width;
      this.contentH = Math.max(y - GAP, 1);
      if (anchor) this.ty = -(anchor.y + offset) * this.scale;
    } else {
      const order = this.rtl ? [...this.sheets].reverse() : this.sheets;
      const height = Math.max(...this.sheets.map((s) => s.h));
      let x = 0;
      for (const s of order) {
        s.x = x;
        s.y = (height - s.h) / 2;
        x += s.w + (order.length > 1 ? GAP : 0);
      }
      this.contentW = Math.max(x - (order.length > 1 ? GAP : 0), 1);
      this.contentH = height;
    }

    for (const s of this.sheets) {
      s.el.style.transform = `translate(${s.x}px, ${s.y}px)`;
      s.el.style.width = `${s.w}px`;
      s.el.style.height = `${s.h}px`;
    }
    this.canvas.style.width = `${this.contentW}px`;
    this.canvas.style.height = `${this.contentH}px`;

    // relayout roda a cada imagem que carrega: preserva a rolagem, senao a tira
    // volta para o topo o tempo todo enquanto o capitulo carrega
    if (refit) this.applyFit(this.fit);
    else if (this.fit !== 'free') this.applyFit(this.fit, true);
    else this.apply();
  }

  private stageSize(): { w: number; h: number } {
    return { w: this.stage.clientWidth || 1, h: this.stage.clientHeight || 1 };
  }

  applyFit(fit: FitMode = this.fit, preserveScroll = false): void {
    // na tira "ajustar" encolheria o capitulo inteiro a um fio — la' o unico ajuste que faz sentido e' largura
    if (this.mode === 'strip' && fit !== 'free') fit = 'width';
    this.fit = fit;
    const { w, h } = this.stageSize();
    const previous = this.scale;
    this.fitScale = Math.min(w / this.contentW, h / this.contentH);
    if (fit !== 'free') {
      this.scale = clamp(
        fit === 'width' ? w / this.contentW : fit === 'height' ? h / this.contentH : this.fitScale,
        MIN_SCALE,
        MAX_SCALE,
      );
      this.tx = (w - this.contentW * this.scale) / 2;
      this.ty =
        this.mode === 'strip'
          ? preserveScroll
            ? this.ty * (this.scale / previous)
            : 0
          : (h - this.contentH * this.scale) / 2;
    }
    this.apply();
  }

  private clampPan(): void {
    const { w, h } = this.stageSize();
    const cw = this.contentW * this.scale;
    const ch = this.contentH * this.scale;
    this.tx = cw <= w ? (w - cw) / 2 : clamp(this.tx, w - cw, 0);
    this.ty = ch <= h ? (h - ch) / 2 : clamp(this.ty, h - ch, 0);
  }

  private apply(): void {
    this.clampPan();
    this.canvas.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
    this.updateNavigator();
    this.events.onTransform?.({ scale: this.scale, fitScale: this.fitScale, fit: this.fit });
    if (this.mode === 'strip') {
      // apply() roda a cada quadro do arrasto: so avisa quando a pagina muda mesmo
      const page = this.visibleStripPage();
      if (page !== this.lastEmittedPage) {
        this.lastEmittedPage = page;
        this.events.onPageChange?.(page);
        this.trimOffscreen(page);
      }
    }
  }

  /**
   * Libera a memoria decodificada das paginas que ficaram para tras ou muito
   * a frente na tira: tira o `src` (o navegador solta a imagem decodificada)
   * e recarrega quando a pagina volta a entrar na janela de retencao.
   */
  private trimOffscreen(centerPage: number): void {
    const lo = centerPage - RETAIN_BEHIND;
    const hi = centerPage + RETAIN_AHEAD;
    for (const s of this.sheets) {
      const inWindow = s.page >= lo && s.page <= hi;
      const unloaded = s.el.classList.contains('is-unloaded');
      if (inWindow && unloaded) {
        s.el.classList.remove('is-unloaded');
        s.img.src = this.pages[s.page]!.url;
      } else if (!inWindow && !unloaded && s.loaded) {
        s.el.classList.add('is-unloaded');
        s.img.removeAttribute('src');
      }
    }
  }

  // ---------- zoom / pan ----------

  zoomAt(factor: number, clientX: number, clientY: number): void {
    const rect = this.stage.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    const ratio = next / this.scale;
    // mantem o ponto sob o cursor imovel — e' o que da' a sensacao do Picasa
    this.tx = px - (px - this.tx) * ratio;
    this.ty = py - (py - this.ty) * ratio;
    this.scale = next;
    this.fit = 'free';
    this.apply();
  }

  setZoom(scale: number): void {
    const { w, h } = this.stageSize();
    this.zoomAt(clamp(scale, MIN_SCALE, MAX_SCALE) / this.scale, w / 2 + this.stage.getBoundingClientRect().left, h / 2 + this.stage.getBoundingClientRect().top);
  }

  get zoom(): number {
    return this.scale;
  }
  get fitZoom(): number {
    return this.fitScale;
  }

  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
    this.apply();
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.stopInertia();
    // Folha: roda solta da' zoom (o smoke e os usuarios atuais dependem disso),
    // Shift+roda vira pagina. Tira: roda rola, Ctrl+roda da' zoom. Ctrl/Cmd+roda
    // da' zoom em qualquer modo.
    const zoomGesture = e.ctrlKey || e.metaKey || (this.mode !== 'strip' && !e.shiftKey);
    if (zoomGesture) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.zoomAt(factor, e.clientX, e.clientY);
      return;
    }
    if (this.mode !== 'strip') {
      const now = performance.now();
      if (now - this.lastWheelTurn < WHEEL_TURN_MS) return;
      this.lastWheelTurn = now;
      const forward = store.settings.invertScroll ? e.deltaY < 0 : e.deltaY > 0;
      this.navigate(forward ? 1 : -1);
      return;
    }
    // strip: rolagem normal move a pagina; nas bordas, troca de capitulo fica com o app
    this.panBy(-e.deltaX, -e.deltaY);
  };

  /** Chromium/Android sintetiza `dblclick` apos dois toques: o detector manual ja' tratou */
  private lastPointerType = 'mouse';

  private onPointerDown = (e: PointerEvent): void => {
    this.lastPointerType = e.pointerType;
    if (e.button !== 0 && e.button !== 1) return;
    // botao dentro do palco (retry da pagina quebrada): capturar o ponteiro aqui engoliria o click
    if ((e.target as Element | null)?.closest('button')) return;
    this.stopInertia();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.stage.setPointerCapture(e.pointerId);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchStart = {
        dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
        scale: this.scale,
        cx: (a!.x + b!.x) / 2,
        cy: (a!.y + b!.y) / 2,
      };
      if (this.gesture) this.gesture.pinched = true;
      return;
    }
    this.gesture = { x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType, pinched: false };
    this.dragging = true;
    this.stage.classList.add('is-dragging');
    this.last = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.velocity = { x: 0, y: 0 };
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2 && this.pinchStart) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const target = clamp((this.pinchStart.scale * dist) / this.pinchStart.dist, MIN_SCALE, MAX_SCALE);
      // o centro dos dedos anda junto: beliscar e arrastar no mesmo gesto
      const cx = (a!.x + b!.x) / 2;
      const cy = (a!.y + b!.y) / 2;
      this.panBy(cx - this.pinchStart.cx, cy - this.pinchStart.cy);
      this.pinchStart.cx = cx;
      this.pinchStart.cy = cy;
      this.zoomAt(target / this.scale, cx, cy);
      return;
    }
    if (!this.dragging) return;

    const now = performance.now();
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    const dt = Math.max(now - this.last.t, 1);
    this.velocity = { x: dx / dt, y: dy / dt };
    this.last = { x: e.clientX, y: e.clientY, t: now };
    this.panBy(dx, dy);
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2 && this.pinchStart) {
      this.pinchStart = null;
      // sobrou um dedo: `last` ainda e' de antes do pinch e o proximo move daria um salto
      const rest = [...this.pointers.values()][0];
      if (rest) {
        this.last = { x: rest.x, y: rest.y, t: performance.now() };
        this.velocity = { x: 0, y: 0 };
      }
    }
    if (this.pointers.size > 0) return;
    this.dragging = false;
    this.stage.classList.remove('is-dragging');
    const g = this.gesture;
    this.gesture = null;
    // pointerdown num botao do palco nao registra gesto: o up correspondente nao pode disparar inercia velha
    if (!g) return;
    if (!g.pinched && e.type === 'pointerup' && g.type !== 'mouse') {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      const dt = performance.now() - g.t;
      // "ampliado" e' ter saido do ajuste (zoom livre): com ajuste largura/altura
      // a escala passa do fitScale e o toque lateral/deslize ficavam mudos
      const notZoomed = this.fit !== 'free';
      // toque/duplo-toque valem em todo modo (na tira o touch nao tinha como fixar o tooltip);
      // so' a lateral e o deslize sao de folha
      if (Math.hypot(dx, dy) < TAP_SLOP) {
        const now = performance.now();
        const prev = this.lastTap;
        this.lastTap = { x: e.clientX, y: e.clientY, t: now };
        if (prev && now - prev.t < 300 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 24) {
          this.lastTap = null;
          this.toggleZoomAt(e.clientX, e.clientY);
          return;
        }
        // toque em cima de um balao mostra o original; so' fora dele a lateral vira pagina
        if (this.events.onTap?.(e.clientX, e.clientY)) {
          this.lastTap = null;
          return;
        }
        // ampliado, o toque leve (parar a inercia, soltar um pan curto) nao pode pular de pagina
        if (!notZoomed || this.mode === 'strip') return;
        // tap na lateral vira pagina (terco do meio fica livre para o tooltip)
        const rect = this.stage.getBoundingClientRect();
        const third = (e.clientX - rect.left) / Math.max(rect.width, 1);
        if (third < 1 / 3 || third > 2 / 3) {
          // folhear rapido na borda nao pode virar duplo toque (zoom)
          this.lastTap = null;
          this.navigate((third < 1 / 3) === this.rtl ? 1 : -1);
        }
        return;
      }
      if (
        notZoomed &&
        this.mode !== 'strip' &&
        dt < SWIPE_MAX_MS &&
        Math.abs(dx) > SWIPE_MIN &&
        Math.abs(dx) > Math.abs(dy) * 1.5
      ) {
        // deslizar para a esquerda avanca em LTR e volta em RTL
        const forward = dx < 0 ? !this.rtl : this.rtl;
        this.velocity = { x: 0, y: 0 };
        this.navigate(forward ? 1 : -1);
        return;
      }
    }
    this.startInertia();
  };

  /** virar pagina por gesto: o app trata o fim do capitulo (proximo/anterior) */
  private navigate(dir: 1 | -1): void {
    if (this.events.onNavigate) this.events.onNavigate(dir);
    else if (dir > 0) this.next();
    else this.prev();
  }

  private startInertia(): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.y);
    if (speed < 0.25) return;
    let vx = this.velocity.x * 16;
    let vy = this.velocity.y * 16;
    const step = (): void => {
      vx *= 0.92;
      vy *= 0.92;
      if (Math.hypot(vx, vy) < 0.5) return this.stopInertia();
      this.panBy(vx, vy);
      this.inertia = requestAnimationFrame(step);
    };
    this.inertia = requestAnimationFrame(step);
  }

  private stopInertia(): void {
    if (this.inertia) cancelAnimationFrame(this.inertia);
    this.inertia = 0;
  }

  private onDoubleClick = (e: MouseEvent): void => {
    e.preventDefault();
    // touch/pen: o duplo toque manual (onPointerUp) ja' alternou; rodar de novo anulava o zoom
    if (this.lastPointerType !== 'mouse') return;
    this.toggleZoomAt(e.clientX, e.clientY);
  };

  /** duplo clique / duplo toque: 100% no ponto, ou de volta ao ajuste */
  private toggleZoomAt(x: number, y: number): void {
    // "no ajuste" e' o ajuste corrente (largura/altura/pagina), nao so' o 'page';
    // na tira o alvo e' largura — 'page' encolhia o capitulo e zerava a rolagem
    const atFit = this.fit !== 'free';
    if (atFit) this.zoomAt(1 / this.scale, x, y);
    else this.applyFit(this.mode === 'strip' ? 'width' : 'page', true);
  }

  // ---------- navegador (mini mapa) ----------

  private updateNavigator(): void {
    const { w, h } = this.stageSize();
    const cw = this.contentW * this.scale;
    const ch = this.contentH * this.scale;
    const overflow = cw > w + 2 || ch > h + 2;
    this.nav.hidden = !overflow;
    if (!overflow) return;

    const aspect = this.contentW / this.contentH;
    const navW = aspect >= 1 ? 160 : 160 * aspect;
    const navH = aspect >= 1 ? 160 / aspect : 160;
    this.nav.style.width = `${navW}px`;
    this.nav.style.height = `${navH}px`;

    this.navBox.style.left = `${(-this.tx / cw) * navW}px`;
    this.navBox.style.top = `${(-this.ty / ch) * navH}px`;
    this.navBox.style.width = `${Math.min((w / cw) * navW, navW)}px`;
    this.navBox.style.height = `${Math.min((h / ch) * navH, navH)}px`;
  }

  private onNavDrag = (e: PointerEvent): void => {
    e.preventDefault();
    const move = (ev: PointerEvent): void => {
      const rect = this.nav.getBoundingClientRect();
      const rx = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
      const ry = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
      const { w, h } = this.stageSize();
      this.tx = -(rx * this.contentW * this.scale - w / 2);
      this.ty = -(ry * this.contentH * this.scale - h / 2);
      this.apply();
    };
    move(e);
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------- navegacao ----------

  private visibleStripPage(): number {
    const mid = -this.ty / this.scale + this.stageSize().h / (2 * this.scale);
    let best = this.sheets[0]?.page ?? 0;
    for (const s of this.sheets) if (s.y <= mid) best = s.page;
    return best;
  }

  private spreadCount(): number {
    return this.mode === 'strip' ? 1 : Math.ceil((this.pages.length + this.spreadOffset()) / this.perSpread());
  }

  next(): boolean {
    if (this.mode === 'strip') {
      const before = this.ty;
      this.panBy(0, -this.stageSize().h * 0.9);
      return this.ty !== before;
    }
    if (this.spread + 1 >= this.spreadCount()) return false;
    this.spread++;
    this.build();
    return true;
  }

  prev(): boolean {
    if (this.mode === 'strip') {
      const before = this.ty;
      this.panBy(0, this.stageSize().h * 0.9);
      return this.ty !== before;
    }
    if (this.spread === 0) return false;
    this.spread--;
    this.build();
    return true;
  }

  goToPage(page: number): void {
    const p = clamp(page, 0, this.pages.length - 1);
    if (this.mode === 'strip') {
      const sheet = this.sheets.find((s) => s.page === p);
      if (sheet) {
        this.ty = -sheet.y * this.scale;
        this.apply();
      }
      return;
    }
    this.spread = this.spreadOf(p);
    this.build();
  }

  setMode(mode: ReadingMode): void {
    const page = this.currentPage;
    this.mode = mode;
    this.spread = this.spreadOf(page);
    // na tira a pagina atual vira rolagem; sem isto trocar de modo voltava ao topo
    if (mode === 'strip') this.stripStart = page > 0 ? page : undefined;
    this.build();
  }

  setRtl(rtl: boolean): void {
    this.rtl = rtl;
    this.relayout(true);
  }

  /** Paginas visiveis agora — e' nelas que o OCR roda. */
  visibleSheets(): { page: number; img: HTMLImageElement; ocr: HTMLCanvasElement }[] {
    if (this.mode !== 'strip') return this.sheets.map((s) => ({ page: s.page, img: s.img, ocr: s.ocr }));
    const { h } = this.stageSize();
    const top = -this.ty / this.scale;
    const bottom = top + h / this.scale;
    return this.sheets
      .filter((s) => s.y + s.h > top && s.y < bottom)
      .map((s) => ({ page: s.page, img: s.img, ocr: s.ocr }));
  }

  private preload(): void {
    const from = (this.pagesInSpread(this.spread).at(-1) ?? 0) + 1;
    for (const p of this.pages.slice(from, from + 3)) {
      const img = new Image();
      // precisa casar com o <img> do sheet: pre-carregar sem CORS deixa a resposta
      // no cache sem os cabecalhos e o canvas do OCR fica tainted depois
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = p.url;
    }
  }
}
