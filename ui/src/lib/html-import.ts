// Authored by Tomás Neto (TN 2026)

/**
 * Loads an HTML body from files: the .htm/.html itself plus, optionally, the images it references.
 * Made for signatures and letters saved from Word or Outlook ("Save as Web Page"), which are written in
 * windows-1252 and keep their images in a "<name>_files" folder next to the page.
 */

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Decodes the page with the right character set (BOM, then <meta charset>, then UTF-8, then windows-1252). */
export function decodeHtml(buf: ArrayBuffer): { text: string; charset: string } {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes), charset: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes), charset: 'utf-16be' };
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096));
  const declared = head.match(/<meta[^>]*charset\s*=\s*["']?\s*([\w-]+)/i)?.[1].toLowerCase();
  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    try {
      return { text: new TextDecoder(declared).decode(bytes), charset: declared };
    } catch {
      /* unknown label: fall through */
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), charset: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), charset: 'windows-1252' };
  }
}

export const isWordHtml = (html: string) => /<meta[^>]+(?:ProgId[^>]+Word\.Document|Generator[^>]+Microsoft Word)/i.test(html);

/**
 * Word/Outlook pages carry editor metadata and a VML copy of every image that Outlook desktop shows
 * instead of the <img>, pointing at a local file. Only applied to Word output: hand-written email
 * templates use conditional comments on purpose.
 */
export function cleanWordHtml(html: string): string {
  return html
    .replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!\[if[^\]]*\]>|<!\[endif\]>/gi, '')
    .replace(/<link\b[^>]*>/gi, (tag) => (/\bhref\s*=\s*["']?https?:/i.test(tag) ? tag : ''))
    .replace(/\s+v:shapes\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** The page is stored as UTF-8 from now on: make the declared charset say so. */
export function setUtf8(html: string): string {
  return html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*>/i, '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">')
    .replace(/<meta\s+charset\s*=\s*["']?[\w-]+["']?\s*\/?>/i, '<meta charset="utf-8">');
}

const baseName = (src: string) => {
  let s = src.split(/[?#]/)[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as is */
  }
  return (s.split(/[\\/]/).pop() ?? s).toLowerCase();
};

/** Replaces local <img src> paths with the matching image files as data: URIs; lists those not found. */
export function embedImages(html: string, images: Map<string, string>): { html: string; embedded: string[]; missing: string[] } {
  const embedded = new Set<string>();
  const missing = new Set<string>();
  const out = html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["']?)([^"'\s>]+)\2/gi, (all, pre: string, _q: string, src: string) => {
    if (/^(?:https?:|data:|cid:)/i.test(src)) return all;
    const name = baseName(src);
    const data = images.get(name);
    if (!data) {
      missing.add(name);
      return all;
    }
    embedded.add(name);
    return `${pre}"${data}"`;
  });
  return { html: out, embedded: [...embedded], missing: [...missing] };
}

const readDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

export interface ImportedHtml {
  html: string;
  charset: string;
  word: boolean;
  embedded: string[];
  missing: string[];
}

/** Reads the chosen files: exactly one .htm/.html plus any number of images. */
export async function importHtmlFiles(files: File[]): Promise<ImportedHtml> {
  const pages = files.filter((f) => /\.x?html?$/i.test(f.name) || f.type === 'text/html');
  if (pages.length !== 1) throw new Error(pages.length ? 'Choose a single .htm or .html file (plus its images).' : 'Choose an .htm or .html file.');
  const { text, charset } = decodeHtml(await pages[0].arrayBuffer());
  const word = isWordHtml(text);
  let html = setUtf8(word ? cleanWordHtml(text) : text);
  const images = new Map<string, string>();
  for (const f of files) {
    if (f === pages[0]) continue;
    if (!IMAGE_TYPES.has(f.type)) throw new Error(`"${f.name}" is not a PNG, JPEG, GIF or WebP image.`);
    images.set(f.name.toLowerCase(), await readDataUrl(f));
  }
  const r = embedImages(html, images);
  html = r.html;
  return { html, charset, word, embedded: r.embedded, missing: r.missing };
}
