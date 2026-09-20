import { describe, expect, test } from 'bun:test';
import { COMIC_INFO_RE, parseComicInfo } from '../src/server/comic-info.ts';

const MANGA = `<?xml version="1.0"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Series>Naruto</Series>
  <Number>12</Number>
  <Title>O exame chunin</Title>
  <Summary><![CDATA[Resumo com <b>marcacao</b> & "aspas".]]></Summary>
  <Year>2001</Year>
  <Writer>Masashi Kishimoto</Writer>
  <Genre>Acao, Aventura</Genre>
  <LanguageISO>ja</LanguageISO>
  <Manga>YesAndRightToLeft</Manga>
  <PageCount>19</PageCount>
</ComicInfo>`;

const HQ = `<ComicInfo>
  <Series lang="en">Whiz Comics</Series>
  <Number>2</Number>
  <Manga>No</Manga>
  <LanguageISO>EN</LanguageISO>
  <Summary>Captain Marvel &amp; cia.</Summary>
</ComicInfo>`;

describe('parseComicInfo', () => {
  test('le os campos de um ComicInfo de manga', () => {
    const info = parseComicInfo(MANGA);
    expect(info.series).toBe('Naruto');
    expect(info.number).toBe('12');
    expect(info.year).toBe(2001);
    expect(info.writer).toBe('Masashi Kishimoto');
    expect(info.genres).toEqual(['Acao', 'Aventura']);
    expect(info.pageCount).toBe(19);
  });

  test('Manga=YesAndRightToLeft define o sentido de leitura', () => {
    const info = parseComicInfo(MANGA);
    expect(info.manga).toBe(true);
    expect(info.rtl).toBe(true);
  });

  test('Manga=No e HQ ocidental, e o idioma vem normalizado', () => {
    const info = parseComicInfo(HQ);
    expect(info.manga).toBe(false);
    expect(info.rtl).toBe(false);
    expect(info.lang).toBe('en');
  });

  test('elemento com atributo ainda casa', () => {
    // `<Series lang="en">` e' comum nos scrapers; com borda de palavra errada no
    // regex o campo sumia justamente nos arquivos mais completos
    expect(parseComicInfo(HQ).series).toBe('Whiz Comics');
  });

  test('CDATA e entidades chegam como texto', () => {
    expect(parseComicInfo(MANGA).summary).toBe('Resumo com <b>marcacao</b> & "aspas".');
    expect(parseComicInfo(HQ).summary).toBe('Captain Marvel & cia.');
  });

  test('Manga ausente fica undefined — omitir nao e declarar "e HQ"', () => {
    // ComicInfo so com Series/Number e' comum; ler a omissao como "No" jogava
    // todo CBZ de manga assim na aba de HQ e em LTR
    const info = parseComicInfo('<ComicInfo><Series>Um</Series><Number>3</Number></ComicInfo>');
    expect(info.manga).toBeUndefined();
    expect(info.rtl).toBeUndefined();
  });

  test('campo ausente ou vazio vira undefined, nao string vazia', () => {
    const info = parseComicInfo('<ComicInfo><Series>  </Series></ComicInfo>');
    expect(info.series).toBeUndefined();
    expect(info.year).toBeUndefined();
    expect(info.genres).toBeUndefined();
  });

  test('o arquivo e achado em qualquer caixa e dentro de pasta', () => {
    expect(COMIC_INFO_RE.test('ComicInfo.xml')).toBe(true);
    expect(COMIC_INFO_RE.test('cap01/comicinfo.XML')).toBe(true);
    expect(COMIC_INFO_RE.test('NaoComicInfo.xml')).toBe(false);
  });
});
