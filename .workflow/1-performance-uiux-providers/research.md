# Research — Performance, UI/UX, expansão de providers

Issue: https://github.com/juninmd/manga-lens/issues/1

## Goal

Melhorar performance (build client, carregamento/decodificação de páginas,
OCR) e UI/UX do leitor/catálogo, e tornar mais fácil adicionar novos
providers de conteúdo, reduzindo o quanto é preciso mexer em
`providers/index.ts` para cada fonte nova. Isso inclui tratar **mangá**,
**HQ** e **livro** como tipos de conteúdo distintos e navegáveis
separadamente no catálogo (não uma lista única misturada), já que cada tipo
tem convenções de leitura diferentes (mangá: RTL comum; HQ ocidental: LTR;
livro: texto reflowable, não páginas-imagem). A escolha da fonte específica
de livros fica em aberto — não é `baixelivros.com.br` obrigatoriamente,
qualquer fonte com licitude clara serve (ver Open questions).

## Non-goals

- **Não** construir scraper/provider para conteúdo atualmente protegido por
  direitos autorais sem uma fonte licenciada (ver Riscos). Isso inclui HQs
  atuais da DC/Marvel e e-books de `baixelivros.com.br`.
- Não redesenhar a stack (sem framework, sem bundler novo) — o pedido é
  melhoria, não reescrita.
- Não implementar autenticação/sync de usuário (progresso já é local by design,
  README.md:134).
- Não mudar o modelo de distribuição (continua Tauri + sidecar Bun).

## Acceptance criteria

- **Performance**
  - `scripts/build-client.ts` produz bundle minificado (hoje `minify: false`,
    `build-client.ts:10`) sem quebrar `smoke:browser`/`smoke:canvas`.
  - Página do leitor não decodifica/mantém em memória mais imagens do que o
    necessário para o spread atual + lookahead (hoje só 3 páginas ficam
    `eager`/preloaded em modo strip, `viewer.ts:128`, `viewer.ts:498-508`) —
    qualquer mudança tem que manter ou reduzir esse footprint, nunca
    aumentá-lo silenciosamente.
  - `bun run smoke`, `smoke:browser`, `smoke:canvas`, `typecheck` continuam
    verdes (README.md:169-184).
- **UI/UX**
  - Mudanças mantêm os atalhos e gestos documentados (scroll=zoom,
    arrastar=pan, duplo clique, minimapa — README.md:120-128) funcionando,
    provados por `smoke:browser`.
- **Providers**
  - Catálogo separa mangá, HQ e livro (filtro/aba/seção própria por tipo, não
    lista única misturada) — cada `Provider` declara a que tipo pertence.
  - Um novo provider pode ser adicionado implementando a interface `Provider`
    (`providers/types.ts:77-88`) e registrando em `providers/index.ts:10-17`
    — critério mínimo: nenhuma mudança é necessária em `index.ts` (rotas),
    `catalog.ts` (UI) ou `state.ts` para o provider aparecer no catálogo.
  - Cada provider novo aprovado é coberto por um ciclo
    busca→série→páginas→imagem em `scripts/smoke.ts`, seguindo o padrão de
    `smoke.ts:135-158`.
  - Providers cuja licitude de conteúdo é incerta (ver Riscos) **não** são
    implementados nesta iteração sem decisão explícita do usuário na fase de
    plano.

## Codebase map

### Providers (`src/server/providers/`)
- Contrato: `types.ts:77-88` (`interface Provider { id, name, kind, supports,
  languages?, tags?(), search(), series(), pages() }`). **Não existe campo
  de tipo de conteúdo** (mangá/HQ/livro) hoje — só `kind: 'online'|'local'`.
  Separar mangá/HQ/livro no catálogo exige adicionar esse campo ao contrato
  e propagar por `SeriesCard`/`SearchFilters`/UI; hoje `archive.ts` já mistura
  HQ ocidental de domínio público no mesmo pipeline dos providers de mangá.
- Registro: **array hardcoded**, `providers/index.ts:10-17` — sem
  registry/plugin dinâmico. `enabledProviders()` filtra por `kind` (`index.ts:19-20`).
- Providers existentes, um arquivo cada: `mangadex.ts` (API oficial),
  `weebcentral.ts` e `mangapill.ts` (scraping HTML por regex),
  `madara.ts` (parser genérico do tema WordPress "Madara" — o único
  mecanismo data-driven hoje: `MADARA_SITES=id|Nome|url|lang;...` cria site
  novo sem código, `madara.ts:212-229`), `archive.ts` (Internet Archive,
  allowlist de domínio público `PUBLIC_DOMAIN_SERIES` + blocklist
  `MODERN_FRANCHISES`, `archive.ts:25-62`), `local.ts` (biblioteca local
  CBZ/pastas).
- Busca agregada: `searchAll` (`index.ts:91-124`) roda em paralelo
  (`Promise.allSettled`), deduplica por `titleKey()`, guarda origens em
  `sources[]`, intercala round-robin; falha de provider vira aviso, não erro
  fatal (`index.ts:99-108`).
- Para servir imagens de host novo: `registerImageHost()`
  (`config.ts:31-58`, usado em `madara.ts:50`, `archive.ts:193`) — sem isso o
  proxy `/api/img` rejeita por SSRF-guard.

### Servidor (`src/server/index.ts`, Hono, 333 linhas)
- Rotas REST simples (`/api/providers`, `/api/search`, `/api/series`,
  `/api/pages`, `/api/img` assinado HMAC, `/api/local/page`,
  `/api/tessdata/:file`, `/api/ai/*`, estático `public/` com fallback SPA).
- Cache dois níveis (mem + disco JSON), TTL 30 min padrão
  (`cache.ts:18-42`, `config.ts:10`), 6h para série Madara (`madara.ts:126`)
  por causa de bloqueio 403 por volume (README.md:41-44).
- **Sem rate limiter próprio**; só retry/backoff outbound em `http.ts:40-46`.
- Bind só em `127.0.0.1` (`index.ts:325`).

### Leitor/canvas (`src/client/viewer.ts` + `src/client/ocr.ts` + `src/client/reader.ts`)
- Sem blob URLs — `<img src>` direto para `/api/img` assinado;
  `img.crossOrigin='anonymous'` obrigatório (`viewer.ts:122-123`) por causa
  de canvas tainted (README.md:199-201).
- Lazy loading parcial: só páginas além das 3 seguintes ao spread visível em
  modo tira ganham `loading="lazy"` (`viewer.ts:128`); preload eager das
  próximas 3 (`viewer.ts:498-508`).
- OCR: pool de workers Tesseract por CPU (2-4, `ocr.ts:70-95`), detecção de
  balões por componentes conexos antes do OCR (`ocr.ts:154-172`), letreiramento
  100% em canvas (`paintPage`, `ocr.ts:807+`).
- Fila de tradução em background, lookahead de 60 páginas
  (`reader.ts:601-674`), cache com cap de 3000 entradas (`reader.ts:683-689`).

### Frontend (`src/client/`)
- Vanilla TS, sem framework, helper `el()` (`ui.ts`).
- `catalog.ts` (770 linhas): busca com debounce 420ms, filtros, seletor de
  fontes, favoritos, agregação de tags entre providers.
- `state.ts`: tudo em `localStorage`, sem sync de servidor.

### Build (`scripts/build-client.ts`, `scripts/build-sidecar.ts`)
- `Bun.build()` com **`minify: false`** explícito (`build-client.ts:10`) —
  alavanca de performance mais direta e barata disponível.
- Um entrypoint só, sem code splitting, sem dynamic `import()`.
- Sem service worker, sem pipeline de otimização de imagem (imagens passam
  cru pelo proxy, só `Cache-Control` HTTP).
- Sidecar: `bun build --compile --minify --target bun`
  (`build-sidecar.ts:18-21`).

### Smoke tests (guard-rails obrigatórios)
`scripts/smoke.ts` (API, todos providers, filtros, engines de tradução),
`scripts/browser-smoke.mjs` (Playwright: zoom, pan, duplo clique, minimapa,
OCR real), `scripts/canvas-fit-check.mjs` (letreiramento fica dentro do
balão), `scripts/desktop-smoke.mjs` (exe Tauri compilado via CDP).

### Desktop (Tauri)
`src-tauri/src/main.rs`: porta livre para sidecar, `api_port` via IPC,
`CACHE_DIR` redirecionado (Program Files não é writável), mata sidecar ao
sair. `lto = true` estoura o rustc nesta máquina (README.md:202) — evitar
essa via para reduzir tamanho de binário.

## Prior art

- **Tachiyomi/Mihon** (leitor de mangá Android open-source) usa um contrato
  de source por método (`getPopular`, `getMangaDetails`, `getChapterList`,
  `getPageList`/`fetchImageUrl`) e um catálogo de extensões — uma por site —
  compiladas e distribuídas separadamente do app, carregadas dinamicamente.
  MangaLens já tem o equivalente estático do contrato (`types.ts:77-88`); o
  que falta é o catálogo dinâmico (hoje é array hardcoded em `index.ts`).
  Não vale portar o modelo de plugin binário Android; vale copiar a ideia de
  **um arquivo por fonte implementando a mesma interface**, que já é o padrão
  aqui — só falta reduzir o quanto `index.ts`/`catalog.ts` precisam saber de
  cada fonte nova.
  [keiyoushi/extensions](https://github.com/keiyoushi/extensions),
  [DeepWiki: extensions-source](https://deepwiki.com/keiyoushi/extensions-source)
- **Performance de canvas/imagem em leitores**: `decoding="async"` reduz
  stutter perto do paint; cache de estado "já carregado" fora do componente
  evita re-fetch ao rolar; `OffscreenCanvas` + Web Worker tira renderização
  pesada da main thread — relevante para o letreiramento (`paintPage`) se
  ele começar a competir com scroll/zoom.
  [web.dev: Canvas performance](https://web.dev/articles/canvas-performance),
  [MDN: Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)

## Constraints

- Runtime: Bun + Hono no servidor, Tauri 2 (WebView2) no desktop, sem
  Node.js em produção.
- Sem framework de UI — qualquer melhoria de UX é DOM/CSS vanilla ou adoção
  pontual justificada.
- Compatibilidade: smoke tests cobrem exatamente os fluxos que não podem
  quebrar (busca, leitor, OCR, desktop). Qualquer mudança de performance/UX
  tem que continuar passando por eles.
- `MADARA_SITES` já é a via de menor esforço para novos sites do tema Madara
  — não precisa de código novo, só documentação/UX para configurar.
- MangaRead (Madara) e sites HTML em geral são frágeis a mudança de layout e
  a bloqueio por volume (403/429) — qualquer provider novo via scraping HTML
  herda esse risco.

## Riscos

1. **Legal — HQs DC/Marvel**: o pedido do usuário reconhece que hoje "tem
   problemas autorais", apostando em expiração de direitos autorais em breve.
   Isso não procede como premissa técnica: nos EUA, obras publicadas depois
   de 1929 (regra que avança 1 ano por vez) têm proteção de até 95 anos da
   publicação: HQs de Marvel/DC de décadas de 1960-2020 continuam protegidas
   por décadas ainda, e mesmo a entrada de uma edição específica em domínio
   público não libera personagens/marcas registradas em uso corrente
   (trademark não expira). O provider `archive.ts` já modela essa distinção
   corretamente hoje: allowlist de séries de domínio público **e** blocklist
   explícita de franquias modernas (`archive.ts:25-62`). Recomendação: manter
   esse padrão — qualquer fonte nova de HQ passa pelo mesmo filtro de
   domínio-público antes de entrar no catálogo; não construir scraper
   genérico para catálogos correntes da DC/Marvel.
2. **Legal — fonte de livros em geral**: usuário sugeriu inicialmente
   `baixelivros.com.br`, depois confirmou que não precisa ser esse site
   específico. Fica registrado como risco geral: sites de "download de
   livros" tipicamente replicam catálogos comerciais sem indicação de
   licença dos detentores de direitos, e um provider que raspa um domínio
   assim herdaria esse problema. Recomendação (mantida): tratar "suporte a
   livros" como **tipo de conteúdo novo** (extensão do catálogo/leitor para
   EPUB/PDF, distinto de mangá/HQ), com fontes candidatas de licitude clara
   — Internet Archive/Open Library/Project Gutenberg (mesmo modelo de
   `archive.ts`) ou biblioteca local do usuário (extensão de `local.ts` para
   `.epub`/`.pdf`) — e qualquer fonte online específica revisada caso a caso
   pelo mesmo critério de domínio-público/licença que já rege `archive.ts`.
3. **Fragilidade de scraping HTML**: providers novos via HTML herdam o
   mesmo risco que já existe (`README.md:214-215`) — mudança de layout
   quebra sem avisar até rodar o smoke.
4. **Rate limiting ausente no servidor próprio**: hoje só existe proteção
   outbound; se providers novos aumentarem tráfego, nada impede um cliente
   abusivo de esgotar cache/CPU local. Fica como possível item de plano, não
   bloqueante.
5. **`minify: false` é debitável rápido**, mas mudar build pode interagir
   com o sourcemap `linked` e com os smoke tests que dependem de nomes de
   função no bundle (não confirmado — checar em `browser-smoke.mjs`/
   `canvas-fit-check.mjs` antes de ligar minify).

## Open questions (para o questionário do phase-plan)

1. **Fonte de livros**: usuário confirmou que não precisa ser
   `baixelivros.com.br` especificamente — a fonte fica em aberto. Candidatos
   com licitude clara: Internet Archive/Open Library/Project Gutenberg
   (mesmo modelo de `archive.ts`, domínio público) e biblioteca local do
   usuário (extensão de `local.ts` para EPUB/PDF). Confirmar qual(is) entram
   nesta iteração.
2. **Formato do leitor de livros**: EPUB (texto reflowable) e PDF exigem
   um visualizador diferente do canvas de imagem por página atual — criar
   modo de leitura novo, ou converter para páginas-imagem e reusar o
   viewer existente?
3. **Separação mangá/HQ/livro no catálogo**: aba/seção por tipo, filtro
   combinável, ou catálogos totalmente separados (rotas distintas)? E como
   classificar providers existentes — MangaDex/WeebCentral/MangaPill/Madara
   = mangá, `archive.ts` atual = HQ (domínio público) — sem quebrar
   `MADARA_SITES` custom que hoje podem apontar tanto para mangá quanto HQ
   dependendo do site configurado pelo usuário.
4. **Escopo de performance**: priorizar minify do client bundle, redução de
   memória de imagem no leitor (páginas fora do lookahead), ou tempo de OCR
   (pool de workers)? Pedir para o usuário rankear ou aceitar os três.
5. **Escopo de UI/UX**: o pedido é genérico ("melhorias em UI/UX") — sem
   telas/fluxos específicos apontados. Preciso de exemplos concretos
   (screenshots, fluxo que incomoda) ou fica a critério do phase-prototype
   propor 3 variantes de uma área específica (ex.: catálogo, drawer de
   filtros, ou barra do leitor)?
6. **Providers de HQ além de domínio-público**: existe algum site de HQ
   legalmente redistribuível (ex.: Creative Commons, webcomics com API
   aberta) que o usuário já tenha em mente, ou a expansão de HQ fica restrita
   a ampliar `PUBLIC_DOMAIN_SERIES`/`ARCHIVE_SERIES` por ora?
7. **Rate limiting no servidor próprio**: entra no escopo desta iteração ou
   fica para depois?
