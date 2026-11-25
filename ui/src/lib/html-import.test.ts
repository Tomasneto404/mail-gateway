// Authored by Tomás Neto (TN 2026)
import { describe, expect, it } from 'vitest';
import { cleanWordHtml, decodeHtml, embedImages, importHtmlFiles } from './html-import';

/** "Sérgio" and "informação" in windows-1252, the way Word saves a web page. */
const cp1252 = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

const WORD_PAGE = `<html xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta http-equiv=Content-Type content="text/html; charset=windows-1252">
<meta name=ProgId content=Word.Document>
<link rel=File-List href="Pessoal20_ficheiros/filelist.xml">
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]-->
</head>
<body><p class=MsoNormal>Sérgio Meireles, informação</p>
<p><!--[if gte vml 1]><v:shape><v:imagedata src="Pessoal20_ficheiros/image001.png"/></v:shape><![endif]--><![if !vml]><img border=0 width=685
src="Pessoal20_ficheiros/image002.png" v:shapes="_x0000_i1027"><![endif]></p>
</body></html>`;

describe('decodeHtml', () => {
  it('honours a declared windows-1252 charset', () => {
    const r = decodeHtml(cp1252(WORD_PAGE).buffer);
    expect(r.charset).toBe('windows-1252');
    expect(r.text).toContain('Sérgio Meireles, informação');
  });
  it('UTF-8 stays UTF-8; undeclared invalid UTF-8 falls back to windows-1252', () => {
    expect(decodeHtml(new TextEncoder().encode('<p>Sérgio</p>').buffer)).toEqual({ text: '<p>Sérgio</p>', charset: 'utf-8' });
    expect(decodeHtml(cp1252('<p>Sérgio</p>').buffer)).toEqual({ text: '<p>Sérgio</p>', charset: 'windows-1252' });
  });
});

describe('Word clean-up and images', () => {
  it('drops the VML copy and local links, keeps the <img>', () => {
    const html = cleanWordHtml(WORD_PAGE);
    expect(html).not.toMatch(/v:imagedata|filelist\.xml|<!\[if|OfficeDocumentSettings|v:shapes/);
    expect(html).toContain('src="Pessoal20_ficheiros/image002.png"');
  });

  it('embeds matching files by name and reports the rest', () => {
    const r = embedImages('<img src="Pessoal20_ficheiros/image002.png"><img src=logo%20big.PNG><img src="https://x.example/a.png">', new Map([['image002.png', 'data:image/png;base64,AAAA']]));
    expect(r.html).toBe('<img src="data:image/png;base64,AAAA"><img src=logo%20big.PNG><img src="https://x.example/a.png">');
    expect(r.embedded).toEqual(['image002.png']);
    expect(r.missing).toEqual(['logo big.png']);
  });

  it('imports a Word page with its image: accents right, image inline, charset now utf-8', async () => {
    const page = new File([cp1252(WORD_PAGE)], 'Pessoal20.htm', { type: 'text/html' });
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image002.png', { type: 'image/png' });
    const r = await importHtmlFiles([page, png]);
    expect(r).toMatchObject({ charset: 'windows-1252', word: true, embedded: ['image002.png'], missing: [] });
    expect(r.html).toContain('Sérgio Meireles, informação');
    expect(r.html).toContain('src="data:image/png;base64,iVBORw=="');
    expect(r.html).toContain('charset=utf-8');
    expect(r.html).not.toContain('windows-1252');
  });

  it('refuses no page, two pages, or a non-image file', async () => {
    const page = new File(['<p>x</p>'], 'a.html', { type: 'text/html' });
    await expect(importHtmlFiles([])).rejects.toThrow(/Choose an .htm/);
    await expect(importHtmlFiles([page, page])).rejects.toThrow(/single/);
    await expect(importHtmlFiles([page, new File(['x'], 'a.svg', { type: 'image/svg+xml' })])).rejects.toThrow(/not a PNG/);
  });
});
