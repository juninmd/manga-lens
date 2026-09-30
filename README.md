<div align="center">

# 📖 MangaLens

**Leia mangá, HQ e livro em qualquer idioma — a tradução aparece dentro do balão, na hora.**

App desktop que junta catálogo multi-provider, OCR local, tradução com contexto da obra
e um visualizador no estilo Picasa. Nada sai da sua máquina além do texto reconhecido.

[![CI](https://github.com/juninmd/manga-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/juninmd/manga-lens/actions/workflows/ci.yml)
[![Release](https://github.com/juninmd/manga-lens/actions/workflows/release.yml/badge.svg)](https://github.com/juninmd/manga-lens/actions/workflows/release.yml)
![Bun](https://img.shields.io/badge/Bun-1.3-000?logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)
![Biome](https://img.shields.io/badge/Biome-lint-60A5FA?logo=biome&logoColor=white)

</div>

---

## Sumário

| | |
|---|---|
| 🚀 [Rodando](#-rodando) · [Configuração de IA](#-configuração-de-ia) | comece por aqui |
| 📚 [Catálogo](#-catálogo) · [Biblioteca local](#biblioteca-local) | de onde vêm as obras |
| 🔤 [OCR e tradução](#-ocr-e-tradução) · [Motores](#motores-de-tradução) | o coração do app |
| 🖼️ [Visualizador](#️-visualizador-estilo-picasa) · [Leitor de livro](#leitor-de-livro-epub) | como se lê |
| 🔖 [Onde você parou](#-onde-você-parou) | progresso, marcadores, backup |
| ✅ [Verificação](#-verificação) · [Release](#release-automática) | qualidade e entrega |
| ⚠️ [Armadilhas](#armadilhas-já-pagas) · [Limites](#-limites-conhecidos) | o que já custou caro |

---

## ✨ O que ele faz

| | |
|---|---|
| 🔍 **Catálogo multi-provider** | 87 fontes online de mangás e HQs em quatro idiomas, mais a sua pasta — busca em paralelo, resultados intercalados |
| 📂 **Três abas** | Mangá, HQ e Livro, cada obra classificada pelo formato e pelo `ComicInfo.xml` |
| 👁️ **OCR na máquina** | detector neural de balões + Tesseract WASM; só o texto reconhecido vai para o LLM |
| 🎨 **Tradução letreirada** | composta *no lugar* do texto original, na cor do balão e na cor da tinta — não é caixa branca por cima |
| ⚡ **Capítulo inteiro** | fila em segundo plano com barra de progresso, três páginas em paralelo, seguindo pelos próximos capítulos |
| 🧠 **Memória da obra** | glossário de nomes com gênero e resumo das páginas anteriores, por obra e idioma |
| 🖼️ **Visualizador Picasa** | zoom ancorado no cursor, arrasto com inércia, navegador em miniatura |
| 🔒 **Local por padrão** | progresso no `localStorage`, imagens por proxy assinado em HMAC, backup em `.json` |

---

## 🚀 Rodando

```powershell
bun install
copy .env.example .env      # ajuste AI_PROVIDER / AI_MODEL / LOCAL_LIBRARY

# app desktop
bun run desktop             # tauri dev
bun run desktop:build       # instalador NSIS em src-tauri/target/release/bundle

# modo web (mesmo servidor, sem Tauri)
bun run dev                 # http://localhost:7788
```

O app escolhe uma porta livre para o sidecar e a entrega ao front pelo comando
`api_port`; o processo do servidor é morto junto com a janela.

### Como roda

```
Tauri (janela + WebView2)
  ├─ front  → public/  (bundle Bun: catálogo, visualizador, OCR no browser)
  └─ sidecar → manga-lens-server (Bun compilado): providers, proxy de imagem, LLM
```

O front nunca fala direto com os sites: toda imagem passa por `/api/img`, com URL
**assinada em HMAC** e host em allowlist, conferida **a cada salto de redirect**. O
OCR roda na máquina (Tesseract WASM); só o texto reconhecido vai para o LLM.

---

## 📚 Catálogo

| Provider | Tipo | Filtros aplicados no upstream |
|---|---|---|
| **MangaDex** | API oficial | busca, idioma da tradução, idioma original, tags, status, demografia, classificação, ano, ordenação |
| **Weeb Central** | HTML | busca, tags (incluir/excluir), status, tipo, ordenação |
| **MangaPill** | HTML | busca, gênero, status, tipo |
| **MangaRead** (tema Madara) | HTML | busca, gênero, status, ordenação |
| **56 sites Madara + 24 MangaThemesia** | HTML | busca, capítulos e páginas; filtros variam por site |
| **MangaKatana** | HTML | busca e paginação |
| **HQ Now** | GraphQL | HQs em português, busca por título |
| **ReadAllComics** | HTML | busca de HQs |
| **Internet Archive** | API oficial | HQ da Golden Age em domínio público — ~2.060 edições de 81 séries |
| **Biblioteca local** | disco | pastas, `.cbz`/`.zip`, `.cbr`/`.rar`, `.pdf`, `.epub` |

A busca vai nos providers em paralelo e intercala os resultados; provider que cai
vira aviso na barra de status, não erro fatal. O que o provider não filtra no
upstream é filtrado no servidor (ano em faixa, tipo, tags excluídas).

**81 fontes novas foram integradas; 79 passaram pela leitura de imagens via proxy na validação de 30/09/2026.** Elf Toon (403) e Rizz Fables (CDN 526) estavam indisponíveis no teste final. Consulte a [lista completa e os resultados](docs/sources.md). Para repetir: `bun run smoke:sources` com o servidor aberto.

O provider **Madara** é genérico: um parser atende qualquer site que use esse tema
WordPress. Para somar outros, sem tocar em código:

```
MADARA_SITES=meusite|Meu Site|https://exemplo.org|pt-br;outro|Outro|https://outro.com|en
```

Cada site declarado vira um provider próprio, com o host já liberado no proxy de
imagem. Consulte [a configuração estendida](docs/sources.md#mais-sites-madara) para caminhos próprios e CDNs.

> **MangaRead bloqueia por volume.** Depois de algumas dezenas de requisições ele
> passa a responder **403** para o IP, e header de browser não contorna. Por isso
> a lista de capítulos é cacheada por 6 h. A busca mostra falhas por fonte, e
> o teste `smoke:sources` registra `403`/`429` como falha de disponibilidade.

> **O acervo do Archive é uma lista curada**, não a coleção inteira: a coleção
> `comics` é depósito aberto e devolve edição protegida enviada por usuário. Um
> título só entra se for domínio público **e** distintivo — nome genérico de uma
> palavra ("Beyond", "Attack") casa com centenas de itens sem relação, e nome ainda
> em uso por editora viva ("Strange Adventures") arrasta obra protegida. Para
> ampliar por conta própria: `ARCHIVE_SERIES=Serie Um;Serie Dois`.

### Biblioteca local

Aponte `LOCAL_LIBRARY` para uma ou mais pastas (separadas por `;`). Cada subpasta
vira uma obra; arquivos e subpastas viram capítulos.

| Formato | Vira | Observação |
|---|---|---|
| pasta de imagens | capítulo único | ordem natural (`2.jpg` antes de `10.webp`) |
| `.cbz` / `.zip` | capítulo | parser de ZIP próprio, sem dependência externa |
| `.cbr` / `.rar` | capítulo | aba **HQ** e leitura da esquerda para a direita |
| `.pdf` | obra na aba **Livro** | página extraída como bitmap e codificada em PNG no servidor, sem canvas nativo |
| `.epub` | obra na aba **Livro** | abre no [leitor de texto](#leitor-de-livro-epub), com título e autor lidos do OPF |

Quando o arquivo traz **`ComicInfo.xml`** (o padrão que Calibre, Komga e Kavita
escrevem), o que ele *declara* vence o palpite pela extensão: série, número, ano,
sinopse, gêneros, idioma e o campo `Manga`, que define a aba e o sentido de leitura.
O que ele **omite** não decide nada — ler a ausência de `Manga` como "é HQ" mandava
todo CBZ para a aba errada.

---

## 🔤 OCR e tradução

**1. Detecção de balões** — duas fontes, fundidas:

- um **detector neural local** ([RT-DETR-v2 do comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector),
  Apache-2.0, 11 MB int8) acha balão, texto em balão e **texto solto** (legenda,
  SFX, balão colorido), treinado em mangá, webtoon, manhua e HQ ocidental. Roda
  em WASM (`onnxruntime-web`) num Web Worker — a leitura não trava. O modelo é
  baixado uma vez pelo sidecar, preso num commit e **conferido por SHA-256**;
- a heurística de **manchas brancas fechadas** (componentes conexos) dá o
  formato exato e a cor de cada balão, que o letreiramento precisa.

Balão com um texto usa a máscara da heurística; balão que a heurística fundiu
com o vizinho é **dividido** pelas caixas do modelo; texto sem balão vira região
própria. Sem o modelo (offline, ou o toggle **Detector neural** desligado nas
opções), a heurística trabalha sozinha.

**2. Reconhecimento** — cada texto é recortado da página pré-processada (2×,
cinza, contraste), com **tudo o que está fora do balão branqueado** (contorno e
arte vizinha viravam letras falsas), e reconhecido em PSM 6 (ou PSM 5 para
japonês vertical). Nas páginas com gabarito (`.workflow/5-competitive-quality`):
frases achadas 7/17 → 12/17, CER 0,56 → 0,35, 35% mais rápido.

**3. Tradução** — a **página inteira** vai num pedido só ao LLM, com os balões na
**ordem de leitura** (faixas de altura, da direita para a esquerda em mangá). O
prompt leva a **memória da obra** — glossário de nomes com gênero e um resumo das
últimas páginas *anteriores* (nunca das seguintes) — e regras de nome próprio e
gênero neutro quando o original não diz. A resposta devolve a tradução ancorada
por `id` e o que aprendeu na página, gravado em `.cache/series-memory`. Lixo de
OCR repetido (`●●●●…`) é cortado antes de chegar a qualquer motor.

**4. Letreiramento** — a tradução é **composta no lugar do texto original**, não
colada numa caixa branca por cima. Para cada balão o cliente:

- preenche os **buracos** da mancha detectada (as letras são furos dentro do
  branco) e usa esse interior como máscara, erodido 2 px para não cobrir o
  contorno do balão;
- repinta esse interior com a **cor amostrada do próprio balão** — apaga o
  texto original sem tocar na arte em volta;
- amostra a **cor da tinta** e a caixa (alta/baixa) do original e reusa as duas;
- quebra o texto e escolhe o **maior corpo que ainda cabe**, por busca binária,
  centralizado no mesmo espaço.

Tudo isso é desenhado num canvas em coordenadas da imagem, então acompanha o
zoom e o arrasto sem recalcular nada. A fonte do letreiro é selecionável
(letreiro / sem serifa / serifada) — as fontes clássicas de scanlation (Wild
Words, CC) são proprietárias e não podem ser embutidas.

### Motores de tradução

| Motor | Precisa de IA | Comportamento |
|---|---|---|
| **Automático** | não | tenta Google, depois MyMemory, e só recorre à IA se os dois falharem |
| **IA (contexto)** | sim | corrige o ruído do OCR antes de traduzir, entende gíria e onomatopeia |
| **IA com visão** | sim | o modelo **lê os balões direto da imagem**, sem Tesseract — a página vai numerada, no formato do paper de tradução multimodal. Exige `*_VISION_MODEL` configurado |
| **Google** | não | endpoint público do tradutor, sem chave; rápido e literal |
| **MyMemory** | não | reserva quando o Google recusa; cota diária no plano anônimo |

Os motores sem IA não sabem consertar OCR, então o servidor descarta antes o que
tem menos de duas letras de verdade — sem isso um balão de ruído viraria uma
requisição desperdiçada e uma legenda sem sentido na página. O teto de requisições
simultâneas é **do processo**, não da requisição: com três páginas em paralelo, um
teto por chamada viraria uma rajada e o Google responderia `429`.

Há ainda **`explicar`** — chat em streaming sobre a cena, com a sinopse e o texto
já reconhecido como contexto, instruído a não dar spoiler além do ponto atual.

### Traduzindo o capítulo inteiro

Com **traduzir** ligado, o capítulo inteiro entra numa fila com **barra de
progresso** (`23/59 páginas`). O pipeline tem dois estágios, porque o gargalo de
cada um é diferente: o OCR é serial (o pool do Tesseract não serve duas páginas ao
mesmo tempo) e alimenta a tradução, que roda **três páginas em paralelo** na rede.
Terminado o capítulo, a fila **segue pelos próximos**, na ordem, cedendo a vez
sempre que você pede o OCR da página que está lendo.

O resultado fica em cache por `capítulo:página`, então virar a página ou avançar de
capítulo já encontra a tradução pronta. Ligue **traduzir sozinho ao abrir** nas
opções para o capítulo começar traduzido. Desligar o botão para a fila na hora.

O idioma do OCR é o do **scan**, não o da obra: Naruto é japonês, mas o capítulo
publicado em inglês é reconhecido com `eng`. Modelos (`.traineddata`) são baixados
uma vez e ficam no cache do app.

### Memória da obra e página para o modelo de visão

No modo **IA**, as opções do leitor mostram a seção **Contexto da obra**:

- quantos nomes e páginas a memória já tem, e **limpar memória da obra** — um nome
  ou gênero gravado errado se repetiria no resto da obra, então dá para zerar;
- **IA vê a página** (desligado por padrão): manda junto a página reduzida com o
  `id` desenhado em cada balão ao **modelo de visão** do provedor. Acerta melhor quem
  fala e o gênero (no paper de referência, xCOMET 0,758 → 0,776 em JA→EN), mas
  custa mais tokens por página. Sem modelo de visão configurado, fica desabilitado.

A memória é por obra **e** idioma de chegada, local (`.cache/series-memory`), com
teto de 80 nomes e 60 notas; o prompt usa só as 5 notas mais recentes antes da
página atual — contexto longo piora a tradução. Só entra no glossário termo que
aparece no texto da página (o modelo pequeno inventava personagens).

Cada tradução volta com o eco do começo do original (`src`): quando o modelo pula
uma fala curta e escorrega as seguintes, o servidor devolve cada fala ao balão
que o eco identifica — balão vazio (refeito com **R**) em vez de fala no balão
errado. Resposta cortada no limite de tokens aproveita os pares que fecharam.

---

## 🖼️ Visualizador (estilo Picasa)

- **scroll** = zoom ancorado no cursor (o ponto sob o mouse não sai do lugar)
- **arrastar** = pan, com inércia ao soltar; **pinça** com dois dedos
- **duplo clique** alterna ajuste ↔ 1:1 no ponto clicado
- **navegador em miniatura** aparece no canto ao ampliar; arrastável
- modos **página / dupla / tira (webtoon)**, ajuste largura/altura/página, RTL
- filmstrip de páginas, slider de zoom, atalhos: `← →` `espaço` `+ -` `0` `1`
  `o` (OCR) `t` (original/tradução) `f` (tela cheia) `Esc`

O sentido de leitura segue a obra: HQ ocidental e PDF abrem da esquerda para a
direita; mangá, da direita para a esquerda.

### Leitor de livro (EPUB)

EPUB não tem página nem balão, então o OCR não entra. O capítulo chega como
parágrafos numerados e abre num leitor próprio — coluna de leitura com medida fixa,
corpo da letra ajustável em `A−`/`A+`, `[` e `]` para trocar de capítulo.

A tradução usa o **mesmo endpoint** do mangá, em lotes de 10 parágrafos, três em
paralelo, com a mesma barra de progresso. **Clicar num parágrafo volta ao original** —
o equivalente ao `t` do leitor de páginas.

A ordem de leitura vem do *spine* do OPF, e item marcado `linear="no"` (notas da
editora, propaganda) fica fora do fio principal.

---

## 🔖 Onde você parou

- **Continuar lendo** — a página e o capítulo de cada obra são gravados a cada
  virada de página; a fila aparece no topo do catálogo.
- **Marcadores** — o botão 🔖 no leitor fixa a página exata; a linha "Marcadores"
  no catálogo volta direto para ela.
- **Capítulos lidos** — chegar na última página marca o capítulo. Na lista, cada
  linha tem `○/✓` para alternar à mão e `⤓` para marcar aquele e **todos os
  anteriores** (útil ao pegar uma série no meio). O painel mostra `X de Y lidos`
  e o card do catálogo traz o contador.

Tudo vive no `localStorage` do app — nada sai da máquina. O botão **⭳ Backup** na
barra de cima baixa um `.json` com favoritos, progresso, marcadores e capítulos
lidos; **⭱ Importar** restaura esse arquivo (em qualquer máquina) sem precisar de
conta nem serviço externo.

---

## 🤖 Configuração de IA

A IA é integrada via **Vercel AI SDK**, permitindo escolher o provider através da
variável `AI_PROVIDER`:

| Provider | `AI_PROVIDER` | Descrição |
|---|---|---|
| **Ollama** (padrão) | `ollama` | Execução local com modelos como `qwen2.5:7b-instruct`. Modelos com raciocínio (`qwen3.x`, `deepseek-r1`) rodam com `reasoning_effort: none` — senão gastam o limite de tokens pensando e devolvem resposta vazia. A tradução usa a saída JSON com gramática do Ollama (`response_format: json_object`) |
| **OpenRouter** | `openrouter` | Gateway em nuvem para dezenas de modelos (Llama 3.3, Claude, GPT, etc.) |
| **OpenAI-Compatible** | `openaicompatible` | Qualquer endpoint compatível (LM Studio, vLLM, LiteLLM, Groq, etc.) |

```env
# Escolha do provider: ollama | openrouter | openaicompatible
AI_PROVIDER=openrouter

# Configurações do OpenRouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct
OPENROUTER_VISION_MODEL=

# Ou configurações do Ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=qwen2.5:7b-instruct

# Ou OpenAI-Compatible (LM Studio / vLLM / etc.)
OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_COMPATIBLE_API_KEY=lm-studio
OPENAI_COMPATIBLE_MODEL=model-id

# Variáveis globais retrocompatíveis
AI_MAX_TOKENS=1200          # modelos de raciocínio voltam vazios com valor baixo
AI_TIMEOUT_MS=120000
```

O selo no canto inferior mostra o provider e modelo ativo ou o erro de conexão.
Estar listado em `/v1/models` não prova que o modelo responde — o teste real é
pedir uma tradução.

> O `.env` **não é versionado** e a varredura de segredos reprova o build se uma
> chave escapar para um arquivo que está. Veja [Verificação](#-verificação).

---

## ✅ Verificação

Duas camadas, de propósito. `bun run check` é determinístico e roda offline — é o
que o CI executa e o que precisa estar verde antes de qualquer commit. Os `smoke`
batem em provider de verdade: provam a integração, mas dependem de site de
terceiro no ar, então nunca entram no CI.

```powershell
bun run check           # lint + typecheck + segredos + testes (sem rede, ~25s)

bun run lint            # biome: correctness, suspicious, complexity, performance,
                        # security — aviso conta como erro
bun run lint:fix        # aplica as correções seguras
bun run typecheck       # tsc --noEmit sobre src, scripts e tests
bun run secrets         # credenciais e dados pessoais nos arquivos versionados
bun run secrets:history # o mesmo, em todo blob de todo commit (auditoria)
bun run test            # bun test: assinatura HMAC, allowlist de host, travessia
                        # de caminho, CBZ/CBR, EPUB, retry/backoff, tradutores,
                        # agregação, versão da release
```

O **linter é o Biome**. `style` e `a11y` ficam de fora para a regra do linter não
virar refactor de arquivo inteiro; as cinco categorias que apontam *defeito* estão
ligadas, e cada exceção tem o motivo escrito ao lado dela em `biome.jsonc`.

A **varredura de segredos** procura chave de OpenAI/OpenRouter, token de GitHub,
credencial AWS/Google/Slack, chave privada, JWT, credencial embutida em URL,
segredo escrito no código e caminho pessoal. Placeholder de documentação
(`sk-or-v1-...`) não reprova; a permissão é por igualdade exata, nunca por
"contém", para não virar porta dos fundos. O achado mostra arquivo, linha e regra —
**nunca o segredo inteiro**, para não trocar um vazamento por outro no log do CI.

```powershell
bun run smoke           # API: providers, filtros, ciclo busca→série→páginas→imagem,
                        # recusa de URL não assinada, tessdata, health da IA
bun run smoke:browser   # UI real no chromium: zoom no scroll, arrasto, duplo clique,
                        # navegador em miniatura, OCR de verdade, modo tira, EPUB
bun run smoke:desktop   # app Tauri compilado, inspecionado por CDP: porta do sidecar,
                        # CORS, canvas não-tainted, assets do OCR, sidecar sem órfão

# diagnóstico quando algo dá errado
node scripts/ocr-probe.mjs 10     # qualidade crua do OCR numa página real
bun run scripts/ai-probe.ts       # resposta CRUA do LLM no prompt de tradução
node scripts/make-test-cbz.mjs    # cria .testlib com CBZ + pasta para o provider local
```

### Release automática

Todo commit que entra na `main` vira **tag e release**, pelo workflow
`.github/workflows/release.yml`. A versão sai do prefixo dos commits
(Conventional Commits, que o `AGENTS.md` já exige):

| Prefixo | Sobe |
|---|---|
| `feat:` | minor (`0.4.0` → `0.5.0`) |
| `fix:`, ou qualquer outro assunto | patch (`0.4.0` → `0.4.1`) |
| `tipo!:` ou `BREAKING CHANGE:` no corpo | major (`0.4.0` → `1.0.0`) |

O commit de merge do GitHub não conta — quem descreve a mudança são os commits
dentro dele. As notas saem agrupadas por prefixo (Novidades / Correções /
Desempenho / Por dentro). O cálculo mora em `scripts/release-notes.ts` e **tem
teste**, porque versão publicada não se despublica; para ver o que sairia sem
publicar nada:

```powershell
bun run scripts/release-notes.ts
```

### Armadilhas já pagas

- **Detectar o Tauri pelo protocolo não funciona**: na v2 o Windows serve o app em
  `http://tauri.localhost`. Testar `location.protocol` fazia o front chamar
  `/api/search` no próprio bundle e receber o `index.html` — o sintoma é
  `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. A detecção correta é
  pela presença de `__TAURI_INTERNALS__`.
- **Canvas tainted mata o OCR**: com o front em `tauri.localhost` e a API em
  `127.0.0.1`, sem `Access-Control-Allow-Origin` + `img.crossOrigin` o
  `getImageData` lança e o OCR nunca roda.
- **CSP própria quebra o `invoke`**: o bridge do Tauri chama
  `http://ipc.localhost/<comando>`, então `connect-src` precisa listar
  `ipc: http://ipc.localhost`.
- **Pré-carregar imagem sem `crossOrigin`** deixa no cache uma resposta sem
  cabeçalho CORS, e o `<img>` do leitor herda ela — canvas tainted mesmo com o
  atributo correto no elemento visível.
- **A allowlist do proxy vale a cada salto do redirect**, de propósito — senão um
  CDN da lista que responda 302 levaria o proxy a um host interno. Provider novo
  precisa registrar o host do **CDN**, não só o do site: o Archive serve a página
  por `ia802800.us.archive.org`, e sem o sufixo toda HQ morria em `403`.
- **`lto = true` estoura o rustc** nesta máquina (`LLVM ERROR: out of memory`).
- **Modelo que raciocina volta `content` vazio** se o `max_tokens` for apertado —
  o lote de tradução dimensiona o orçamento pelo tamanho do lote, e o servidor
  loga `finish_reason` quando vem vazio.
- **Sidecar órfão**: se a janela morre a seco, o evento de saída do Tauri não
  roda; por isso o servidor recebe `PARENT_PID` e se encerra sozinho.

---

## 🚧 Limites conhecidos

- O OCR continua sendo o Tesseract: texto estilizado, japonês horizontal e
  onomatopeia desenhada ainda saem com erro. Modelos treinados em mangá
  (`hayai-ocr-v2`, `manga-ocr`) têm ONNX publicado, mas pesam 140+ MB — ver
  `.workflow/6-ocr-translation-research/research.md`.
- Sem o detector neural (offline no primeiro uso, ou desligado), página colorida e
  texto fora de balão voltam a depender da passada de página inteira, que rende menos.
- Com modelo local de 7B (`qwen2.5:7b-instruct`), o capítulo 1 de Naruto sai
  inteiro (59 páginas, ~9 s/página numa RTX 4060 Ti), mas com erros de tradução
  visíveis e erro de OCR que o glossário pode congelar ("OCEMON FOX"). Use
  **limpar memória da obra** se isso acontecer, ou um modelo maior.
- MangaPill e Weeb Central são HTML: mudança de layout no site quebra o parser
  (o provider cai sozinho, sem derrubar a busca).
- Capítulo do MangaDex com `pages: 0` é link externo e fica fora da lista.
- PDF de **texto** (sem bitmap na página) ainda não renderiza no leitor — a rota
  responde `415` explicando. PDF escaneado funciona.
- `.cb7` (7-Zip) não é lido: as bibliotecas WASM disponíveis têm licença indefinida
  ou são feitas só para browser.
