/** Conversa com a IA sobre a pagina aberta (painel lateral do leitor). */
import { explain, humanizeError } from './api.ts';
import { isAbortError } from './ocr.ts';
import { store } from './state.ts';
import { el } from './ui.ts';
import type { Reader } from './reader.ts';

type ReaderHost = Reader;

export function pushMessage(host: ReaderHost, role: 'user' | 'assistant', text: string): HTMLElement {
  const body = el('div', { class: 'ml-msg-body' }, text);
  host.chatLog.append(el('div', { class: `ml-msg is-${role}` }, body));
  host.chatLog.scrollTop = host.chatLog.scrollHeight;
  return body;
}

export async function ask(host: ReaderHost, question: string): Promise<void> {
  openChat(host);
  pushMessage(host, 'user', question);
  const bubble = pushMessage(host, 'assistant', '');
  const pageText = host.viewer
    .visibleSheets()
    .flatMap((s) => host.ocrCache.get(host.pageKey(s.page)) ?? [])
    .map((b) => b.pt || b.text)
    .filter(Boolean);

  // resposta longa sem como parar (ate' 120s de servidor): botao de parar por pergunta
  host.chatAbort?.abort();
  const abort = new AbortController();
  host.chatAbort = abort;
  const stop = el('button', { class: 'ml-btn ml-btn-ghost ml-btn-sm ml-chat-stop', 'aria-label': 'parar resposta', onclick: () => abort.abort() }, '■ parar');
  bubble.parentElement?.append(stop);

  let full = '';
  try {
    for await (const chunk of explain(
      {
        series: host.detail?.title,
        description: host.detail?.description,
        chapter: host.chapter?.number,
        pageText,
        question,
        history: host.history.slice(-6),
        provider: store.settings.aiProvider,
      },
      abort.signal,
    )) {
      full += chunk;
      bubble.textContent = full;
      host.chatLog.scrollTop = host.chatLog.scrollHeight;
    }
    host.history.push({ role: 'user', content: question }, { role: 'assistant', content: full });
    if (!full.trim()) bubble.textContent = '(o modelo devolveu vazio — confira o modelo e o limite de tokens no painel de IA)';
  } catch (err) {
    // o que ja' chegou vale: apagar a resposta parcial era pior que o erro
    const why = isAbortError(err) ? '' : `: ${humanizeError(err)}`;
    bubble.textContent = full ? `${full}\n\n(interrompido${why})` : `falhou${why || ': interrompido'}`;
  } finally {
    stop.remove();
    if (host.chatAbort === abort) host.chatAbort = undefined;
  }
}

export function buildChatInput(host: ReaderHost): HTMLElement {
  const input = el('textarea', { class: 'ml-chat-input', rows: '2', placeholder: 'pergunte sobre a cena, personagem, referencia...' });
  const send = (): void => {
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    void ask(host, q);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  return el(
    'div',
    { class: 'ml-chat-foot' },
    input,
    el('button', { class: 'ml-btn ml-btn-primary', onclick: send }, 'perguntar'),
    el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => void ask(host, 'Explique o que esta acontecendo nesta pagina.') }, 'explicar pagina'),
  );
}

export function openChat(host: ReaderHost): void {
  host.chat.classList.add('is-open');
  host.syncChatToViewport();
  window.visualViewport?.addEventListener('resize', host.syncChatToViewport);
}

export function closeChat(host: ReaderHost): void {
  host.chat.classList.remove('is-open');
  host.chat.style.height = '';
  window.visualViewport?.removeEventListener('resize', host.syncChatToViewport);
}
