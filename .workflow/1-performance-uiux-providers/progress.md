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

## Status

`awaiting: "iterate"` depois de abrir o PR com os passos 1-3. Perguntas de
confirmação para os passos 4 e 6 seguem junto na mensagem de handoff.
