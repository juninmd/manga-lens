type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriWindow {
  __TAURI__?: { core?: { invoke: Invoke } };
  __TAURI_INTERNALS__?: { invoke: Invoke };
}

/**
 * No navegador o servidor e' a propria origem. No app Tauri o front vem do bundle
 * e a API roda num sidecar em porta livre, resolvida em runtime pelo comando
 * `api_port`.
 *
 * Nao da' para detectar pelo protocolo: no Windows o Tauri v2 serve o app em
 * `http://tauri.localhost`, entao o teste tem que ser pela presenca do bridge.
 */
let apiBase = '';

const tauri = (): TauriWindow => window as unknown as TauriWindow;

export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && Boolean(tauri().__TAURI_INTERNALS__ ?? tauri().__TAURI__);

export async function resolveApiBase(): Promise<string> {
  if (!isDesktop()) return '';
  const invoke = tauri().__TAURI__?.core?.invoke ?? tauri().__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error('bridge do Tauri indisponivel: nao consegui achar a porta da API');
  const port = await invoke<number>('api_port');
  apiBase = `http://127.0.0.1:${port}`;
  return apiBase;
}

export const api = (path: string): string => apiBase + path;

/**
 * O sidecar pode demorar a escutar (binario Bun + init dos providers): o
 * primeiro fetch do catalogo caia em "servidor indisponivel" e abas vazias.
 * Espera ate' `maxMs` pelo /api/providers; resolve true quando respondeu.
 */
export async function waitForApi(maxMs = 12_000, onTick?: (elapsedMs: number) => void): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    const elapsed = performance.now() - start;
    onTick?.(elapsed);
    try {
      const res = await fetch(api('/api/providers'), { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      /* ainda subindo */
    }
    if (performance.now() - start > maxMs) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}
