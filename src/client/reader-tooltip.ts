/** Dica do balao (original x traducao) e a correcao manual do texto. */
import { edits, MAX_EDIT_CHARS, type EditScope } from './edits.ts';
import type { OcrBlock } from './ocr.ts';
import { normalizeSame } from './reader-util.ts';
import { store } from './state.ts';
import { el, toast } from './ui.ts';
import type { Reader } from './reader.ts';

type ReaderHost = Reader;

/** Tempo para o mouse ir do balao ate' a dica sem ela sumir. */
const TOOLTIP_GRACE_MS = 320;

export function checkBalloonHover(host: ReaderHost, clientX: number, clientY: number): void {
  // fixado (para editar), o tooltip nao segue o mouse nem fecha sozinho
  if (host.tooltipPinned) return;
  // arrastar a pagina e' intencao de mover, nao de ler: fecha na hora
  if (host.viewer.isDragging()) {
    hideTooltip(host);
    return;
  }
  const hit = findBlockAt(host, clientX, clientY);
  if (!hit) {
    // ir com o mouse ate' o tooltip para ler o original nao pode fecha-lo
    if (!overTooltip(host, clientX, clientY)) scheduleHideTooltip(host);
    return;
  }
  showTooltip(host, hit.block, clientX, clientY, hit.sheet);
}

/** O proprio tooltip conta como alvo de hover — ele e' transparente ao ponteiro. */
export function overTooltip(host: ReaderHost, clientX: number, clientY: number): boolean {
  if (host.tooltipEl.hidden) return false;
  const pad = 12;
  const r = host.tooltipEl.getBoundingClientRect();
  return clientX >= r.left - pad && clientX <= r.right + pad && clientY >= r.top - pad && clientY <= r.bottom + pad;
}

export function findBlockAt(host: ReaderHost, clientX: number, clientY: number): { block: OcrBlock; sheet: { page: number; el: HTMLDivElement; x: number; y: number; w: number; h: number } } | null {
  const stageRect = host.stage.getBoundingClientRect();
  const stageX = clientX - stageRect.left;
  const stageY = clientY - stageRect.top;

  const transform = host.viewer.getTransform();
  const canvasX = (stageX - transform.tx) / transform.scale;
  const canvasY = (stageY - transform.ty) / transform.scale;

  for (const sheet of host.viewer.getSheets()) {
    if (canvasX >= sheet.x && canvasX <= sheet.x + sheet.w && canvasY >= sheet.y && canvasY <= sheet.y + sheet.h) {
      const imgX = canvasX - sheet.x;
      const imgY = canvasY - sheet.y;
      const blocks = host.ocrCache.get(host.pageKey(sheet.page));
      if (!blocks?.length) continue;

      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (imgX >= b.x && imgX <= b.x + b.w && imgY >= b.y && imgY <= b.y + b.h) {
          return { block: b, sheet };
        }
      }
    }
  }
  return null;
}

/**
 * O tooltip ancora no balao, nao no ponteiro: enquanto o mouse anda dentro do
 * mesmo balao ele fica parado. Antes ele era remontado e reposicionado a cada
 * `pointermove`, entao fugia do cursor e piscava — e quem tentasse ir ate' ele
 * para ler o original saia da caixa do balao e o perdia.
 */
export function showTooltip(host: ReaderHost, block: OcrBlock, clientX: number, clientY: number, sheet: { el: HTMLDivElement; page?: number }, pin = false): void {
  const origText = block.text?.trim();
  if (!origText) {
    hideTooltip(host);
    return;
  }
  clearTimeout(host.tooltipHideTimer);
  const sig = `${block.id}|${origText}|${block.pt ?? ''}|${pin ? 'fix' : 'hover'}`;
  // mesmo balao e mesmo texto: nada a remontar, e mexer na posicao so' atrapalharia
  if (!host.tooltipEl.hidden && sig === host.tooltipSig) return;
  host.tooltipSig = sig;
  host.tooltipPinned = pin;
  // fixado ele recebe clique (editar, fechar); solto continua transparente ao ponteiro
  host.tooltipEl.classList.toggle('is-pinned', pin);

  host.highlightBox.style.left = `${block.x}px`;
  host.highlightBox.style.top = `${block.y}px`;
  host.highlightBox.style.width = `${block.w}px`;
  host.highlightBox.style.height = `${block.h}px`;
  if (host.highlightBox.parentElement !== sheet.el) {
    sheet.el.append(host.highlightBox);
  }
  host.highlightBox.hidden = false;

  host.tooltipEl.innerHTML = '';
  const header = el(
    'div',
    { class: 'ml-tooltip-header' },
    el('span', { class: 'ml-tooltip-tag' }, block.edited ? 'Original · editado por voce' : 'Texto original'),
    block.confidence ? el('span', { class: 'ml-tooltip-confidence' }, `${Math.round(block.confidence)}% conf.`) : el('span', {}),
    pin
      ? el('button', { class: 'ml-btn ml-btn-ghost ml-btn-sm', 'aria-label': 'fechar', onclick: () => hideTooltip(host) }, '✕')
      : null,
  );
  const origEl = el('div', { class: 'ml-tooltip-original' }, origText);
  host.tooltipEl.append(header, origEl);

  if (block.pt?.trim() && block.pt.trim() !== origText) {
    const transEl = el(
      'div',
      { class: 'ml-tooltip-translated' },
      el('span', { class: 'ml-tooltip-subtag' }, 'Traducao:'),
      block.pt.trim(),
    );
    host.tooltipEl.append(transEl);
  }
  if (pin && sheet.page !== undefined) host.tooltipEl.append(editControls(host, block, sheet.page));

  host.tooltipEl.hidden = false;

  const pad = 16;
  const ttW = host.tooltipEl.offsetWidth || 240;
  const ttH = host.tooltipEl.offsetHeight || 80;
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;

  let left = clientX + 16;
  let top = clientY + 16;

  if (left + ttW > vpW - pad) {
    left = Math.max(pad, clientX - ttW - 16);
  }
  if (top + ttH > vpH - pad) {
    top = Math.max(pad, clientY - ttH - 16);
  }

  host.tooltipEl.style.left = `${left}px`;
  host.tooltipEl.style.top = `${top}px`;
}

/** Onde a correcao manual vale: obra, capitulo, pagina e idioma de chegada. */
export function editScope(host: ReaderHost, page: number, chapterId = host.chapter?.id): EditScope | null {
  if (!host.detail || !chapterId) return null;
  return { provider: host.detail.provider, seriesId: host.detail.id, chapterId, page, target: store.settings.targetLang };
}

/**
 * Corrigir a mao a traducao de um balao. A IA erra nome, piada e tom, e a unica
 * saida era retraduzir a pagina inteira torcendo por sorte. A correcao fica
 * guardada no aparelho e volta a ser aplicada sempre que a pagina e' traduzida
 * de novo; texto vazio deixa o balao original na arte.
 */
export function editControls(host: ReaderHost, block: OcrBlock, page: number): HTMLElement {
  const scope = editScope(host, page);
  const box = el('div', { class: 'ml-tooltip-edit' });
  if (!scope) return box;
  const apply = (pt: string | undefined): void => {
    if (pt === undefined) edits.remove(scope, block.text);
    else edits.set(scope, block.text, pt);
    // a pagina em cache recebe a correcao na hora; sem isso so' valeria na proxima traducao
    for (const kind of ['t', 'v'] as const) {
      const key = host.pageKey(page, host.chapter?.id, kind);
      const blocks = host.ocrCache.get(key);
      if (!blocks) continue;
      host.ocrCache.set(
        key,
        blocks.map((b) => (normalizeSame(b.text, block.text) ? { ...b, pt: pt ?? b.pt, edited: pt !== undefined } : b)),
      );
    }
    hideTooltip(host);
    host.paintOverlays();
    toast(pt === undefined ? 'correcao removida — vale a traducao automatica a partir da proxima traducao' : pt ? 'traducao corrigida' : 'balao mantido no original');
  };
  const start = el('button', { class: 'ml-btn ml-btn-sm', type: 'button', title: 'Corrigir a traducao deste balao (fica guardada neste aparelho)' }, '✎ editar traducao');
  start.addEventListener('click', (e) => {
    e.stopPropagation();
    const area = el('textarea', { class: 'ml-input ml-tooltip-textarea', rows: '3', maxlength: String(MAX_EDIT_CHARS), 'aria-label': 'Traducao do balao' });
    area.value = block.pt ?? '';
    const save = el('button', { class: 'ml-btn ml-btn-sm ml-btn-action-primary', type: 'button' }, 'salvar');
    save.addEventListener('click', (ev) => {
      ev.stopPropagation();
      apply(area.value);
    });
    const cancel = el('button', { class: 'ml-btn ml-btn-sm ml-btn-ghost', type: 'button' }, 'cancelar');
    cancel.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideTooltip(host);
    });
    const reset = block.edited ? el('button', { class: 'ml-btn ml-btn-sm ml-btn-ghost', type: 'button', title: 'Esquece a correcao e volta a usar a traducao automatica' }, 'desfazer correcao') : null;
    reset?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      apply(undefined);
    });
    area.addEventListener('keydown', (ev) => {
      // Ctrl+Enter salva; Esc cancela sem fechar o leitor
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        apply(area.value);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        hideTooltip(host);
      }
    });
    box.replaceChildren(
      area,
      el('span', { class: 'ml-tooltip-hint' }, 'vazio = deixa o balao original · Ctrl+Enter salva'),
      el('div', { class: 'ml-tooltip-actions' }, save, cancel, reset),
    );
    area.focus();
    area.select();
  });
  box.append(start);
  return box;
}

/**
 * Fecha depois de uma carencia curta. Sair da caixa do balao por um pixel, ou
 * atravessar o vao entre dois baloes, nao e' intencao de fechar; ir com o mouse
 * ate' o tooltip para ler o original muito menos.
 */
export function scheduleHideTooltip(host: ReaderHost): void {
  if (host.tooltipPinned) return;
  clearTimeout(host.tooltipHideTimer);
  host.tooltipHideTimer = window.setTimeout(() => hideTooltip(host), TOOLTIP_GRACE_MS);
}

/** Fecha agora: zoom, arrasto, virar pagina e sair do leitor invalidam a ancora. */
export function hideTooltip(host: ReaderHost): void {
  clearTimeout(host.tooltipHideTimer);
  host.tooltipPinned = false;
  host.tooltipSig = '';
  host.tooltipEl.hidden = true;
  host.highlightBox.hidden = true;
}
