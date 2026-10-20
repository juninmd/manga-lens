import type { MadaraSite } from './madara.ts';

/** Researched and live-tested origins/CDNs. Never extend this list from scraped content. */
export const builtinMadaraSites: MadaraSite[] = [
  {
    "id": "mangaread",
    "name": "MangaRead",
    "base": "https://www.mangaread.org",
    "lang": "en",
    "contentType": "manga",
    "imageHosts": []
  },
  {
    "id": "manhuaplus",
    "name": "Manhua Plus",
    "base": "https://manhuaplus.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.manhuaplus.com"
    ]
  },
  {
    "id": "mangadistrict",
    "name": "Manga District",
    "base": "https://mangadistrict.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "series",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.mangadistrict.com"
    ]
  },
  {
    "id": "zinmanga",
    "name": "Zinmanga",
    "base": "https://mangazin.org",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "manhuatop.org",
      "img-1.mangazin.org"
    ]
  },
  {
    "id": "toonily",
    "name": "Toonily",
    "base": "https://toonily.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "serie",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "data.tnlycdn.com",
      "static.tnlycdn.com"
    ]
  },
  {
    "id": "apollcomics",
    "name": "ApollComics",
    "base": "https://apollcomics.es",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn1.apollcomics.es"
    ]
  },
  {
    "id": "inventariooculto",
    "name": "Inventario Oculto",
    "base": "https://inventariooculto.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "hadesnofansub",
    "name": "Hades no Fansub",
    "base": "https://lectorhades.latamtoon.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "tmo",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "kazokuden",
    "name": "Kazoku Den",
    "base": "https://www.kazokuden.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "manhuaonline",
    "name": "SamuraiScan",
    "base": "https://samurai.j5z.xyz",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "son",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "inmortalscan",
    "name": "Inmortal Scan",
    "base": "https://scan-inmortal.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "mg",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "wp.scaninmortal.store"
    ]
  },
  {
    "id": "mhscans",
    "name": "MHScans",
    "base": "https://mhscans.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "series",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "monopolyscan",
    "name": "Monopoly Scan",
    "base": "https://monopolymanhua.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "mundomanhwa",
    "name": "Mundo Manhwa",
    "base": "https://mundomanhwa.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn1.mundomanhwa.com"
    ]
  },
  {
    "id": "ragnarokscanlation",
    "name": "Ragnarok Scanlation",
    "base": "https://ragnarokscanlation.org",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "series",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "richtoscan",
    "name": "RichtoScan",
    "base": "https://r1.richtoon.top",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "yurionline",
    "name": "Yuri-Online",
    "base": "https://yuri-online.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "bananascan",
    "name": "Harmony-Scan",
    "base": "https://harmony-scan.fr",
    "lang": "fr",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "vermanhwas",
    "name": "Ver Manhwas",
    "base": "https://vermanhwa.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn4.vermanhwa.com"
    ]
  },
  {
    "id": "euphoriascan",
    "name": "Euphoria Scan",
    "base": "https://euphoriascan.com",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "cafecomyaoi",
    "name": "Café com Yaoi",
    "base": "https://cafecomyaoi.com.br",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "fleurblanche",
    "name": "Fleur Blanche",
    "base": "https://fbsquadx.com",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "amuy",
    "name": "Amuy",
    "base": "https://www.apenasmaisumyaoi.com",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "huntersscans",
    "name": "Hunters Scans",
    "base": "https://readhunters.xyz",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "read",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "kamisamaexplorer",
    "name": "Kami Sama Explorer",
    "base": "https://leitor.kamisama.com.br",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "inkapk",
    "name": "Inkapk",
    "base": "https://inkapk.net",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "obras",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "littletyrant",
    "name": "Little Tyrant",
    "base": "https://tiraninha.world",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "montetai",
    "name": "Monte Tai",
    "base": "https://montetaiscanlator.xyz",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.montetaiscanlator.xyz"
    ]
  },
  {
    "id": "ninjascan",
    "name": "Ninja Scan",
    "base": "https://ninjacomics.xyz",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "nebulosascan",
    "name": "Nebulosa Scan",
    "base": "https://nebulosascan.com",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "noindexscan",
    "name": "Hanami Heaven",
    "base": "https://hanamiheaven.org",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "nocturnesummer",
    "name": "Nocturne Summer",
    "base": "https://nocfsb.com",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "yuriverso",
    "name": "Yuri on Air",
    "base": "https://yurionair.top",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "mrtenzus",
    "name": "MR Tenzus",
    "base": "https://mrtenzus.com",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "anisascans",
    "name": "Anisa Scans",
    "base": "https://anisascans.in",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "like.mgread.io"
    ]
  },
  {
    "id": "decadencescans",
    "name": "Decadence Scans",
    "base": "https://reader.decadencescans.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "bunmanga",
    "name": "Bun Manga",
    "base": "https://bunmanga.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.bunmanga.com"
    ]
  },
  {
    "id": "cocomic",
    "name": "Cocomic",
    "base": "https://cocomic.co",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "img.cocomic.co"
    ]
  },
  {
    "id": "gakamangas",
    "name": "GakaMangas",
    "base": "https://gakamangas.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "hunlightcomics",
    "name": "Hunlight Comics",
    "base": "https://hunlightcomics.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "m",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "ksgroupscans",
    "name": "KSGroupScans",
    "base": "https://ksgroupscans.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "lhtranslation",
    "name": "LHTranslation",
    "base": "https://lhtranslation.net",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "likemangain",
    "name": "MangaYY",
    "base": "https://mangayy.org",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "like.mgread.io"
    ]
  },
  {
    "id": "mangasushi",
    "name": "Mangasushi",
    "base": "https://mangasushi.org",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "manhuahot",
    "name": "ManhuaHot",
    "base": "https://manhuahot.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.manhuahot.com"
    ]
  },
  {
    "id": "mangaowlio",
    "name": "MangaOwl.io (unoriginal)",
    "base": "https://mangaowl.io",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "read-1",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "manhuanext",
    "name": "Manhuanext",
    "base": "https://manhuanext.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "manhwanex",
    "name": "ManhwaNex",
    "base": "https://manhwanex.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.manhwanex.com"
    ]
  },
  {
    "id": "manhwareads",
    "name": "Manhwa Reads",
    "base": "https://manhwareads.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "manhwatoon",
    "name": "Manhwa Toon",
    "base": "https://www.manhwatoon.me",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manhwa",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.manhwatoon.me"
    ]
  },
  {
    "id": "s2manga",
    "name": "S2Manga",
    "base": "https://s2read.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn-1.s2read.com"
    ]
  },
  {
    "id": "sleepytranslations",
    "name": "Sleepy Translations",
    "base": "https://sleepytranslations.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "series",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "i0.wp.com",
      "i1.wp.com",
      "i2.wp.com",
      "i3.wp.com"
    ]
  },
  {
    "id": "topmanhua",
    "name": "Top Manhua",
    "base": "https://mangatop.org",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "series",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "manhuatop.org",
      "st-3.mangatop.org"
    ]
  },
  {
    "id": "tritiniascans",
    "name": "TritiniaScans",
    "base": "https://tritinia.org",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "wearehunger",
    "name": "KokoMangas",
    "base": "https://kokomangas.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "yakshacomics",
    "name": "YakshaComics",
    "base": "https://yakshacomics.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "mangalivre",
    "name": "MangaLivre",
    "base": "https://mangalivre.to",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  }
];

export const builtinThemesiaSites: MadaraSite[] = [
  {
    "id": "celestialmoon",
    "name": "Celestial Moon",
    "base": "https://celestialmoonscan.es",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "el-mayordomo-mas-fuerte-de-la-casa-del-villano",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "asialotus",
    "name": "Asia Lotus",
    "base": "https://asialotuss.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "img.gopar.dev"
    ]
  },
  {
    "id": "bymichiscan",
    "name": "Bymichi Scan",
    "base": "https://bymichiby.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "cerberusseries",
    "name": "Cerberus Series",
    "base": "https://legionscans.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "wp",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "i0.wp.com",
      "i3.wp.com",
      "i2.wp.com",
      "i1.wp.com"
    ]
  },
  {
    "id": "uchuujinprojects",
    "name": "Uchuujin Projects",
    "base": "https://uchuujinmangas.com",
    "lang": "es",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "img.uchuujinmangas.com"
    ]
  },
  {
    "id": "lelmanga",
    "name": "Lelmanga",
    "base": "https://www.lelmanga.com",
    "lang": "fr",
    "contentType": "manga",
    "seriesPath": "manhwa",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "i1.wp.com",
      "i2.wp.com",
      "i0.wp.com",
      "i3.wp.com"
    ]
  },
  {
    "id": "tsundokutraducoes",
    "name": "Tsundoku Traduções",
    "base": "https://tsundoku.com.br",
    "lang": "pt-br",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "i3.wp.com",
      "i0.wp.com",
      "i1.wp.com",
      "i2.wp.com"
    ]
  },
  {
    "id": "akazascans",
    "name": "Akaza Scans",
    "base": "https://akazascans.org",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "asterscans",
    "name": "Aster Scans",
    "base": "https://asterscans.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "i2.wp.com",
      "i1.wp.com",
      "i0.wp.com",
      "i3.wp.com"
    ]
  },
  {
    "id": "arenascans",
    "name": "Arena Scans",
    "base": "https://arenascan.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.arenascan.com"
    ]
  },
  {
    "id": "athreascans",
    "name": "Athrea Scans",
    "base": "https://athreascans.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "culturedworks",
    "name": "CulturedWorks",
    "base": "https://culturedworks.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.uqni.net"
    ]
  },
  {
    "id": "elftoon",
    "name": "Elf Toon",
    "base": "https://elftoon.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "i2.wp.com",
      "i0.wp.com",
      "i1.wp.com",
      "i3.wp.com"
    ]
  },
  {
    "id": "evascans",
    "name": "Eva Scans",
    "base": "https://evascans.net",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "series",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "i1.wp.com",
      "i0.wp.com",
      "i2.wp.com",
      "i3.wp.com"
    ]
  },
  {
    "id": "galaxymanga",
    "name": "Galaxy Manga",
    "base": "https://galaxymanga.io",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "dl.galaxymanga.io"
    ]
  },
  {
    "id": "kingofshojo",
    "name": "King of Shojo",
    "base": "https://kingofshojo.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.kingofshojo.com"
    ]
  },
  {
    "id": "lagoonscans",
    "name": "Lagoon Scans",
    "base": "https://lagoonscans.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "i3.wp.com",
      "i0.wp.com",
      "i1.wp.com",
      "i2.wp.com"
    ]
  },
  {
    "id": "mangatrend",
    "name": "Manga Trend",
    "base": "https://mangatrend.org",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "i3.wp.com",
      "i2.wp.com",
      "i0.wp.com",
      "i1.wp.com"
    ]
  },
  {
    "id": "rackus",
    "name": "Rackus",
    "base": "https://rackusreads.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "ravenscans",
    "name": "Raven Scans",
    "base": "https://ravenscans.org",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn5.ravenscans.org"
    ]
  },
  {
    "id": "rokaricomics",
    "name": "RokariComics",
    "base": "https://rokaricomics.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "manga",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "rizzcomic",
    "name": "Rizz Comic",
    "base": "https://rizzfables.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "series",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": [
      "cdn.55779955.xyz",
      "cdn.rizzfables.com"
    ]
  },
  {
    "id": "thunderscans",
    "name": "Thunder Scans",
    "base": "https://en-thunderscans.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "comics",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  },
  {
    "id": "violetscans",
    "name": "Violet Scans",
    "base": "https://violetmanga.com",
    "lang": "en",
    "contentType": "manga",
    "seriesPath": "comics",
    "userAgent": "MangaLens/0.1.0",
    "imageHosts": []
  }
];
