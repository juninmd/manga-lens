# Plan — Rodada de qualidade competitiva (issue #5)

Research: `research.md` · Prototype: pulado (ver `skipped` em `loop-state.json`
— todas as decisões abertas eram técnicas/escopo, não direção de UI).

## Questionário — respostas

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Motor de OCR | **Benchmark mesmo com motores pesados** — o usuário quer números reais antes de decidir, sem se limitar a alternativas leves. |
| 2 | Inpainting | **Heurística barata** (sem rede neural) |
| 3 | Amplitude de escopo | **Só export/import de progresso** — UI de correção manual, tradução com contexto de página inteira e paridade de modo de leitura ficam no backlog desta rodada |
| 4 | Critério de qualidade | **Avaliação visual pelo próprio agente** (print antes/depois), sem gate manual do usuário |

## Abordagem escolhida vs. alternativas rejeitadas

- **Benchmark de OCR como script standalone** (`scripts/ocr-benchmark.mjs`),
  fora do bundle do client — mede Tesseract.js (baseline atual) contra
  `manga-ocr` (transformer específico de mangá, kha-white/manga-ocr, via
  Python) num pequeno conjunto de balões com transcrição manual (CER/WER).
  Rejeitado: rodar o benchmark dentro do client-side WASM diretamente —
  `manga-ocr` é PyTorch, não tem build WASM viável hoje; medir no Node/Python
  primeiro decide *se vale* portar antes de gastar esforço com
  onnxruntime-web.
- **Decisão de integração é condicionada ao resultado do benchmark**, não
  pré-decidida: se `manga-ocr` reduzir CER significativamente E houver um
  caminho de execução aceitável (sidecar, já que o Tauri já empacota um
  binário — `src-tauri/binaries`), abre-se um item de integração para
  próxima rodada (documentado, não implementado agora — integração de
  runtime novo no sidecar é mudança de arquitetura maior que cabe em plano
  próprio). Se o ganho não compensar o custo (bundle/latência/dependência
  Python), fica registrado como "testado, não compensa" — resultado tão
  válido quanto integrar.
- **Inpainting**: estende `eraseBalloon` (`src/client/ocr.ts:986`) com um
  preenchimento por difusão (Telea-like fast-marching simplificado) somente
  quando a região mascarada tiver variância de cor alta (textura/gradiente);
  mantém o caminho atual (recolorir sólido) para máscara de baixa variância
  — é mais barato e já funciona bem nesse caso, então **não** foi
  substituído por completo. Rejeitado: modelo ONNX de inpainting (LaMa) —
  resposta explícita do usuário (heurística barata).
- **Export/import**: JSON único cobrindo toda a `Store` de `state.ts`
  (settings, favorites, progress, read, bookmarks) com `version` e `exportedAt`,
  baixado via `Blob`/`URL.createObjectURL` e importado via `<input type=file>`.
  Rejeitado: formato binário tipo `.tachibk` — sem ganho real para um
  arquivo que já é pequeno (localStorage inteiro do app), JSON é inspecionável
  e não exige lib de serialização nova.

## Acceptance criteria (atualiza `research.md`)

- `bun run check` verde a cada passo.
- Benchmark de OCR produz um relatório (`ocr-benchmark.md` ou saída do
  script) com CER/WER e latência por motor testado, nas mesmas imagens.
- Inpainting: screenshot antes/depois em pelo menos uma página com balão
  texturizado/gradiente **e** uma com texto solto sobre arte (README já cita
  esse caso), avaliados visualmente pelo agente.
- Export gera um arquivo JSON válido; import desse mesmo arquivo restaura
  favoritos/progresso/marcadores/lidos idênticos (round-trip). Import de
  arquivo malformado não apaga o estado atual (falha segura).
- Item de OCR pesado: **não** precisa terminar integrado — precisa terminar
  com uma decisão registrada e evidência numérica.

## Passos

### 1 — Benchmark de OCR (spike, sem produção)
**Intenção**: números reais de precisão/latência do Tesseract.js atual vs.
`manga-ocr`, para decidir se compensa perseguir integração.
**Arquivos**: novo `scripts/ocr-benchmark.mjs` (roda Tesseract.js sobre um
recorte de balões de `.testlib/` + páginas já usadas em `ocr-probe.mjs`);
novo `scripts/ocr-benchmark-manga-ocr.py` (mesmo recorte via `manga-ocr`);
transcrição manual de referência em
`.workflow/5-competitive-quality/ocr-ground-truth.json` (10-20 balões).
**Verify**: `node scripts/ocr-benchmark.mjs` e
`python scripts/ocr-benchmark-manga-ocr.py` rodam sem erro e imprimem
CER/WER + tempo por balão.
**Resultado esperado**: tabela CER/WER/latência por motor registrada em
`.workflow/5-competitive-quality/ocr-benchmark.md`; decisão (integrar depois /
não compensa) anotada ali com a evidência.
**Não entra no bundle do app nem em `package.json`** — script standalone,
dependência Python isolada (ambiente já tem Python 3.14; `manga-ocr` via
`pip install --user`, não afeta o projeto Bun).

### 2 — Inpainting por difusão para máscara de alta variância
**Intenção**: fechar o gap de textura/gradiente/texto-fora-de-balão sem
modelo pesado.
**Arquivos**: `src/client/ocr.ts` (`eraseBalloon:986`) — nova função
`diffusionFill` (fast-marching simplificado a partir da borda da máscara
para dentro, usando os pixels da própria página ao redor do balão em vez de
uma cor plana); decide por variância de cor amostrada
(reusa `flatBackground:507`, que já mede isso) se usa o caminho atual
(sólido) ou o novo (difusão).
**Testes**: novo `tests/ocr-inpaint.test.ts` — variância baixa usa o caminho
sólido existente (comportamento inalterado, sem regressão); variância alta
aciona `diffusionFill` e o resultado não é uma cor única (verifica que pelo
menos 2 tons distintos aparecem no preenchimento, contra o 1 tom do caminho
atual).
**Verify**: `bun test tests/ocr-inpaint.test.ts` — novos casos verdes;
`bun run check` continua verde.
**Resultado esperado**: screenshot antes/depois (via `smoke:browser` ou
captura manual) mostrando textura reconstruída em vez de mancha lisa.

### 3 — Export/import de progresso
**Intenção**: remove o risco de perda total de progresso/favoritos/
marcadores ao trocar de máquina ou reinstalar.
**Arquivos**: `src/client/state.ts` — `exportStore(): string` (JSON com
`version`, `exportedAt`, e a `Store` inteira) e
`importStore(json: string): { ok: true } | { ok: false; error: string }`
(valida forma mínima antes de sobrescrever, falha sem tocar no estado atual
se o JSON for inválido); `src/client/catalog.ts` ou `ui.ts` — botão
"Exportar backup" (baixa `.json` via Blob) e "Importar backup" (`<input
type=file>`) num local de configurações já existente no catálogo.
**Testes**: novo `tests/state-export.test.ts` — round-trip completo
(export → import em store limpo → dados idênticos); import de JSON
malformado retorna `ok:false` e não altera `store` atual; import de versão
desconhecida é aceito com aviso (forward-compat mínima) em vez de rejeitado
— compatível com o único campo de versão hoje (`version: 1`).
**Verify**: `bun test tests/state-export.test.ts` — todos verdes;
`bun run check` continua verde.
**Resultado esperado**: arquivo baixado e re-importado deixa
favoritos/progresso/marcadores/lidos idênticos ao original.

### 4 — Fechamento da rodada
**Intenção**: registrar decisões e preparar entrega.
**Arquivos**: `README.md` (nova seção curta "Backup" documentando
export/import, se o passo 3 mudar comportamento visível ao usuário);
`.workflow/5-competitive-quality/progress.md`.
**Verify**: `bun run check` verde; `git status` limpo além do PR pretendido.
**Resultado esperado**: PR único cobrindo os passos 2 e 3 (o passo 1 é
spike, artefato fica em `.workflow/`, não em produção).

## Tests

- `tests/ocr-inpaint.test.ts` (novo) — variância baixa vs. alta, caminho
  sólido preservado, caminho difusão produz textura.
- `tests/state-export.test.ts` (novo) — round-trip, JSON malformado, versão
  desconhecida.
- Suíte existente (`bun run check`, 124 casos) precisa continuar verde —
  nenhum teste existente deve mudar de comportamento esperado.

## Rollback

- Passo 1: nenhum código de produção tocado — descartar os scripts de
  benchmark e o `ocr-ground-truth.json` não afeta o app.
- Passo 2: reverter o commit de `eraseBalloon`/`diffusionFill` restaura o
  comportamento atual (recolorir sólido sempre) — mudança isolada numa
  função pura.
- Passo 3: reverter o commit remove os botões e as funções `export/import`;
  `Store`/`localStorage` não muda de forma, sem migração a desfazer.

## Backlog (fora desta rodada)

- UI de correção manual do OCR/balão (rejeitada nesta rodada pelo usuário).
- Tradução com contexto de página inteira (rejeitada nesta rodada).
- Paridade de modo de leitura (webtoon contínuo, direção lembrada por série)
  (rejeitada nesta rodada).
- Integração de fato de um motor de OCR pesado (`manga-ocr` ou outro) no
  sidecar Tauri — decisão depende do resultado do passo 1; se favorável,
  vira o tema da próxima rodada (`phase-research` nova, não implementação
  ad-hoc aqui).
- Inpainting com modelo real (LaMa/AOT) — explicitamente adiado pelo usuário.
