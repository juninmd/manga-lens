import { all, decodeEntities } from '../scrape.ts';

/** Attributes may be reordered, single quoted, or lazy loaded by WordPress. */
export function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value).trim();
}

export function absoluteUrl(value: string | undefined, base: string): string | undefined {
  if (!value || value.startsWith('data:')) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}

export function imageUrls(html: string, base: string): string[] {
  return [...new Set(all(html, /<img\b[^>]*>/gi).map(([tag]) => {
    const value = attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') || attr(tag, 'src');
    return absoluteUrl(value, base);
  }).filter((url): url is string => Boolean(url) && !/\/[^/?]*(?:logo|placeholder|dflazy|loading)[^/?]*\.(?:png|gif|webp|jpg)/i.test(url!)))];
}

/** Extract a whole container including nested divs, stopping before ads/navigation. */
export function container(html: string, classes: string[], id?: string): string | undefined {
  const tags = all(html, /<\/?(?:div|section)\b[^>]*>/gi);
  for (let i = 0; i < tags.length; i++) {
    const opening = tags[i]!;
    if (opening[0].startsWith('</') || !(id && attr(opening[0], 'id') === id) && !attr(opening[0], 'class')?.split(/\s+/).some((c) => classes.includes(c))) continue;
    const name = /^<(\w+)/.exec(opening[0])![1]!;
    let depth = 1;
    for (let j = i + 1; j < tags.length; j++) {
      const tag = tags[j]!;
      if (!new RegExp(`^</?${name}\\b`, 'i').test(tag[0])) continue;
      depth += tag[0].startsWith('</') ? -1 : 1;
      if (depth === 0) return html.slice(opening.index + opening[0].length, tag.index);
    }
    return undefined;
  }
  return undefined;
}

/** IDs are paths below a configured origin; never accept an arbitrary URL. */
export function pathUrl(base: string, id: string): string {
  if (!id || /[?#\\\\]/.test(id) || id.startsWith('/') || id.includes(':')) throw new Error('id de fonte invalido');
  for (const part of id.split('/')) {
    let decoded = part;
    for (let i = 0; i < 3; i++) {
      try { decoded = decodeURIComponent(decoded); } catch { throw new Error('id de fonte invalido'); }
    }
    if (!decoded || decoded === '.' || decoded === '..' || /[/?#\\\\]/.test(decoded)) throw new Error('id de fonte invalido');
  }
  const url = new URL(id, `${base.replace(/\/+$/, '')}/`);
  return url.href;
}
