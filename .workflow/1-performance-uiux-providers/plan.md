# Plan — Performance, UI/UX (abas por tipo) e expansão de providers

Issue: https://github.com/juninmd/manga-lens/issues/1
Research: `research.md` · Prototype escolhido: `prototype.md` (Variant A — abas segmentadas)

## Questionário — respostas

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Fonte de livros | **Ambos** — Internet Archive/Open Library (online, domínio público) + biblioteca local (EPUB/PDF) |
| 2 | Leitor de livro | **Novo modo reflowable**, separado do canvas mangá/HQ |
| 3 | Escopo de performance | **Os três**: minify do bundle client, memória de imagem fora do lookahead, tuning do pool OCR |
| 4 | Rate limiting no servidor | Usuário redirecionou: **não** quer rate limiter de entrada — quer **cache local agressivo** nos providers novos (mesmo padrão que já mitiga o 403 do MangaRead, `madara.ts:124-126`) pra não bater em limite dos upstreams. Aplicado como requisito transversal em todo provider novo desta rodada (item 4 abaixo), não como item isolado. |

Sem ambiguidade bloqueante restante — decisões de menor risco abaixo foram
resolvidas autonomamente, com a evidência que decidiu cada uma.

## Decisões autônomas (baixo risco, documentadas em vez de perguntadas)

- **Tipo dos providers existentes**: MangaDex/WeebCentral/MangaPill/Madara
  (MangaRead built-in) = `manga`; `archive.ts` atual = `hq` (já é HQ de
  domínio público, `archive.ts:25-62`). Não há ambiguidade — é o que cada um
  já serve hoje.
- **`MADARA_SITES` ganha campo de tipo opcional** (`id|Nome|url|lang|tipo`,
  default `manga` se omitido) — evita quebrar configs existentes dos
  usuários (retrocompatível) e cobre o caso de alguém apontar um site Madara
  de HQ.
- **HQ fica restrito a domínio público** nesta rodada (research.md, risco 1)
  — sem novo provider de HQ corrente; só ampliação de
  `PUBLIC_DOMAIN_SERIES`/`ARCHIVE_SERIES` se necessário.
- **Escopo de UI/UX = a separação por abas do protótipo**; qualquer outro
  item de UI/UX genérico fica no backlog (research.md não trouxe tela
  específica além dessa).

## Abordagem escolhida vs. alternativas rejeitadas

- **Registro de provider continua array hardcoded** (`providers/index.ts:10-17`),
  só ganha providers novos — **não** viramos um plugin/registry dinâmico.
  Motivo: o research (prior art Tachiyomi/Mihon) mostra que o valor real é
  "um arquivo por fonte implementando a mesma interface", que já existe; um
  registry dinâmico seria reescrita não pedida (non-goal) pra um ganho que a
  interface atual já entrega.
- **Livro como tipo de conteúdo novo com viewer próprio**, não conversão
  para páginas-imagem reaproveitando o canvas. Motivo: resposta explícita do
  questionário (item 2) — reflow de texto é o comportamento correto do
  formato.
- **Rate limiter de entrada rejeitado**, cache de saída adotado. Motivo:
  resposta explícita do usuário; também é consistente com o único caso real
  de bloqueio já documentado (MangaRead 403 por volume, mitigado por cache,
  não por limitar quem lê — `README.md:41-44`).

## Passos

### 1 — Tipo de conteúdo no contrato de provider
**Intenção**: dar ao catálogo um jeito de perguntar "mangá, HQ ou livro" sem
inspecionar cada provider individualmente.
**Arquivos**: `src/server/providers/types.ts` (novo campo `contentType:
'manga' | 'hq' | 'livro'` em `Provider`), `src/server/providers/mangadex.ts`,
`weebcentral.ts`, `mangapill.ts`, `archive.ts`, `local.ts` (declarar o campo),
`madara.ts` (`MadaraSite` ganha `contentType?`, parse do 5º segmento de
`MADARA_SITES`, default `'manga'`).
**Verify**: `bunx tsc --noEmit` — sem erro de tipo; `bun run smoke` —
`GET /api/providers` continua respondendo com todos os providers existentes.
**Resultado esperado**: `/api/providers` inclui `contentType` em cada entrada,
sem quebrar nenhum provider existente.

### 2 — Filtro de tipo no servidor
**Intenção**: cliente consegue pedir só providers/resultados de um tipo.
**Arquivos**: `src/server/providers/index.ts` (`enabledProviders(type?)`,
`searchAll` aceita `contentType` em `SearchFilters`), `src/server/index.ts`
(`/api/providers?type=`, `/api/search` propaga o filtro).
**Verify**: `bun run smoke` — novo caso: `GET /api/providers?type=hq`
retorna só `archive`; busca com `contentType=manga` não retorna itens do
`archive`.
**Resultado esperado**: teste novo em `scripts/smoke.ts` verde.

### 3 — Abas por tipo no catálogo (Variant A)
**Intenção**: entregar a decisão do protótipo — Mangá/HQ/Livro como
catálogos independentes, cada um com seu próprio filtro/paginação.
**Arquivos**: `src/client/catalog.ts` (estado de filtro passa a ser por aba,
`activeProviders()` considera a aba ativa; nova barra de abas no topo,
banner de aviso por provider caído dentro da aba certa), `src/client/styles.css`
(estilos das abas, reusando tokens `--accent`/`--accent-2`/`--ok` como cor
por tipo, igual ao protótipo).
**Verify**: `bun run smoke:browser` — novo cenário: trocar de aba mantém
filtro da aba anterior intacto ao voltar; resultado de uma aba nunca mistura
`contentType` de outra.
**Resultado esperado**: `smoke:browser` verde com o cenário de abas incluído.

### 4 — Provider de livro: Internet Archive / Open Library (online, domínio público)
**Intenção**: primeira fonte de livro, seguindo o mesmo padrão de licitude
de `archive.ts` (curadoria de domínio público, não scraping genérico).
**Sub-passo obrigatório antes de codar**: confirmar contra a documentação
atual (não memória) o endpoint e o contrato exatos de busca/E-book completo
em domínio público (Open Library Search API / Internet Archive texts /
Project Gutenberg) — usar `docs-verification`/Context7/WebFetch, porque
endpoints e formatos de resposta de API pública mudam e um erro aqui quebra
o provider silenciosamente.
**Arquivos**: novo `src/server/providers/books.ts` implementando `Provider`
(`contentType: 'livro'`, `kind: 'online'`), registrado em
`providers/index.ts`. Cache de saída obrigatório (item do questionário #4):
reusar `src/server/cache.ts` com TTL generoso (mesma lógica de
`madara.ts:126`, ex. 6-24h) em toda chamada de busca/detalhe/download pra
não bater em limite do upstream.
**Arquivos de host**: `registerImageHost()`/allowlist em `config.ts` pro
host de capas.
**Verify**: `bun run smoke` — novo ciclo busca→série→páginas para o
provider de livro, seguindo o padrão de `smoke.ts:135-158`; confirmar que a
segunda chamada idêntica vem do cache (log ou timing).
**Resultado esperado**: ciclo completo funcionando e coberto no smoke, sem
novas falhas 403/429 em execução repetida local.

### 5 — Provider de livro: biblioteca local (EPUB/PDF)
**Intenção**: segunda fonte de livro, sem dependência de rede.
**Arquivos**: `src/server/providers/local.ts` — reconhecer `.epub` (é um
zip; reusar o parser de zip já existente pro `.cbz`, extrair metadata do
OPF) e `.pdf` como itens de `contentType: 'livro'`; `local.ts:14-22`
(`assertInsideLibrary`) continua guardando path traversal pros novos
formatos.
**Verify**: `bun run scripts/make-test-cbz.mjs` (ou extensão dele pra criar
fixture `.epub`/`.pdf` de teste) + `bun run smoke` — novo caso de ciclo
local para livro.
**Resultado esperado**: biblioteca local lista e serve um livro de teste
igual já faz com CBZ.

### 6 — Leitor reflowable pro tipo livro
**Intenção**: exibir EPUB/PDF como texto fluido, não canvas de imagem.
**Confirmação necessária com o usuário**: renderizar PDF client-side exige
uma biblioteca (padrão de mercado: `pdf.js`) — é a primeira dependência nova
do client desde o início do projeto (hoje só `tesseract.js`). EPUB (HTML+CSS
dentro do zip) pode ser feito sem dependência nova, reaproveitando o parser
de zip. **Perguntar antes de instalar `pdf.js`** (ou equivalente) — está
fora do "menor diff", então confirmo com o usuário no início da fase de
implementação, não decido sozinho aqui.
**Arquivos**: novo `src/client/book-viewer.ts` (paralelo a `viewer.ts`, sem
zoom/pan de imagem — scroll de texto, tamanho de fonte, tema claro/escuro),
`src/client/reader.ts` (`open()` roteia pro `book-viewer` quando
`contentType==='livro'`).
**Verify**: `bun run smoke:browser` — abrir um livro de teste (EPUB da
fixture do passo 5) renderiza texto legível e navegável.
**Resultado esperado**: cenário novo verde em `smoke:browser`.

### 7 — Performance: minify do bundle client
**Intenção**: reduzir tamanho/parse do bundle sem mudar comportamento.
**Arquivos**: `scripts/build-client.ts:10` (`minify: false` → `true`).
**Verify**: `bun run build:client && bun run smoke:browser && bun run smoke:canvas`
— se algum dos dois falhar por causa de nome de função minificado usado em
teste, reverter esse passo isoladamente (não bloqueia os demais).
**Resultado esperado**: bundle menor, `smoke:browser`/`smoke:canvas` verdes;
se quebrar, passo é revertido e registrado como backlog, sem parar o resto
do plano.

### 8 — Performance: memória de imagem fora do lookahead no leitor
**Intenção**: hoje só as 3 páginas seguintes ficam eager/preloaded
(`viewer.ts:128`, `viewer.ts:498-508`), mas nada libera páginas que já
ficaram muito para trás em capítulos longos/modo tira — memória decodificada
cresce sem teto no modo webtoon.
**Arquivos**: `src/client/viewer.ts` (`visibleSheets()`/`relayout()`) —
janela de retenção: sheets fora de `[atual - N, atual + lookahead]` têm
`img.src` limpo (liberando memória decodificada) e restaurado ao reentrar na
janela.
**Verify**: `bun run smoke:browser` — cenário novo: rolar um capítulo longo
(modo tira) e checar (via `performance.memory` ou contagem de `<img>` com
`src` não vazio) que só a janela esperada mantém imagem carregada.
**Resultado esperado**: memória de imagem decodificada limitada à janela,
sem regressão visual (zoom/pan/minimapa continuam funcionando —
`smoke:browser` cobre isso).

### 9 — Performance: tuning do pool de workers OCR
**Intenção**: pool hoje é 1 worker/core (cap 2-4, `ocr.ts:70-95`) por
idioma — checar se o cap e o cálculo por idioma geram workers demais em
máquinas com poucos cores ou várias línguas simultâneas, e ajustar o
cálculo/reuso.
**Arquivos**: `src/client/ocr.ts:70-95`.
**Verify**: `node scripts/ocr-probe.mjs 10` (diagnóstico já existente) antes
e depois, comparando tempo de reconhecimento; `bun run smoke:browser` —
cenário de OCR real continua passando.
**Resultado esperado**: tempo de OCR igual ou melhor, sem exceder o cap de
workers já documentado.

## Testes a adicionar

- `scripts/smoke.ts`: filtro `contentType` em `/api/providers` e
  `/api/search`; ciclo completo do provider de livro online; ciclo completo
  do provider de livro local; rejeição de path traversal também pra
  `.epub`/`.pdf` (caminho infeliz, espelhando o teste já existente pro CBZ,
  `smoke.ts:197-204`).
- `scripts/browser-smoke.mjs`: trocar de aba mantém filtro; abrir um livro
  abre o `book-viewer`, não o canvas; rolagem longa em modo tira libera
  memória de páginas fora da janela.
- `scripts/canvas-fit-check.mjs`: sem mudança de contrato — só roda de novo
  como guarda-rail dos passos 7-9 (garante que otimização de performance não
  quebrou o letreiramento).

## Rollback

Cada passo é uma unidade independente e commitável separadamente:
- Passos 1-3 (tipo + filtro + abas) revertem juntos se abas causarem
  regressão de UX — são a mesma feature fim-a-fim.
- Passos 4-5 (providers de livro) revertem independentemente um do outro —
  online e local não compartilham código além do campo `contentType`.
- Passo 6 (leitor reflowable) reverte sozinho — se `pdf.js` for recusado na
  confirmação, cai para "adiar leitor" (opção 3 da pergunta 2), servindo só
  o catálogo do tipo livro com aviso "leitura ainda não suportada".
- Passos 7-9 (performance) são os de menor risco de revert isolado — cada um
  tem seu próprio `verify:` e pode ser desfeito sem afetar os demais.

## Confirmação necessária durante a implementação

- **Passo 6**: confirmar com o usuário antes de adicionar `pdf.js` (ou
  equivalente) como dependência nova do client.
- **Passo 4**: confirmar o endpoint/API exata escolhida (Open Library vs.
  Internet Archive texts vs. Project Gutenberg/Gutendex) depois da
  verificação de documentação, já que muda o formato de dado retornado.

## Backlog (fora do escopo desta iteração)

- Rate limiter de entrada nas próprias rotas (substituído por cache de
  saída, decisão do questionário).
- HQ além de domínio público (research.md, open question 6).
- Filtro unificado (Variant B) / prateleiras (Variant C) — rejeitados no
  protótipo, registrados em `prototype.md`.
- Qualquer item de UI/UX além da separação por abas.
