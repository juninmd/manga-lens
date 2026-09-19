import { api } from './base.ts';
import type { DetectReply, DetectRequest } from './detector-worker.ts';
import type { Detection } from './region-plan.ts';

/** Tamanho de entrada do RT-DETR: a pagina e' esticada (nao recortada), como no treino. */
const SIDE = 640;
/** worker travado (wasm que nao carrega) nao pode segurar a fila de OCR para sempre */
const TIMEOUT_MS = 60_000;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (d: Detection[]) => void; reject: (e: Error) => void }>();

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  worker?.terminate();
  worker = null;
}

/**
 * A inferencia (~0,7 s por pagina em WASM) roda num worker proprio: na thread
 * principal ela congelava zoom e arrasto a cada pagina da fila de traducao.
 */
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker('/detector-worker.js', { type: 'module' });
  worker.onmessage = (e: MessageEvent<DetectReply>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if ('error' in e.data) p.reject(new Error(e.data.error));
    else p.resolve(e.data.detections);
  };
  worker.onerror = (e) => failAll(new Error(`worker do detector caiu: ${e.message || 'erro desconhecido'}`));
  return worker;
}

/** Baloes e textos da pagina, em pixels da imagem original. */
export function detectText(img: HTMLImageElement): Promise<Detection[]> {
  const canvas = document.createElement('canvas');
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, SIDE, SIDE);
  const rgba = ctx.getImageData(0, 0, SIDE, SIDE).data.buffer;
  const id = ++seq;
  const req: DetectRequest = { id, modelUrl: new URL(api('/api/models/text-detector.onnx'), location.href).href, rgba, width: img.naturalWidth, height: img.naturalHeight };
  return new Promise<Detection[]>((resolve, reject) => {
    // o worker e' serial: se um pedido trava, os de tras travam junto — derruba tudo e cai na heuristica
    const timer = setTimeout(() => failAll(new Error('detector nao respondeu a tempo')), TIMEOUT_MS);
    pending.set(id, {
      resolve: (d) => {
        clearTimeout(timer);
        resolve(d);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    getWorker().postMessage(req, [rgba]);
  });
}
