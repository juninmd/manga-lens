/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import type { Detection } from './region-plan.ts';

export interface DetectRequest {
  id: number;
  modelUrl: string;
  /** RGBA 640x640 ja' esticado pela thread principal */
  rgba: ArrayBuffer;
  width: number;
  height: number;
}

export type DetectReply = { id: number; detections: Detection[] } | { id: number; error: string };

const SIDE = 640;
let session: Promise<ort.InferenceSession> | null = null;

function load(modelUrl: string): Promise<ort.InferenceSession> {
  // so' o .wasm vem do app (sem CDN): o carregador .mjs ja' esta' no bundle, e
  // passar um prefixo em vez do arquivo faria o ORT buscar um .mjs que nao existe
  ort.env.wasm.wasmPaths = { wasm: '/vendor/ort/ort-wasm-simd-threaded.wasm' };
  ort.env.wasm.numThreads = 1;
  session ??= (async () => {
    const res = await fetch(modelUrl);
    if (!res.ok) throw new Error(`detector indisponivel (${res.status}): ${await res.text().catch(() => '')}`);
    return await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
  })().catch((err: unknown) => {
    // falha (offline, sidecar subindo) nao pode ficar em cache: a proxima pagina tenta de novo
    session = null;
    throw err;
  });
  return session;
}

async function detect(req: DetectRequest): Promise<Detection[]> {
  const s = await load(req.modelUrl);
  const px = new Uint8ClampedArray(req.rgba);
  const plane = SIDE * SIDE;
  // RGB 0..1 em CHW, o formato de deploy do RT-DETR
  const data = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p++) {
    data[p] = px[p * 4]! / 255;
    data[plane + p] = px[p * 4 + 1]! / 255;
    data[plane * 2 + p] = px[p * 4 + 2]! / 255;
  }
  const out = await s.run({
    images: new ort.Tensor('float32', data, [1, 3, SIDE, SIDE]),
    orig_target_sizes: new ort.Tensor('int64', BigInt64Array.from([BigInt(req.width), BigInt(req.height)]), [1, 2]),
  });
  const labels = out.labels!.data as BigInt64Array;
  const boxes = out.boxes!.data as Float32Array;
  const scores = out.scores!.data as Float32Array;
  const found: Detection[] = [];
  // o modelo devolve 300 candidatos fixos; o corte fino por confianca fica com `planTargets`
  for (let i = 0; i < scores.length; i++) {
    const label = Number(labels[i]);
    if (label < 0 || label > 2 || scores[i]! < 0.3) continue;
    const [x0, y0, x1, y1] = [boxes[i * 4]!, boxes[i * 4 + 1]!, boxes[i * 4 + 2]!, boxes[i * 4 + 3]!];
    if (x1 <= x0 || y1 <= y0) continue;
    found.push({ label: label as 0 | 1 | 2, score: scores[i]!, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return found;
}

self.onmessage = (e: MessageEvent<DetectRequest>) => {
  const req = e.data;
  detect(req).then(
    (detections) => self.postMessage({ id: req.id, detections } satisfies DetectReply),
    (err: unknown) => self.postMessage({ id: req.id, error: (err as Error).message ?? String(err) } satisfies DetectReply),
  );
};
