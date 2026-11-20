/**
 * Lente "segure para espiar" (ideia do FrankYomik): a pagina fica como o autor
 * desenhou e, segurando o ponteiro parado por um instante, abre uma lupa redonda
 * com a traducao por baixo. Soltar fecha. Toque rapido continua virando a pagina
 * e arrastar continua movendo — a lupa so' abre se o ponteiro ficar parado.
 */

/** tempo parado ate' a lupa abrir; menos que isso ainda e' toque */
export const HOLD_MS = 200;
/** quanto o ponteiro pode tremer antes de virar arrasto */
export const HOLD_SLOP = 8;
export const LENS_ZOOMS = [1.5, 2, 3] as const;
const DIAMETER = 220;

export interface LensSheet {
  page: number;
  img: HTMLImageElement;
  ocr: HTMLCanvasElement;
}

export interface LensHost {
  enabled(): boolean;
  sheets(): LensSheet[];
  /** a pagina ja' tem traducao pintada? sem ela a lupa abre vazia (aro tracejado), nao quebrada */
  translated(page: number): boolean;
  /** a lupa assumiu o gesto: o visualizador tem de esquecer o arrasto/toque em andamento */
  cancelGesture(): void;
}

/**
 * Retangulo, em pixels da imagem original, que a lupa amplia em volta do ponto.
 * `rect` e' a caixa da folha na tela; `zoom` e' relativo ao tamanho exibido.
 */
export function lensSource(
  rect: { left: number; top: number; width: number; height: number },
  natural: { w: number; h: number },
  point: { x: number; y: number },
  zoom: number,
  diameter = DIAMETER,
): { sx: number; sy: number; size: number } {
  const perCss = natural.w / Math.max(rect.width, 1);
  const size = (diameter / zoom) * perCss;
  const nx = ((point.x - rect.left) / Math.max(rect.width, 1)) * natural.w;
  const ny = ((point.y - rect.top) / Math.max(rect.height, 1)) * natural.h;
  return { sx: nx - size / 2, sy: ny - size / 2, size };
}

/** Folha sob o ponto (na tela). */
export function sheetAt<T extends { img: HTMLImageElement }>(sheets: T[], x: number, y: number): T | undefined {
  return sheets.find((s) => {
    const r = s.img.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
}

export class Lens {
  private el: HTMLCanvasElement;
  private timer = 0;
  private start: { x: number; y: number; id: number } | null = null;
  private active: { id: number; type: string } | null = null;
  private zoomIndex = 1;
  private swallowClick = false;

  constructor(
    private stage: HTMLElement,
    private host: LensHost,
  ) {
    this.el = document.createElement('canvas');
    this.el.className = 'ml-peek';
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');
    document.body.append(this.el);
    // captura: roda antes do visualizador, que arrastaria a pagina enquanto a lupa esta' aberta
    stage.addEventListener('pointerdown', this.onDown, true);
    stage.addEventListener('pointermove', this.onMove, true);
    stage.addEventListener('pointerup', this.onUp, true);
    stage.addEventListener('pointercancel', this.onUp, true);
    stage.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    stage.addEventListener('click', this.onClick, true);
  }

  get zoom(): number {
    return LENS_ZOOMS[this.zoomIndex]!;
  }

  destroy(): void {
    this.cancelTimer();
    this.el.remove();
    this.stage.removeEventListener('pointerdown', this.onDown, true);
    this.stage.removeEventListener('pointermove', this.onMove, true);
    this.stage.removeEventListener('pointerup', this.onUp, true);
    this.stage.removeEventListener('pointercancel', this.onUp, true);
    this.stage.removeEventListener('wheel', this.onWheel, true);
    this.stage.removeEventListener('click', this.onClick, true);
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    this.start = null;
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.host.enabled() || e.button !== 0 || this.active) return;
    // segundo dedo: e' pinca, nao espiada
    if (this.start) {
      this.cancelTimer();
      return;
    }
    if ((e.target as Element | null)?.closest('button')) return;
    const { clientX: x, clientY: y, pointerId: id, pointerType: type } = e;
    if (!sheetAt(this.host.sheets(), x, y)) return;
    this.start = { x, y, id };
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (!this.start) return;
      this.start = null;
      this.active = { id, type };
      this.host.cancelGesture();
      this.el.hidden = false;
      this.draw(x, y);
    }, HOLD_MS);
  };

  private onMove = (e: PointerEvent): void => {
    if (this.active?.id === e.pointerId) {
      e.stopImmediatePropagation();
      e.preventDefault();
      this.draw(e.clientX, e.clientY);
      return;
    }
    if (this.start?.id === e.pointerId && Math.hypot(e.clientX - this.start.x, e.clientY - this.start.y) > HOLD_SLOP) this.cancelTimer();
  };

  private onUp = (e: PointerEvent): void => {
    if (this.start?.id === e.pointerId) this.cancelTimer();
    if (this.active?.id !== e.pointerId) return;
    e.stopImmediatePropagation();
    this.active = null;
    this.el.hidden = true;
    // o mouse solta e o navegador ainda manda um click: nao pode virar a pagina
    this.swallowClick = true;
    setTimeout(() => {
      this.swallowClick = false;
    }, 0);
  };

  private onClick = (e: MouseEvent): void => {
    if (!this.swallowClick) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  /** Roda com a lupa aberta troca o aumento (1.5x / 2x / 3x) em vez de dar zoom na pagina. */
  private onWheel = (e: WheelEvent): void => {
    if (!this.active) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.zoomIndex = Math.min(LENS_ZOOMS.length - 1, Math.max(0, this.zoomIndex + (e.deltaY < 0 ? 1 : -1)));
    this.draw(e.clientX, e.clientY);
  };

  private draw(x: number, y: number): void {
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(DIAMETER * dpr);
    if (this.el.width !== px) {
      this.el.width = px;
      this.el.height = px;
    }
    this.el.style.width = `${DIAMETER}px`;
    this.el.style.height = `${DIAMETER}px`;
    // no toque o dedo cobriria a lupa: ela sobe; no mouse fica centrada no cursor
    const lift = this.active?.type === 'touch' ? DIAMETER / 2 + 28 : 0;
    this.el.style.left = `${x - DIAMETER / 2}px`;
    this.el.style.top = `${y - DIAMETER / 2 - lift}px`;

    const ctx = this.el.getContext('2d')!;
    ctx.clearRect(0, 0, px, px);
    const sheet = sheetAt(this.host.sheets(), x, y);
    this.el.classList.toggle('is-empty', !sheet || !this.host.translated(sheet.page));
    if (!sheet) return;
    const r = sheet.img.getBoundingClientRect();
    const natural = { w: sheet.img.naturalWidth || 1, h: sheet.img.naturalHeight || 1 };
    const { sx, sy, size } = lensSource(r, natural, { x, y }, this.zoom);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sheet.img, sx, sy, size, size, 0, 0, px, px);
    // a camada de traducao tem o tamanho natural da pagina: mesmo recorte
    if (sheet.ocr.width) {
      const k = sheet.ocr.width / natural.w;
      ctx.drawImage(sheet.ocr, sx * k, sy * k, size * k, size * k, 0, 0, px, px);
    }
  }
}
