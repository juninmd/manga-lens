import { describe, expect, test } from 'bun:test';
import { parseComicInfo } from '../src/server/comic-info.ts';
import { decodeEntities } from '../src/server/entities.ts';

describe('decodeEntities', () => {
  test('decodes named, decimal and hex references, &amp; last', () => {
    expect(decodeEntities('a &lt;b&gt; &quot;c&quot; &apos;d&#39; &#233; &#xE9; &#X2019; &amp;lt;')).toBe(
      'a <b> "c" \'d\' é é ’ &lt;',
    );
  });

  test('keeps out-of-range code points as text instead of throwing', () => {
    expect(decodeEntities('x &#99999999; y &#x110000; z')).toBe('x &#99999999; y &#x110000; z');
  });
});

describe('parseComicInfo entities', () => {
  test('decodes hex references in the summary', () => {
    expect(parseComicInfo('<ComicInfo><Summary>It&#x2019;s here</Summary></ComicInfo>').summary).toBe('It’s here');
  });

  test('a malformed reference does not abort the whole parse', () => {
    const info = parseComicInfo('<ComicInfo><Series>Ok</Series><Summary>bad &#99999999;</Summary></ComicInfo>');
    expect(info.series).toBe('Ok');
  });
});
