# Fontes de HQs e mangás

Foram adicionadas **81 fontes**: 80 de mangás e uma de HQs (HQ Now, em português). O catálogo padrão tem **87 fontes online** e a biblioteca local. As fontes novas e MangaRead cobrem português, inglês, espanhol e francês.

## Validação real em 30/09/2026

**79 das 81 fontes novas passaram** por busca, detalhes da obra, capítulo e imagens via proxy assinado do app. As páginas inicial, intermediária e final do capítulo foram baixadas, além da capa quando disponível. O teste usa uma obra legível por fonte; não comprova todo o acervo. [Resultados com horários e amostras](sources-validation.json).

Elf Toon já tinha passado na leitura direta durante a pesquisa, mas respondeu HTTP 403 na validação pelo app. Rizz Fables também passou na leitura direta; na validação pelo app, seu CDN retornou HTTP 526. Permanecem disponíveis como fontes, com erros apresentados ao usuário; não contam como aprovadas no teste final.

O smoke completo incluiu as seis fontes anteriores: MangaDex, Weeb Central, MangaRead e Internet Archive passaram. MangaPill retornou catálogo vazio para busca sem termo, e ReadAllComics excedeu o prazo de busca. Esses dois resultados são limitações existentes e não entram nos 79 aprovados das fontes novas.

Os testes locais passaram: `bun run check` (280 testes) e `bun run build:client`. Após o ajuste final de cancelamento do HQ Now, lint, TypeScript e os dez testes de fontes passaram novamente. No Edge, as fontes novas apareceram no catálogo e uma página de Invencível (HQ Now) foi renderizada com 966 × 1500 pixels. A busca agregada por Naruto retornou 104 obras em 7,7 segundos, com uma falha externa registrada (Elf Toon). Os detalhes desses testes também estão no relatório JSON.

## Fontes integradas

| Fonte | ID | Idioma | Conteúdo | Adaptador | Resultado pelo app |
|---|---|---|---|---|---|
| [MangaRead](https://www.mangaread.org) | mangaread | en | Mangá | Madara | Leitura validada |
| [Manhua Plus](https://manhuaplus.com) | manhuaplus | en | Mangá | Madara | Leitura validada |
| [Manga District](https://mangadistrict.com) | mangadistrict | en | Mangá | Madara | Leitura validada |
| [Zinmanga](https://mangazin.org) | zinmanga | en | Mangá | Madara | Leitura validada |
| [Toonily](https://toonily.com) | toonily | en | Mangá | Madara | Leitura validada |
| [ApollComics](https://apollcomics.es) | apollcomics | es | Mangá | Madara | Leitura validada |
| [Inventario Oculto](https://inventariooculto.com) | inventariooculto | es | Mangá | Madara | Leitura validada |
| [Hades no Fansub](https://lectorhades.latamtoon.com) | hadesnofansub | es | Mangá | Madara | Leitura validada |
| [Kazoku Den](https://www.kazokuden.com) | kazokuden | es | Mangá | Madara | Leitura validada |
| [SamuraiScan](https://samurai.j5z.xyz) | manhuaonline | es | Mangá | Madara | Leitura validada |
| [Inmortal Scan](https://scan-inmortal.com) | inmortalscan | es | Mangá | Madara | Leitura validada |
| [MHScans](https://mhscans.com) | mhscans | es | Mangá | Madara | Leitura validada |
| [Monopoly Scan](https://monopolymanhua.com) | monopolyscan | es | Mangá | Madara | Leitura validada |
| [Mundo Manhwa](https://mundomanhwa.com) | mundomanhwa | es | Mangá | Madara | Leitura validada |
| [Ragnarok Scanlation](https://ragnarokscanlation.org) | ragnarokscanlation | es | Mangá | Madara | Leitura validada |
| [RichtoScan](https://r1.richtoon.top) | richtoscan | es | Mangá | Madara | Leitura validada |
| [Yuri-Online](https://yuri-online.com) | yurionline | es | Mangá | Madara | Leitura validada |
| [Harmony-Scan](https://harmony-scan.fr) | bananascan | fr | Mangá | Madara | Leitura validada |
| [Ver Manhwas](https://vermanhwa.com) | vermanhwas | es | Mangá | Madara | Leitura validada |
| [Euphoria Scan](https://euphoriascan.com) | euphoriascan | pt-br | Mangá | Madara | Leitura validada |
| [Café com Yaoi](https://cafecomyaoi.com.br) | cafecomyaoi | pt-br | Mangá | Madara | Leitura validada |
| [Fleur Blanche](https://fbsquadx.com) | fleurblanche | pt-br | Mangá | Madara | Leitura validada |
| [Amuy](https://www.apenasmaisumyaoi.com) | amuy | pt-br | Mangá | Madara | Leitura validada |
| [Hunters Scans](https://readhunters.xyz) | huntersscans | pt-br | Mangá | Madara | Leitura validada |
| [Kami Sama Explorer](https://leitor.kamisama.com.br) | kamisamaexplorer | pt-br | Mangá | Madara | Leitura validada |
| [Inkapk](https://inkapk.net) | inkapk | pt-br | Mangá | Madara | Leitura validada |
| [Little Tyrant](https://tiraninha.world) | littletyrant | pt-br | Mangá | Madara | Leitura validada |
| [Monte Tai](https://montetaiscanlator.xyz) | montetai | pt-br | Mangá | Madara | Leitura validada |
| [Ninja Scan](https://ninjacomics.xyz) | ninjascan | pt-br | Mangá | Madara | Leitura validada |
| [Nebulosa Scan](https://nebulosascan.com) | nebulosascan | pt-br | Mangá | Madara | Leitura validada |
| [Hanami Heaven](https://hanamiheaven.org) | noindexscan | pt-br | Mangá | Madara | Leitura validada |
| [Nocturne Summer](https://nocfsb.com) | nocturnesummer | pt-br | Mangá | Madara | Leitura validada |
| [Yuri on Air](https://yurionair.top) | yuriverso | pt-br | Mangá | Madara | Leitura validada |
| [MR Tenzus](https://mrtenzus.com) | mrtenzus | pt-br | Mangá | Madara | Leitura validada |
| [Anisa Scans](https://anisascans.in) | anisascans | en | Mangá | Madara | Leitura validada |
| [Decadence Scans](https://reader.decadencescans.com) | decadencescans | en | Mangá | Madara | Leitura validada |
| [Bun Manga](https://bunmanga.com) | bunmanga | en | Mangá | Madara | Leitura validada |
| [Cocomic](https://cocomic.co) | cocomic | en | Mangá | Madara | Leitura validada |
| [GakaMangas](https://gakamangas.com) | gakamangas | en | Mangá | Madara | Leitura validada |
| [Hunlight Comics](https://hunlightcomics.com) | hunlightcomics | en | Mangá | Madara | Leitura validada |
| [KSGroupScans](https://ksgroupscans.com) | ksgroupscans | en | Mangá | Madara | Leitura validada |
| [LHTranslation](https://lhtranslation.net) | lhtranslation | en | Mangá | Madara | Leitura validada |
| [MangaYY](https://mangayy.org) | likemangain | en | Mangá | Madara | Leitura validada |
| [Mangasushi](https://mangasushi.org) | mangasushi | en | Mangá | Madara | Leitura validada |
| [ManhuaHot](https://manhuahot.com) | manhuahot | en | Mangá | Madara | Leitura validada |
| [MangaOwl.io (unoriginal)](https://mangaowl.io) | mangaowlio | en | Mangá | Madara | Leitura validada |
| [Manhuanext](https://manhuanext.com) | manhuanext | en | Mangá | Madara | Leitura validada |
| [ManhwaNex](https://manhwanex.com) | manhwanex | en | Mangá | Madara | Leitura validada |
| [Manhwa Reads](https://manhwareads.com) | manhwareads | en | Mangá | Madara | Leitura validada |
| [Manhwa Toon](https://www.manhwatoon.me) | manhwatoon | en | Mangá | Madara | Leitura validada |
| [S2Manga](https://s2read.com) | s2manga | en | Mangá | Madara | Leitura validada |
| [Sleepy Translations](https://sleepytranslations.com) | sleepytranslations | en | Mangá | Madara | Leitura validada |
| [Top Manhua](https://mangatop.org) | topmanhua | en | Mangá | Madara | Leitura validada |
| [TritiniaScans](https://tritinia.org) | tritiniascans | en | Mangá | Madara | Leitura validada |
| [KokoMangas](https://kokomangas.com) | wearehunger | en | Mangá | Madara | Leitura validada |
| [YakshaComics](https://yakshacomics.com) | yakshacomics | en | Mangá | Madara | Leitura validada |
| [Celestial Moon](https://celestialmoonscan.es) | celestialmoon | es | Mangá | MangaThemesia | Leitura validada |
| [Asia Lotus](https://asialotuss.com) | asialotus | es | Mangá | MangaThemesia | Leitura validada |
| [Bymichi Scan](https://bymichiby.com) | bymichiscan | es | Mangá | MangaThemesia | Leitura validada |
| [Cerberus Series](https://legionscans.com) | cerberusseries | es | Mangá | MangaThemesia | Leitura validada |
| [Uchuujin Projects](https://uchuujinmangas.com) | uchuujinprojects | es | Mangá | MangaThemesia | Leitura validada |
| [Lelmanga](https://www.lelmanga.com) | lelmanga | fr | Mangá | MangaThemesia | Leitura validada |
| [Tsundoku Traduções](https://tsundoku.com.br) | tsundokutraducoes | pt-br | Mangá | MangaThemesia | Leitura validada |
| [Akaza Scans](https://akazascans.org) | akazascans | en | Mangá | MangaThemesia | Leitura validada |
| [Aster Scans](https://asterscans.com) | asterscans | en | Mangá | MangaThemesia | Leitura validada |
| [Arena Scans](https://arenascan.com) | arenascans | en | Mangá | MangaThemesia | Leitura validada |
| [Athrea Scans](https://athreascans.com) | athreascans | en | Mangá | MangaThemesia | Leitura validada |
| [CulturedWorks](https://culturedworks.com) | culturedworks | en | Mangá | MangaThemesia | Leitura validada |
| [Elf Toon](https://elftoon.com) | elftoon | en | Mangá | MangaThemesia | Upstream 403 |
| [Eva Scans](https://evascans.net) | evascans | en | Mangá | MangaThemesia | Leitura validada |
| [Galaxy Manga](https://galaxymanga.io) | galaxymanga | en | Mangá | MangaThemesia | Leitura validada |
| [King of Shojo](https://kingofshojo.com) | kingofshojo | en | Mangá | MangaThemesia | Leitura validada |
| [Lagoon Scans](https://lagoonscans.com) | lagoonscans | en | Mangá | MangaThemesia | Leitura validada |
| [Manga Trend](https://mangatrend.org) | mangatrend | en | Mangá | MangaThemesia | Leitura validada |
| [Rackus](https://rackusreads.com) | rackus | en | Mangá | MangaThemesia | Leitura validada |
| [Raven Scans](https://ravenscans.org) | ravenscans | en | Mangá | MangaThemesia | Leitura validada |
| [RokariComics](https://rokaricomics.com) | rokaricomics | en | Mangá | MangaThemesia | Leitura validada |
| [Rizz Comic](https://rizzfables.com) | rizzcomic | en | Mangá | MangaThemesia | CDN 526 |
| [Thunder Scans](https://en-thunderscans.com) | thunderscans | en | Mangá | MangaThemesia | Leitura validada |
| [Violet Scans](https://violetmanga.com) | violetscans | en | Mangá | MangaThemesia | Leitura validada |
| [HQ Now](https://www.hq-now.com) | hqnow | pt-br | HQ | GraphQL | Leitura validada |
| [MangaKatana](https://mangakatana.com) | mangakatana | en | Mangá | HTML | Leitura validada |

As outras cinco fontes anteriores são [MangaDex](https://mangadex.org), [Weeb Central](https://weebcentral.com), [MangaPill](https://mangapill.com), [ReadAllComics](https://readallcomics.com) e [Internet Archive](https://archive.org). MangaRead já existia e aparece na tabela por compartilhar o adaptador Madara.

## Pesquisa e limites

Foram consultados catálogos de 170 sites com temas Madara/MangaThemesia, além de candidatos com formatos próprios. O [catálogo público Keiyoushi](https://github.com/keiyoushi/extensions-source) ajudou a identificar nomes, origens e famílias; a inclusão dependeu de respostas dos próprios sites e da leitura de imagens. A lista de origens e CDNs é explícita no código, sem liberar hosts encontrados arbitrariamente no HTML. Payloads JavaScript de leitores são extraídos como dados, sem eval.

Sites estacionados, com leitor protegido por login/senha, TLS inválido, páginas de novels ou leitores incompatíveis ficaram fora. Exemplos: MangaBuddy redireciona para outro layout; Xoxo retornou HTML em vez das imagens; Digital Comic Museum bloqueou a consulta. Os seguintes candidatos não passaram pela leitura direta e ficaram fora do catálogo:

| ID pesquisado | Resultado |
|---|---|
| manhuatop | Error: imagem invalida |
| manhwatop | Error: imagem invalida |
| marmota | Error: Marmota: capitulo sem paginas |
| manhwaonline | Error: upstream 403 (manhwa-online.com) |
| pantheonscan | Error: busca vazia |
| borutoexplorer | Error: Boruto Explorer: capitulo sem paginas |
| hotcabaretscan | Error: Hot Cabaret Scan: capitulo sem paginas |
| mangahubfr | Error: MangaHub.fr: capitulo sem paginas |
| portalyaoi | Error: Portal Yaoi: capitulo sem paginas |
| galaxydegenscans | Error: sem capitulos |
| jinmangas | Error: busca vazia |
| kunmangaonline | Error: imagem invalida |
| lilymanga | Error: sem capitulos |
| mangadass | Error: Manga Dass: leitor de paginas nao encontrado |
| mangagg | Error: imagem invalida |
| manhwaget | Error: falha de rede: Error: Unable to connect. Is the computer able to access the url? |
| madaradex | Error: imagem invalida |
| topmanhuafan | Error: imagem invalida |
| topmanhuanet | Error: upstream 526 (cdn.topmanhua.net) |
| wuxiaworld | Error: WuxiaWorld: capitulo sem paginas |
| zazamanga | Error: imagem invalida |
| bloomscans | Error: sem capitulos |
| zinmanganet | Error: imagem invalida |
| mangatv | Error: Manga TV: capitulo sem paginas |
| nekoscans | Error: sem capitulos |
| toonizy | Error: sem capitulos |
| erosscans | Error: Scythe Scans: capitulo sem paginas |

## Repetir a validação

Com o servidor aberto (bun run start), execute:

```powershell
bun run smoke:sources
# Apenas fontes escolhidas, com servidor em outra porta:
$env:SOURCE_SMOKE_BASE = 'http://127.0.0.1:7798'
$env:SOURCE_SMOKE_IDS = 'hqnow,mangakatana,amuy'
bun run smoke:sources
```

O relatório vai para .cache/source-smoke.json (SOURCE_SMOKE_REPORT altera o destino). HTTP 403/429, erros de certificado, catálogo vazio e imagens inválidas fazem o comando falhar. Disponibilidade de terceiros pode mudar a qualquer momento.

## Mais sites Madara

MADARA_SITES aceita entradas separadas por ponto e vírgula no formato id|Nome|https://origem|idioma|manga-ou-hq|caminho-da-serie|cdn1,cdn2. Os campos de tipo, caminho e CDNs são opcionais. Reutilizar um ID substitui a configuração embutida. Somente origens HTTPS são aceitas; informe apenas CDNs que você verificou.

```dotenv
MADARA_SITES=meusite|Meu Site|https://exemplo.org|pt-br|hq|comic|cdn.exemplo.org
```
