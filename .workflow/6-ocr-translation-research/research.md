# Research — OCR e tradução de capítulos/balões (papers, Hugging Face, Reddit)

Data: 2026-09-19. Complementa `.workflow/5-competitive-quality/{research,ocr-benchmark}.md`
(concorrentes GitHub + benchmark Tesseract × manga-ocr × EasyOCR) — aqui o foco é
literatura, modelos publicados e experiência de usuários.

## Diagnóstico do código atual

| Ponto | Onde | Gap |
|---|---|---|
| Unidade de tradução | `src/server/ai.ts:154` `translateBlocks`, `BATCH = 12` | página grande é quebrada em lotes sem ver o resto da página |
| Contexto | prompt só leva obra + capítulo | nenhum resumo de páginas anteriores, nenhum glossário de nomes/gênero |
| Ordem de leitura | blocos vão só com `id` + `text` | sem posição (bbox) → o LLM não sabe quem fala antes/depois |
| Imagem | só no caminho alternativo `visionTranslate` | o caminho OCR→LLM nunca vê a arte |
| Pronomes/gênero | prompt não trata | JP/KO omitem sujeito e gênero; pt-BR flexiona adjetivo → erro dobrado |
| Detecção | heurística de manchas brancas (`ocr.ts`) | falha em página colorida, HQ ocidental, texto fora de balão (README, "Limites") |
| OCR | Tesseract.js por recorte | CER EN 0.48 cru; JP horizontal ruim |

## 1. Papers

| Paper | Achado com número | Aplicação |
|---|---|---|
| **Context-Informed MT of Manga using Multimodal LLMs** — Lippmann et al., COLING 2025 · [arXiv 2411.02589](https://arxiv.org/abs/2411.02589) · [código](https://github.com/plippmann/multimodal-manga-translation) | Melhor configuração = **página inteira + imagem com balões numerados** (PBP-VIS-NUM). JA→EN xCOMET 0.758 (só texto) → 0.776 (com imagem); chrF 36.0 → 36.8. **Contexto longo piora**: volume inteiro caiu para 34.9 chrF. Resumo rolante (chain-of-density) manteve 35.9 com custo fixo de tokens | Traduzir por página; desenhar o `id` sobre cada balão numa miniatura e mandar junto; memória de capítulo = resumo curto, não histórico bruto |
| **Towards Fully Automated Manga Translation** — Hinami et al., AAAI 2021 · [arXiv 2012.14271](https://arxiv.org/abs/2012.14271) · dataset [OpenMantra](https://github.com/mantra-inc/open-mantra-dataset) | Contexto visual/de painel melhora MT vs frase isolada; OpenMantra tem bbox + ordem de leitura + JA/EN/ZH profissional | Conjunto de avaliação local da tradução (licença não explícita no README → só uso local, não commitar páginas) |
| **The Manga Whisperer (Magi)** — CVPR 2024 · [arXiv 2401.10224](https://arxiv.org/abs/2401.10224) · **Tails Tell Tales (Magi v2)** · [arXiv 2408.00298](https://arxiv.org/abs/2408.00298) | Painel + texto + personagem + diarização (quem fala), nomes persistentes no capítulo | Ideia de glossário de personagens e atribuição de fala. **Pesos com licença não comercial** ([card](https://huggingface.co/ragavsachdeva/magiv2)) → não embarcar |
| **MangaVQA & MangaLMM** — NeurIPS 2025 D&B · [arXiv 2505.20298](https://arxiv.org/abs/2505.20298) | Qwen2.5-VL ajustado em mangá supera GPT-4o em OCR de mangá | Confirma: VLM ajustado em mangá > OCR genérico |
| **PaddleOCR-VL** (0.9B) · [arXiv 2510.14528](https://arxiv.org/abs/2510.14528) · **VLMs em japonês vertical** · [arXiv 2511.15059](https://arxiv.org/abs/2511.15059) | MLLMs degradam em texto vertical; PaddleOCR-VL degrada menos que DeepSeek-OCR | Candidato de OCR "pesado" para JP vertical/estilizado |

## 2. Hugging Face (verificado nos cards)

### OCR
| Repo | O quê | Licença | Runtime | Nota |
|---|---|---|---|---|
| [JustANormalTinkerer/hayai-ocr-v2-onnx](https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2-onnx) ([card](https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2)) | ~150M (SigLIP2 + decoder), **JP/ZH/KO/EN**, recorte por balão | Apache-2.0 | ONNX encoder/decoder + `dynamic_quant` + fp16 | JMangaBench CER **3.2%** vs manga-ocr 4.7% vs PaddleOCR-VL 2.9%; ~10× mais rápido que PaddleOCR-VL. Arquitetura custom → loop de decodificação greedy próprio (referência: `inference_onnx.py` no repo) |
| [onnx-community/manga-ocr-base-ONNX](https://huggingface.co/onnx-community/manga-ocr-base-ONNX) | manga-ocr (kha-white) em ONNX, 4 quantizações | Apache-2.0 | **transformers.js**: `pipeline('image-to-text', …)` | Caminho de menor esforço para JP. Reddit: fraco fora de texto curto preto-no-branco |
| [jzhang533/PaddleOCR-VL-For-Manga](https://huggingface.co/jzhang533/PaddleOCR-VL-For-Manga) | PaddleOCR-VL ajustado em Manga109-s + 1.5M sintéticos | Apache-2.0 | transformers (1B, BF16) | 70% frase exata vs 27% do base. Pesado para CPU |
| [onnx-community/Florence-2-base-ft](https://huggingface.co/onnx-community/Florence-2-base-ft) | OCR genérico | MIT | transformers.js | Candidato para EN/HQ ocidental, a medir |

### Detecção
| Repo | O quê | Licença | Nota |
|---|---|---|---|
| [ogkalu/comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector) | RT-DETR-v2, classes `bubble` / `text_bubble` / **`text_free`**; ~11k páginas de mangá, webtoon, manhua e HQ ocidental | Apache-2.0 | Ataca exatamente os limites do README. Usado por comic-translate e Koharu |
| [mayocream/comic-text-detector-onnx](https://huggingface.co/mayocream/comic-text-detector-onnx) | comic-text-detector em ONNX pronto | Apache-2.0 (treinado em Manga109-s: conferir termos antes de distribuir) | Alternativa sem passo de exportação |
| ogkalu/comic-speech-bubble-detector-yolov8m | YOLOv8 | pesos Apache, **runtime Ultralytics AGPL** | Evitar o runtime; só se exportar para ONNX |

### Inpainting
[Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX) (Apache-2.0, entrada fixa 512×512). Reddit: LaMa é fraca fora de fundo uniforme; quem quer qualidade usa modelo de edição (FLUX.2), caro demais aqui. Prioridade baixa: o `diffuseFill` atual já cobre balão liso.

## 3. Reddit (lido via RSS; comentários de 13 threads)

**Modelos de tradução (2026)**
- Consenso em [best local model for Japanese translation right now? (set/2026)](https://www.reddit.com/r/LocalLLaMA/comments/1wfpvw5/best_local_model_for_japanese_translation_right/) e [Gemma 4 is great at real-time JP-EN (abr/2026)](https://www.reddit.com/r/LocalLLaMA/comments/1sbiqx3/gemma_4_is_great_at_realtime_japanese_english/): **família Gemma 4** lidera JP↔EN local (26B-A4B QAT rápido; 31B melhor; E4B para pouca VRAM). Qwen é criticado por japonês "de falante de chinês". Na nuvem, DeepSeek é citado como o melhor custo-qualidade.
- Gemma 4 26B > Sugoi 14B Ultra > vntl-llama3-8b (mesma thread). TranslateGemma erra mais pronome e ignora instrução de marcar o falante.
- Modelos especializados (Sugoi, VNTL, CAT-Translate, PLaMo 2 Translate, LFM2-ENJP, Hy-MT2) são **JA↔EN apenas** → não servem para pt-BR direto. Para pt-BR fica o generalista multilíngue (Gemma 4) ou o pivô JA→EN→PT, que precisa ser medido.
- Truques repetidos: **extrair nomes próprios numa tabela e transliterar, não traduzir**; glossário de termos construído ao longo do texto; limitar contexto (~32k) e fazer chunks; reasoning ligado ajuda em casos difíceis; temperatura 0.7–1 soa menos "MT" que 0 (a thread é EN→RU; vale medir).
- [Fine-Tuning Translation Model (jan/2026)](https://www.reddit.com/r/LocalLLaMA/comments/1q9wg6p/finetuning_translation_model/): antes de fine-tuning, **few-shot "literal vs natural"** no prompt.

**Falhas que usuários odeiam**
- Gênero errado ou inconsistente em manhwa: KO/JP não marcam o gênero, e o MTL "chuta" diferente a cada balão ([r/manhwa, dez/2025](https://www.reddit.com/r/manhwa/comments/1pv8xqm/nano_machine_whats_with_gender_translation_lately/)). "Pôr o capítulo inteiro no ChatGPT dá resultado melhor" → contexto e consistência importam mais que o modelo.
- Texto que não cabe no balão ([Local Automatic Translator for manga, fev/2026](https://www.reddit.com/r/LocalLLaMA/comments/1r3e4gf/local_automatic_translator_for_manga/)). O MangaLens já ajusta o corpo por busca binária.
- **OCR em loop** (ex.: `●●●…`) estoura tokens e trava o LLM. No Koharu, trocar o detector pelo RT-DETR do ogkalu resolveu ([thread Koharu, abr/2026](https://www.reddit.com/r/LocalLLaMA/comments/1sslwjv/local_manga_translator_with_llm_buildin_written/)).
- Koharu (Rust, MIT/Apache) traduz **só por página, sem imagem**, e tem issue aberta para contexto multipágina. Ninguém no ecossistema faz "página + imagem numerada + memória do capítulo" → é um diferencial possível.

**OCR**
- [hayai-ocr-v2 (ago/2026)](https://www.reddit.com/r/LocalLLaMA/comments/1vlhjb3/cjk_mangamanhwamanhua_150m_ocr_model_hayaiocrv2/): usuários relatam bom resultado em fundo complexo.
- PaddleOCR-VL-1.5 é o padrão do Koharu, "claramente acima" em texto longo, fonte estranha e baixo contraste; manga-ocr só vai bem em texto curto e limpo (várias threads).

## 4. Recomendações priorizadas (impacto ÷ esforço)

### Fase 1 — tradução, só `src/server/ai.ts` + payload do cliente (baixo esforço, maior impacto)
1. **Página como unidade**: um único pedido por página (lote de 12 só como teto de segurança, com os balões anteriores da página como contexto).
2. **Ordem e posição**: enviar `bbox` normalizada e ordenar pela direção de leitura (RTL em mangá, LTR em HQ, que o leitor já conhece).
3. **Memória do capítulo** (cache por `série`): glossário `{nome original → forma pt-BR, gênero, tratamento}` + resumo rolante de ≤150 palavras, atualizados pela fila em segundo plano. Isso segue o paper: o custo fica fixo, e histórico bruto piora a tradução.
4. **Regra de gênero no prompt**: usar o glossário; se desconhecido, construção neutra em pt-BR e nunca alternar entre balões.
5. **Few-shot literal→natural** em pt-BR (2–3 pares) e avaliar temperatura 0.2 × 0.5.
6. **Guarda de entrada**: colapsar repetição (`/(.)\1{4,}/`) e limitar tamanho por bloco antes do LLM.
7. **Imagem numerada opcional** (quando há `visionModel`): miniatura ~1024px com o `id` desenhado sobre cada balão, no mesmo pedido.
8. **Default do Ollama**: `qwen2.5:7b-instruct` está defasado. Testar Gemma 4 (E4B em pouca VRAM, 26B-A4B com 24 GB). As tags exatas no Ollama ainda não foram conferidas.

### Fase 2 — detecção (médio)
9. Spike do **RT-DETR `comic-text-and-bubble-detector`** em ONNX via `onnxruntime-web` (WebGPU→WASM) no WebView2, para manter o OCR no cliente. A heurística fica como fallback e continua gerando a máscara de letreiramento dentro da caixa detectada. `text_free` cobre SFX e texto fora de balão.

### Fase 3 — OCR (médio)
10. Spike com **hayai-ocr-v2-onnx (quantizado)** e **manga-ocr-base-ONNX** contra o Tesseract, reusando `scripts/ocr-benchmark.mjs` e os gabaritos de `.workflow/5-competitive-quality/`. Critério: CER e latência por recorte na CPU. O hayai cobre EN, então medir também o CER EN (hoje 0.48).
11. Gate de confiança: resultado do Tesseract com confiança baixa não segue para o LLM.

### Fase 4 — inpainting (baixo impacto no objetivo)
12. LaMa-ONNX só para texto sobre arte (`text_free`), mantendo o `diffuseFill` em balão liso.

### Medição (vale para todas as fases)
- OCR: CER nos gabaritos existentes, antes e depois.
- Tradução: OpenMantra JA→EN com chrF para comparar prompt × prompt. Não há referência pt-BR, então medir consistência de nome e gênero entre páginas com um script determinístico sobre o glossário, mais uma revisão manual de 1 capítulo.

## Riscos e perguntas em aberto
- `onnxruntime-web`/WebGPU no WebView2 e o tamanho dos modelos no bundle ou no cache (download sob demanda, como o `.traineddata`) ainda não foram medidos: precisam de spike.
- Pivô JA→EN→PT × direto para PT: sem dado público para pt-BR. Medir.
- Licenças: Magi (não comercial) está fora. Manga109/OpenMantra servem só para avaliação local, sem redistribuir imagens.
- Tags de modelos Gemma 4 e Qwen 3.x citadas no Reddit ainda não foram verificadas nos registries.
