# Benchmark de OCR — spike (issue #5, plano passo 1)

Scripts: `scripts/ocr-benchmark.mjs` (Tesseract.js — eng/jpn/jpn_vert) e
`scripts/ocr-benchmark-manga-ocr.py` (manga-ocr + EasyOCR). Dados de teste e
gabarito em `.workflow/5-competitive-quality/{crops,crops-jp,ocr-ground-truth*.json}`.

**Metodologia**: CER (character error rate, distância de Levenshtein a nível
de caractere / tamanho do texto de referência) sobre recortes individuais —
não a página inteira — porque é assim que o pipeline atual consome cada balão
(`src/client/ocr.ts:644 recognizePage` recorta por região antes de reconhecer).

**Limite conhecido**: os recortes usados aqui são **crus** — sem o
pré-processamento que o app já aplica em produção (`preprocess:150`: 2×
upscale, escala de cinza, contraste). Isso deixa os números absolutos de
Tesseract piores que em produção; a comparação **relativa** entre motores
sob a mesma entrada continua válida.

## Inglês (páginas reais — Naruto cap. 1, mangapill)

| Motor | CER médio | Latência/item | Custo de infra |
|---|---|---|---|
| **Tesseract.js eng** (atual, PSM 6, cru) | 0.484 | 82 ms | já embutido, WASM no browser |
| **EasyOCR** (deep learning, CPU) | 0.232 | 2190 ms | Python + PyTorch (~700 MB), sem build WASM |

EasyOCR reduz o CER pela metade, mas é **27× mais lento** e não tem caminho
de execução client-side (nem no bundle do browser, nem embarcável no sidecar
Rust sem rodar um runtime Python inteiro). Boa parte do gap também é
explicada pelo recorte cru — o pipeline real já ganha contraste/upscale que
o Tesseract sozinho não tem aqui.

**Decisão**: não compensa para esta rodada — custo de infraestrutura
(dependência Python pesada, sem caminho para o browser/sidecar) maior que o
ganho, considerando que o pré-processamento de produção já reduz parte do
gap. Registrado como "testado, não compensa agora".

## Japonês (sintético — MS Gothic, `.testlib` não tem página JP real)

| Motor | CER médio | Latência/item |
|---|---|---|
| Tesseract.js **jpn** (horizontal, PSM 6) | 0.559 | 43 ms |
| Tesseract.js **jpn_vert** (vertical, PSM 5) | 0.000 | 41 ms |
| **manga-ocr** (kha-white, transformer JP) — horizontal e vertical | **0.000** | 976 ms (CPU) |

O CER do Tesseract `jpn` horizontal é inflado por um artefato conhecido: ele
insere espaço entre cada caractere japonês reconhecido (`お は よう ご ざい
ます` em vez de `おはようございます`) — o `cleanOcrText` do pipeline
(`ocr.ts:558`) provavelmente já limpa parte disso em produção, então o CER
real de produção é menor que 0.559, mas o problema de fundo (Tesseract não
entende que japonês não usa espaço) continua. Já o `jpn_vert` saiu perfeito
nos dois casos sintéticos — mas o conjunto de teste é pequeno e limpo demais
para generalizar.

**manga-ocr acerta 100% nos dois estilos** (horizontal e vertical, limpo e
com fundo texturizado) — é a confirmação direta do que todo o prior art
(`research.md`) aponta: um modelo *treinado em manga* bate um OCR genérico
de forma consistente, não marginal.

**Decisão**: **compensa investigar integração**, mas não nesta rodada —
`manga-ocr` é PyTorch (976 ms/item em CPU, aceitável para a fila de tradução
em segundo plano já existente, mas sem build WASM oficial). O caminho viável
é um export ONNX (existem exports comunitários do `kha-white/manga-ocr` —
citados em `research.md`) rodando no sidecar Rust/Tauri que o app já
empacota (`src-tauri/binaries`), **não** no bundle do browser. Isso é
mudança de arquitetura (novo runtime de inferência no sidecar) maior que o
escopo desta rodada — vira o tema de uma próxima `phase-research` dedicada,
com este benchmark como evidência de que o ganho é real e vale o
investimento.

## Conclusão para o plano

- Nenhuma integração de motor de OCR novo nesta rodada (confirma a decisão
  do questionário: "benchmark mesmo que pesado", sem compromisso prévio de
  integrar).
- Evidência registrada para decidir a próxima rodada: **japonês via
  manga-ocr é o lever de qualidade real**; inglês via EasyOCR não compensa o
  custo de infraestrutura hoje.
- Ambiente Python usado (`manga-ocr`, `easyocr`, `torch`) é local ao
  benchmark — não entra em `package.json`/`pyproject`, não é dependência do
  produto.
