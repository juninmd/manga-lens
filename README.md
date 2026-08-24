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

1. **Detecção de balões** — a análise de layout do Tesseract se perde na arte e
   devolve a página inteira num parágrafo só. Antes do OCR, o cliente acha as
   manchas brancas fechadas (componentes conexos), filtra por área, preenchimento,
   proporção e quantidade de tinta interna, e trata cada uma como uma região.
2. **Reconhecimento** — cada região é recortada da página pré-processada (2×,
   cinza, contraste) e reconhecida em PSM 6 (ou PSM 5 para japonês vertical).
3. **Tradução** — os balões vão em lote para o LLM, que corrige o ruído do OCR e
   devolve pt-BR ancorado por `id`.
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

Tudo vive no `localStorage` do app — nada sai da máquina.

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

Qualquer endpoint **OpenAI-compatible** serve — Ollama, LiteLLM, vLLM, LM Studio:

```
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_API_KEY=ollama
AI_MODEL=qwen2.5:7b-instruct
AI_VISION_MODEL=            # opcional, habilita "IA lê a página"
AI_MAX_TOKENS=1200          # modelos de raciocínio voltam vazios com valor baixo
```

O selo no canto inferior mostra o modelo ativo ou o erro de conexão. Estar
listado em `/v1/models` não prova que o modelo responde — o teste real é pedir
uma tradução.

## Verificação

```powershell
bun run smoke           # API: providers, filtros, ciclo busca→série→páginas→imagem,
                        # recusa de URL não assinada, tessdata, health da IA
bun run smoke:browser   # UI real no chromium: zoom no scroll, arrasto, duplo clique,
                        # navegador em miniatura, OCR de verdade, modo tira
bun run smoke:desktop   # app Tauri compilado, inspecionado por CDP: porta do sidecar,
                        # CORS, canvas não-tainted, assets do OCR, sidecar sem órfão
bunx tsc --noEmit

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

- A detecção de balões é heurística: página colorida ou HQ ocidental com texto
  fora de balão cai no OCR da página inteira, que rende menos.
- Regiões brancas grandes e vizinhas podem ser mescladas num balão só.
- MangaPill e Weeb Central são HTML: mudança de layout no site quebra o parser
  (o provider cai sozinho, sem derrubar a busca).
- Capítulo do MangaDex com `pages: 0` é link externo e fica fora da lista.
