# Progress — implementação

Branch: `feat/content-type-perf-providers`
Plano: `plan.md`

## Passo 1 — Tipo de conteúdo no contrato de provider

**Arquivos**: `src/server/providers/types.ts`, `mangadex.ts`, `weebcentral.ts`,
`mangapill.ts`, `archive.ts`, `local.ts`, `madara.ts`.

Campo `contentType: 'manga' | 'hq' | 'livro'` adicionado a `Provider` e
`SeriesCard`/`SearchFilters` (também opcional em `SeriesCard` para o caso de
provider misto, como a biblioteca local vai ser depois do passo 5).
MangaDex/WeebCentral/MangaPill/Madara(built-in) = `manga`; `archive` = `hq`;
`local` = `manga` por padrão. `MADARA_SITES` ganhou 5º segmento opcional
`|tipo` (default `manga`, retrocompatível com configs existentes).

**Verify**:
```
bunx tsc --noEmit
```
Resultado: sem output → sem erro de tipo. ✅

## Passo 2 — Filtro de tipo no servidor

**Arquivos**: `src/server/providers/index.ts` (`enabledProviders(contentType?)`,
`searchAll` filtra por `filters.contentType` com fallback pro `contentType` do
provider quando o card não sobrescreve), `src/server/index.ts`
(`/api/providers?contentType=`, `/api/search?contentType=`).

**Verify**: servidor local (`bun src/server/index.ts`, porta 7788) +
`curl`:
```
GET /api/providers?contentType=hq
→ [{"id":"archive", ..., "contentType":"hq", ...}]   (só o archive)

GET /api/search?contentType=manga&providers=archive&limit=2
→ {"items":[], "errors":[], "perProvider":{"archive":0}}   (filtrado corretamente)
```
Resultado esperado obtido nos dois casos. ✅

## Passo 3 — Abas por tipo no catálogo (Variant A)

**Arquivos**: `src/client/catalog.ts` (estado de filtro/paginação vira um mapa
por `ContentType`, `activeType` seleciona a aba ativa via getter/setter em
`filters`; `activeProviders()`, `renderProviders()` e `loadTags()` passam a
considerar só providers do tipo ativo; "continuar lendo"/"marcadores"/
"favoritos" filtrados pelo tipo do provider de origem — `isActiveType()` —
pra não vazar item de outro tipo pra dentro da aba errada), `src/client/api.ts`
(`ContentType`, `contentType` em `ProviderInfo`/`SeriesCard`),
`src/client/styles.css` (`.ml-typetabs`/`.ml-typetab-*`, cor por tipo reusando
os tokens já existentes `--accent`/`--accent-2`/`--ok`, sem inventar paleta
nova).

**Verify**:
```
bunx tsc --noEmit        → sem erro
bun run build:client     → "client compilado (2 artefatos, 5 arquivos do tesseract)"
bun run smoke            → "tudo verde" (22 checks, incluindo ciclo completo
                            de cada provider e o filtro de dominio-público do
                            archive)
```
`smoke:browser` (Playwright/Chromium) ainda não rodado neste round — precisa
de sessão com browser disponível; cenário novo de troca de aba foi descrito
no plano mas o teste em si (`scripts/browser-smoke.mjs`) ainda não foi
estendido. Registrado como pendência antes de abrir mão do passo 3 como
"pronto" de verdade.

## Passos 4-9 — não iniciados nesta rodada

Bloqueados/priorizados pelas duas confirmações que o plano já marcava como
necessárias antes de codar (ver `plan.md` §"Confirmação necessária"):

- **Passo 4** (provider de livro online): falta confirmar contra documentação
  atual qual API usar (Open Library vs. Internet Archive texts vs.
  Gutenberg/Gutendex) — nenhum código escrito ainda, de propósito, pra não
  implementar em cima de um endpoint que pode estar errado.
- **Passo 6** (leitor reflowable): falta confirmação explícita pra adicionar
  `pdf.js` (ou equivalente) como primeira dependência nova do client.
- **Passo 5** (biblioteca local EPUB/PDF) depende da decisão do passo 6 pro
  formato de saída que o parser precisa produzir.
- **Passos 7-9** (performance) são independentes e não bloqueados — ainda não
  iniciados só por ordem de prioridade (a mudança de UI/UX validada no
  protótipo veio primeiro).

## Passo 7 — Performance: minify do bundle client

**Arquivos**: `scripts/build-client.ts:10` (`minify: false` → `true`).

**Verify**:
```
bun run build:client     → "client compilado (2 artefatos, 5 arquivos do tesseract)"
                            app.js: 81 KB (antes ~sem minify, bem maior)
bun run smoke:canvas     → tudo verde (letreiramento intacto)
bun run smoke            → tudo verde (22 checks)
bun run smoke:browser    → tudo verde no browser (18 checks, incluindo OCR real,
                            fila de tradução, zoom/pan, modo tira)
```
Nenhuma quebra por nome de função minificado nos smoke tests — todos batem em
seletor CSS/comportamento, não em símbolo interno do bundle. ✅

## Passo 8 — Performance: memória de imagem fora do lookahead (modo tira)

**Arquivos**: `src/client/viewer.ts` (constantes `RETAIN_BEHIND`/`RETAIN_AHEAD`,
método `trimOffscreen()` chamado de `apply()` quando a página atual muda no
modo tira — libera `img.src` de sheets fora da janela `[atual-8, atual+20]` e
recarrega ao reentrar), `src/client/styles.css` (`.ml-sheet.is-unloaded`).

Investigação prévia confirmou que isso não interfere no pipeline de OCR/
tradução: `paintOverlays()`/`runOcr()` só tocam `viewer.visibleSheets()`
(sempre dentro da janela de retenção — margem generosa), e a fila de
lookahead de tradução (`reader.ts:657`, `LOOKAHEAD=60`) usa seu próprio
`loadImage()` independente do DOM do viewer, nunca lê `sheet.img`.

**Verify**: script Playwright pontual (não promovido ao repo — protótipo
descartável de verificação, igual instrui `phase-implement`): abriu um
capítulo em modo tira, rolou bem além da janela de retenção.
```
sheets no modo tira: 18
depois de rolar: { total: 18, unloaded: 8, withSrc: 10 }
```
8 de 18 sheets fora da janela perderam o `src` (memória decodificada
liberada), sem quebrar layout/zoom/OCR — `smoke:browser` (que já cobre zoom,
pan, OCR real e modo tira) continua verde depois da mudança. ✅

## Passo 9 — Performance: tuning do pool de workers OCR

**Arquivos**: `src/client/ocr.ts`.

Dois ajustes, os dois evidenciados por leitura de código (não só opinião):
1. **Chão do pool baixou de 2 para 1** — a fórmula antiga
   (`Math.max(2, Math.min(4, cores-1))`) forçava no mínimo 2 workers mesmo
   quando `navigator.hardwareConcurrency` reporta 1-2 núcleos, disputando CPU
   com a thread principal numa máquina já fraca. Agora
   `Math.max(1, Math.min(4, cores-1))` — só baixa em hardware fraco, sem
   mudar nada nas máquinas com 5+ núcleos (mesmo resultado de antes).
2. **Teto global entre idiomas** — antes cada idioma abria seu próprio pool
   de até 4 workers sem limite entre si; trocar de idioma no meio da leitura
   (ex. um scan em inglês depois de um em japonês) podia empilhar 8-12
   workers competindo pela mesma CPU. Agora existe `GLOBAL_CAP` (=núcleos) e
   `evictLru()` derruba o pool do idioma há mais tempo sem uso antes de abrir
   um novo, quando o total ultrapassaria o teto.

**Verify**:
```
bunx tsc --noEmit        → limpo
bun run smoke:browser    → "OCR na pagina" e "OCR usou o idioma do scan"
                            continuam verdes (comportamento de reconhecimento
                            inalterado, só a política de quantos workers ficam
                            vivos ao mesmo tempo)
```
`node scripts/ocr-probe.mjs 10` (diagnóstico de tempo antes/depois) não
rodou nesta rodada — precisa de uma página real de teste e não é bloqueante
pro merge; registrado como pendência.

## Status

Passos 7-9 do plano implementados e verificados nesta rodada — performance
completa. PR aberto com o diff. `awaiting: "iterate"`.

Pendências que seguem em aberto (não bloqueiam este PR):
- Confirmação da API do provider de livro online (passo 4).
- Confirmação sobre `pdf.js` como dependência nova (passo 6).
- `smoke:browser` ainda não ganhou um cenário formal e persistido pro
  cenário de troca de aba (passo 3, PR anterior) nem pro trim de memória
  (passo 8, verificado aqui só com script pontual).
- `ocr-probe.mjs` antes/depois não rodado para o passo 9.
