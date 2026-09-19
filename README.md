# MangaLens

Leitor de mangás/HQs — app **desktop (Tauri)** com catálogo multi-provider, filtro
completo, **OCR + tradução pt-BR na hora** e um assistente de IA que explica o
contexto da cena. O visualizador imita o do **Google Picasa**: zoom com o scroll
ancorado no cursor, arrastar a página com o mouse e navegador em miniatura.

## Como roda

```
Tauri (janela + WebView2)
  ├─ front  → public/  (bundle Bun: catálogo, visualizador, OCR no browser)
  └─ sidecar → manga-lens-server (Bun compilado): providers, proxy de imagem, LLM
```

O front nunca fala direto com os sites: toda imagem passa por `/api/img`, com URL
**assinada em HMAC** e host em allowlist. O OCR roda na máquina (Tesseract WASM);
só o texto reconhecido vai para o LLM.

## Providers

| Provider | Tipo | Filtros aplicados no upstream |
|---|---|---|
| **MangaDex** | API oficial | busca, idioma da tradução, idioma original, tags, status, demografia, classificação, ano, ordenação |
| **Weeb Central** | HTML | busca, tags (incluir/excluir), status, tipo, ordenação |
| **MangaPill** | HTML | busca, gênero, status, tipo |
| **MangaRead** (tema Madara) | HTML | busca, gênero, status, ordenação |
| **Biblioteca local** | disco | pastas de imagens e arquivos `.cbz`/`.zip` |

O provider **Madara** é genérico: um parser atende qualquer site que use esse tema
WordPress. Para somar outros, sem tocar em código:

```
MADARA_SITES=meusite|Meu Site|https://exemplo.org|pt-br;outro|Outro|https://outro.com|en
```

Cada site declarado vira um provider próprio, com o host já liberado no proxy de
imagem. (Manganato virou domínio parqueado e o AsuraComic só entrega payload de
React server component — os dois ficaram de fora por isso.)

> **MangaRead bloqueia por volume.** Depois de algumas dezenas de requisições ele
> passa a responder **403** para o IP, e header de browser não contorna. Por isso
> a lista de capítulos é cacheada por 6 h, e a homologação trata `403`/`429` de
> provider como **aviso**, não falha — vermelho continua significando bug nosso.

A busca vai nos providers em paralelo e intercala os resultados; provider que cai
vira aviso na barra de status, não erro fatal. O que o provider não filtra no
upstream é filtrado no servidor (ano em faixa, tipo, tags excluídas).

Para a biblioteca local, aponte `LOCAL_LIBRARY` para uma ou mais pastas
(separadas por `;`). Cada subpasta vira uma obra; `.cbz` e subpastas viram
capítulos. O ZIP é lido por um parser próprio, sem dependência externa.

## OCR e tradução

1. **Detecção de balões** — duas fontes, fundidas:
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
   opções), a heurística trabalha sozinha, como antes.
2. **Reconhecimento** — cada texto é recortado da página pré-processada (2×,
   cinza, contraste), com **tudo o que está fora do balão branqueado** (contorno e
   arte vizinha viravam letras falsas), e reconhecido em PSM 6 (ou PSM 5 para
   japonês vertical). Nas páginas com gabarito (`.workflow/5-competitive-quality`):
   frases achadas 7/17 → 12/17, CER 0,56 → 0,35, 35% mais rápido.
3. **Tradução** — a **página inteira** vai num pedido só ao LLM, com os balões na
   **ordem de leitura** (faixas de altura, da direita para a esquerda em mangá). O
   prompt leva a **memória da obra** — glossário de nomes com gênero e um resumo das
   últimas páginas *anteriores* (nunca das seguintes) — e regras de nome próprio e
   gênero neutro quando o original não diz. A resposta devolve a tradução ancorada
   por `id` e o que aprendeu na página, gravado em `.cache/series-memory`. Lixo de
   OCR repetido (`●●●●…`) é cortado antes de chegar a qualquer motor.
4. **Letreiramento** — a tradução é **composta no lugar do texto original**, não
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

### Traduzindo os capítulos em sequência

Com **traduzir** ligado, uma fila roda em segundo plano: termina as páginas
restantes do capítulo atual e **segue pelos próximos capítulos**, na ordem, um
item por vez (OCR é pesado e a leitura tem prioridade — a fila cede a vez sempre
que você pede OCR da página). O resultado fica em cache por
`capítulo:página`, então virar a página ou avançar de capítulo já encontra a
tradução pronta. Desligar o botão para a fila na hora.

O idioma do OCR é o do **scan**, não o da obra: Naruto é japonês, mas o capítulo
publicado em inglês é reconhecido com `eng`. Modelos (`.traineddata`) são baixados
uma vez e ficam no cache do app.

### Traduzir sem IA

O seletor na barra do leitor escolhe o motor:

| Motor | Precisa de IA | Comportamento |
|---|---|---|
| **IA (contexto)** | sim | corrige o ruído do OCR antes de traduzir, entende gíria e onomatopeia |
| **Google** | não | endpoint público do tradutor, sem chave; rápido e literal |
| **MyMemory** | não | reserva quando o Google recusa; cota diária no plano anônimo |

Os motores sem IA não sabem consertar OCR, então o servidor descarta antes o que
tem menos de duas letras de verdade — sem isso um balão de ruído viraria uma
requisição desperdiçada e uma legenda sem sentido na página.

Há dois caminhos alternativos:
- **`IA lê a página`** — manda a página inteira para um modelo com visão
  (`AI_VISION_MODEL`), útil para texto vertical estilizado que o OCR erra.
- **`explicar`** — chat em streaming sobre a cena, com a sinopse e o texto já
  reconhecido como contexto, instruído a não dar spoiler além do ponto atual.

## Visualizador (estilo Picasa)

- **scroll** = zoom ancorado no cursor (o ponto sob o mouse não sai do lugar)
- **arrastar** = pan, com inércia ao soltar; **pinça** com dois dedos
- **duplo clique** alterna ajuste ↔ 1:1 no ponto clicado
- **navegador em miniatura** aparece no canto ao ampliar; arrastável
- modos **página / dupla / tira (webtoon)**, ajuste largura/altura/página, RTL
- filmstrip de páginas, slider de zoom, atalhos: `← →` `espaço` `+ -` `0` `1`
  `o` (OCR) `t` (original/tradução) `f` (tela cheia) `Esc`

## Onde você parou

- **Continuar lendo** — a página e o capítulo de cada obra são gravados a cada
  virada de página; a fila aparece no topo do catálogo.
- **Marcadores** — o botão 🔖 no leitor fixa a página exata; a linha "Marcadores"
  no catálogo volta direto para ela.
- **Capítulos lidos** — chegar na última página marca o capítulo. Na lista, cada
  linha tem `○/✓` para alternar à mão e `⤓` para marcar aquele e **todos os
  anteriores** (útil ao pegar uma série no meio). O painel mostra `X de Y lidos`
  e o card do catálogo traz o contador.

Tudo vive no `localStorage` do app — nada sai da máquina. O botão **⭳
Backup** na barra de cima baixa um `.json` com favoritos, progresso,
marcadores e capítulos lidos; **⭱ Importar** restaura esse arquivo (em
qualquer máquina) sem precisar de conta nem serviço externo.

## Rodando

```powershell
bun install
copy .env.example .env      # ajuste AI_BASE_URL / AI_MODEL / LOCAL_LIBRARY

# app desktop
bun run desktop             # tauri dev
bun run desktop:build       # instalador NSIS em src-tauri/target/release/bundle

# modo web (mesmo servidor, sem Tauri)
bun run dev                 # http://localhost:7788
```

O app escolhe uma porta livre para o sidecar e a entrega ao front pelo comando
`api_port`; o processo do servidor é morto junto com a janela.

## Configuração de IA

A IA é integrada via **Vercel AI SDK**, permitindo escolher o provider através da variável `AI_PROVIDER`:

| Provider | `AI_PROVIDER` | Descrição |
|---|---|---|
| **Ollama** (padrão) | `ollama` | Execução local com modelos como `qwen2.5:7b-instruct`. Modelos com raciocínio (`qwen3.x`, `deepseek-r1`) rodam com `reasoning_effort: none` — senão gastam o limite de tokens pensando e devolvem resposta vazia. A tradução usa a saída JSON com gramática do Ollama (`response_format: json_object`) |
| **OpenRouter** | `openrouter` | Gateway em nuvem para dezenas de modelos (Llama 3.3, Claude, GPT, etc.) |
| **OpenAI-Compatible** | `openaicompatible` | Qualquer endpoint compatível (LM Studio, vLLM, LiteLLM, Groq, etc.) |

Exemplo de `.env`:

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

O selo no canto inferior mostra o provider e modelo ativo ou o erro de conexão. Estar
listado em `/v1/models` não prova que o modelo responde — o teste real é pedir
uma tradução.

## Verificação

Duas camadas, de propósito. `bun run check` é determinístico e roda offline — é o
que o CI executa e o que precisa estar verde antes de qualquer commit. Os `smoke`
batem em provider de verdade: provam a integração, mas dependem de site de
terceiro no ar, então nunca entram no CI.

```powershell
bun run check           # lint + typecheck + testes unitários (sem rede, ~7s)
bun run lint            # oxlint, categoria correctness, aviso é erro
bun run typecheck       # tsc --noEmit sobre src, scripts e tests
bun run test            # bun test: assinatura HMAC, allowlist de host, travessia
                        # de caminho, CBZ, retry/backoff, tradutores, agregação
```

```powershell
bun run smoke           # API: providers, filtros, ciclo busca→série→páginas→imagem,
                        # recusa de URL não assinada, tessdata, health da IA
bun run smoke:browser   # UI real no chromium: zoom no scroll, arrasto, duplo clique,
                        # navegador em miniatura, OCR de verdade, modo tira
bun run smoke:desktop   # app Tauri compilado, inspecionado por CDP: porta do sidecar,
                        # CORS, canvas não-tainted, assets do OCR, sidecar sem órfão

# diagnóstico quando algo dá errado
node scripts/ocr-probe.mjs 10     # qualidade crua do OCR numa página real
bun run scripts/ai-probe.ts       # resposta CRUA do LLM no prompt de tradução
node scripts/make-test-cbz.mjs    # cria .testlib com CBZ + pasta para o provider local
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
- **`lto = true` estoura o rustc** nesta máquina (`LLVM ERROR: out of memory`).
- **Modelo que raciocina volta `content` vazio** se o `max_tokens` for apertado —
  o lote de tradução dimensiona o orçamento pelo tamanho do lote, e o servidor
  loga `finish_reason` quando vem vazio.
- **Sidecar órfão**: se a janela morre a seco, o evento de saída do Tauri não
  roda; por isso o servidor recebe `PARENT_PID` e se encerra sozinho.

## Limites conhecidos

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
