# Research — Rodada de qualidade competitiva (issue #5)

## Goal

Elevar a qualidade do MangaLens a um nível absoluto, comparando com concorrentes
em sites e repositórios GitHub — leitores de mangá/HQ (Tachiyomi/Mihon,
Suwayomi, Komga/Kavita) e ferramentas de OCR+tradução de quadrinhos
(BallonsTranslator, comic-translate, manga-image-translator) — e fechar as
lacunas mais relevantes.

## Non-goals

- Reescrever a arquitetura server+client atual (Bun/Hono + Tauri) por outra
  stack — os concorrentes servem de referência de *funcionalidade e técnica*,
  não de framework a copiar.
- Adotar modelos de ML pesados (LAMA/AOT/RT-DETR) que exigem GPU/backend
  nativo nesta rodada — o app roda 100% client-side hoje (Tesseract WASM no
  browser); qualquer modelo novo precisa caber nesse orçamento ou virar item
  de pesquisa à parte, não implementação direta.
- Conta de usuário / backend multiusuário (Komga/Kavita têm login
  multiusuário) — fora de escopo: MangaLens é app de usuário único, local-first
  (`README.md`: "Tudo vive no localStorage do app — nada sai da máquina").
- Ecossistema de extensões de terceiros instaláveis (Mihon/Suwayomi) — fora de
  escopo desta rodada; o padrão atual de "um arquivo por provider" já é
  citado como intencional em `.workflow/1-performance-uiux-providers/plan.md`.

## Acceptance criteria (provisório — `plan.md` decide o final)

- Cada item entregue tem antes/depois observável (nota de qualidade OCR,
  screenshot do letreiramento, ou teste automatizado novo/alterado).
- `bun run check` (lint + typecheck + test) continua verde a cada entrega.
- Nenhuma regressão nos fluxos já cobertos por `tests/*.test.ts` e
  `scripts/smoke.ts` / `scripts/browser-smoke.mjs`.
- Progresso de leitura/favoritos/marcadores continua funcionando sem exigir
  conta ou serviço externo (a menos que uma opção *adicional* de export/sync
  seja explicitamente aprovada no plano).

## Codebase map

**Server** (`src/server/`, Bun + Hono):
- `index.ts` (397 linhas) — rotas HTTP: `/api/providers`, `/api/search`,
  `/api/series`, `/api/img` (proxy assinado), `/api/ocr/translate`,
  `/api/ai/*`.
- `providers/index.ts:24` `getProvider`, `:93` `searchAll` — registro
  hardcoded de providers (array), fan-out paralelo com merge/dedupe
  (`:45 titleKey`, `:66 mergeDuplicates`).
- `providers/{mangadex,weebcentral,mangapill,madara,archive,local}.ts` — um
  scraper/parser por fonte, mesma interface `Provider` (`providers/types.ts`).
- `ai.ts` (393 linhas) — multi-provider via Vercel AI SDK
  (`getLanguageModel:34`, `translateBlocks:154`, `visionTranslate:212`,
  `explainStream:257`); troca de provider em runtime (`invalidateProvider:336`).
- `translators.ts` — motores sem IA (Google/MyMemory) como fallback.
- `sign.ts` — HMAC nas URLs de imagem; `cache.ts` — cache de resposta em disco.

**Client** (`src/client/`, sem framework, bundle Bun):
- `ocr.ts` (1060 linhas) — pipeline completo client-side:
  `detectBalloons:285` (componentes conexos, filtro por área/preenchimento),
  pool de workers Tesseract (`getPool:113`, `evictLru:90`), `recognizePage:644`,
  `translateBlocks:719` (server), letreiramento: `eraseBalloon:986` (repinta
  o *interior da máscara* com a cor amostrada do balão — **não** é
  inpainting real de conteúdo; funciona porque o interior de um balão
  normal é uma cor quase sólida, mas falha em texto solto sobre arte
  (o próprio README, seção OCR, cita "le tambem o texto que nao mora em
  balao" como recurso — nesse caso o "background" reamostrado não é plano),
  `layoutText:891` + `fitPrefix:820`/`greedyWrap:843` (quebra de linha e
  autoescala de fonte por busca binária, já *é* shape-aware via `SHAPE_INSET`
  e máscara erodida).
- `viewer.ts` (548 linhas) — zoom/pan estilo Picasa, navegador em miniatura.
- `reader.ts` (1151 linhas) — orquestra página/capítulo, fila de tradução
  em segundo plano, atalhos de teclado, modos página/dupla/tira.
- `state.ts` — progresso/favoritos/marcadores só em `localStorage`
  (`saveProgress:154`, `toggleBookmark:235`, `markUpTo:220`); **sem
  export/import, sem sync entre dispositivos**.
- `catalog.ts` (1259 linhas) — abas por tipo de conteúdo (mangá/HQ/livro,
  adicionadas na rodada anterior, issue #1).

**Testes**: 13 arquivos em `tests/`, 124 casos, todos verdes (`bun run check`
rodado nesta pesquisa). Cobre providers, tradução, OCR-noise, zip, cache,
sign — não cobre qualidade visual do letreiramento (não há teste de
regressão de imagem).

## Prior art

| Projeto | O que faz melhor que o MangaLens | Fonte |
|---|---|---|
| **Mihon** (ex-Tachiyomi) | Extensões de fonte hot-swap (repo Keiyoushi) sem atualizar o app; sync bidirecional de progresso com MAL/AniList/Kitsu; backup/restore portátil (`.tachibk`, protobuf+gzip) | mihon.app/changelogs, mihon.app/docs/guides/backups |
| **Suwayomi (Tachidesk)** | Servidor único expõe GraphQL e roda extensões Tachiyomi (JVM) para múltiplos clientes finos (web/Flutter/Qt) — lógica de fonte escrita uma vez, não duplicada por client; sync de posição de leitura via SyncYomi | github.com/Suwayomi/Suwayomi-Server, github.com/syncyomi/syncyomi |
| **Komga / Kavita** | Progresso de leitura no servidor, multiusuário; feed OPDS (interoperável com qualquer leitor OPDS); metadados ricos via `ComicInfo.xml` | sumguy.com/komga-vs-kavita-comic-servers, jellywatch.app (Kavita vs Komga 2026) |
| **BallonsTranslator** | Múltiplos backends de OCR trocáveis por idioma (manga-ocr, PaddleOCR); inpainting real (LAMA/AOT/PatchMatch) reconstrói a arte sob o balão; UI de correção manual de máscara/OCR por painel | github.com/dmMaze/BallonsTranslator (+ CHANGELOG_EN.md) |
| **comic-translate** | Detector dedicado (RT-DETR-v2, treinado em 11k páginas de quadrinho/manga/webtoon) — mais robusto que detecção genérica; inpainting LAMA fine-tunado para manga; tradução por LLM com contexto de página inteira, não por balão isolado; modo de correção manual | github.com/ogkalu2/comic-translate |
| **manga-image-translator** | Detector DBNet+ResNet34 tunado para tipografia de mangá (incl. japonês vertical e SFX); inpainting AOT tunado para fundo de mangá; renderização com contorno/sombra para legibilidade sobre arte poluída; pipeline modular (detector/OCR/inpainter trocáveis) | github.com/zyddnys/manga-image-translator (+ CHANGELOG.md) |
| **MangaDex reader / Tachiyomi reader** | Modos página/dupla/tira com fit por modo, direção de leitura lembrada por série, pré-carregamento de páginas | forums.mangadex.org (reader settings thread) |

**Leitura crítica do research do agente**: a caracterização de "flat
`fillRect` box-erase" está parcialmente incorreta — `eraseBalloon` já usa a
máscara do balão (buracos das letras), não a bbox inteira, e já reamostra a
cor local. O gap real não é "sem máscara", é **sem reconstrução de textura/
gradiente**: funciona bem em balão de cor sólida, degrada em balão com
textura/sombreado ou texto fora de balão sobre arte. Ajustado no board de
prioridades abaixo.

## Constraints

- Runtime: Bun + Hono no servidor; Tauri v2 (WebView2) + JS puro no client,
  sem framework (`package.json`); OCR roda no client via `tesseract.js` WASM
  — **sem GPU garantida**, sem backend Python/ONNX hoje.
- `oxlint --deny-warnings`, `tsc --noEmit`, `bun test` são gate obrigatório
  (`package.json:13`, `AGENTS.md:6`).
- App é 100% local-first por design explícito do README ("nada sai da
  máquina") — qualquer sync é opt-in e não pode virar dependência obrigatória.
- Licenciamento de fonte: já documentado que fontes de scanlation clássicas
  (Wild Words, CC) são proprietárias e não podem ser embutidas
  (`README.md`, seção Letreiramento).
- MangaRead (Madara) bloqueia por volume (403 acima de dezenas de req/h) —
  qualquer novo provider precisa do mesmo padrão de cache agressivo
  (`README.md:41-44`).

## Risks (por raio de impacto)

1. **Alto** — Trocar/aumentar o motor de OCR (Tesseract → algo manga-tuned)
   é o maior lever de qualidade citado por todos os concorrentes diretos, mas
   os modelos de referência (manga-ocr, PaddleOCR, DBNet) são Python/ONNX
   pesados; rodar 100% client-side em WASM pode não ser viável em
   performance/tamanho de bundle — precisa de spike técnico antes de virar
   plano (rotear para variante de protótipo, não assumir).
2. **Alto** — Inpainting real (LAMA/AOT) tem o mesmo problema de custo
   (modelo grande, inferência pesada) — mesma ressalva do item 1.
3. **Médio** — Export/import de progresso é baixo risco técnico
   (serialização do que já existe em `state.ts`), mas decide formato e se
   cobre favoritos+marcadores+capítulos lidos+progresso todos juntos.
4. **Médio** — UI de correção manual da detecção de balão precisa de nova
   interação no `viewer.ts`/`ocr.ts` sem quebrar o fluxo de zoom/pan Picasa
   existente.
5. **Baixo** — Tradução com contexto de página inteira reusa
   `ai.ts:translateBlocks` já existente — é mudança de prompt/payload, não de
   infraestrutura.
6. **Baixo** — Modo de leitura webtoon contínuo: `reader.ts` já cita "modos
   página / dupla / tira (webtoon)" no README como existente — precisa
   verificar se falta paridade de recurso (pré-carregamento, direção
   lembrada por série) em vez de assumir ausência total.

## Open questions (para o questionário do `phase-plan`)

1. OCR manga-tuned client-side é viável em WASM/tamanho de bundle aceitável,
   ou o usuário aceita um passo opcional via sidecar nativo (Tauri já tem
   sidecar Rust) rodando um modelo ONNX local? Precisa de spike antes do
   plano assumir uma resposta.
2. Inpainting real: aceitar o custo de um modelo ONNX pequeno (ex. LaMa
   quantizado) rodando no sidecar, ou manter o approach atual de recolorir
   máscara (aceitando a limitação em balão texturizado) e só melhorar o caso
   de texto solto sobre arte com uma heurística mais barata (blur/clonagem
   de vizinhança em vez de rede neural)?
3. Prioridade entre as duas frentes "profundidade técnica" (OCR/inpainting)
   vs "amplitude de produto" (export/import, correção manual, contexto de
   página inteira na tradução) para esta rodada — todas de uma vez estoura
   o escopo de um loop.
4. Export/import de progresso: formato preferido (JSON simples baixável vs.
   algo tipo `.tachibk`) e se cobre só progresso/marcadores ou também
   config de IA/preferências de leitor.
5. Vale medir "qualidade absoluta" com algum critério objetivo (ex. rodar o
   pipeline OCR num conjunto de páginas de teste já em `.testlib/` e
   comparar taxa de acerto antes/depois), ou fica a critério de revisão
   visual manual nesta rodada?

## Fonts

Mihon: https://mihon.app/changelogs/, https://mihon.app/docs/guides/backups ·
SyncYomi: https://github.com/syncyomi/syncyomi ·
Suwayomi: https://github.com/Suwayomi/Suwayomi-Server,
https://github.com/Suwayomi/Tachidesk-Sorayomi ·
Komga/Kavita: https://sumguy.com/komga-vs-kavita-comic-servers/,
https://jellywatch.app/blog/jellyfin-comics-manga-kavita-komga-self-hosted-reader-2026 ·
BallonsTranslator: https://github.com/dmMaze/BallonsTranslator,
https://github.com/dmMaze/BallonsTranslator/blob/master/CHANGELOG_EN.md ·
comic-translate: https://github.com/ogkalu2/comic-translate ·
manga-image-translator: https://github.com/zyddnys/manga-image-translator,
https://github.com/zyddnys/manga-image-translator/blob/main/CHANGELOG.md ·
MangaDex reader UX: https://forums.mangadex.org/threads/reader-separate-image-fit-settings-for-long-strip-vs-single-double-page.1079106/
