export {};

/** Mostra a resposta CRUA do LLM para o prompt de traducao — o parser esconde o motivo da falha. */
const base = (process.env['AI_BASE_URL'] ?? 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const model = process.env['AI_MODEL'] ?? 'qwen128k:latest';

const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env['AI_API_KEY'] ?? 'ollama'}` },
  body: JSON.stringify({
    model,
    temperature: 0.2,
    max_tokens: Number(process.env['AI_MAX_TOKENS'] ?? 1200),
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          'Voce traduz baloes de manga/HQ para portugues do Brasil. O texto vem de OCR e pode ter ruido, ' +
          'letras trocadas ou quebras estranhas: corrija o obvio antes de traduzir. Mantenha registro, ' +
          'girias e onomatopeias naturais em pt-BR. Se um bloco for so ruido, devolva string vazia. ' +
          'Responda SOMENTE um array JSON [{"id":number,"pt":string}], sem comentarios.',
      },
      {
        role: 'user',
        content:
          'Obra: Naruto — capitulo 1\nIdioma de origem: ingles\n\nBlocos:\n' +
          JSON.stringify([
            { id: 0, text: "YOU DON'T HAVE WHAT IT TAKES" },
            { id: 1, text: 'NARUTO! GET BACK HERE!' },
            { id: 2, text: '|| ~~ 4 @' },
          ]),
      },
    ],
  }),
});

const data = (await res.json()) as {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: unknown;
};
console.log('modelo:', model, '| finish_reason:', data.choices?.[0]?.finish_reason);
console.log('usage:', JSON.stringify(data.usage));
console.log('--- conteudo cru ---');
console.log(JSON.stringify(data.choices?.[0]?.message?.content ?? ''));
