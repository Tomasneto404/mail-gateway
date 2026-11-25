// Authored by Tomás Neto (TN 2026)
import { describe, expect, it } from 'vitest';
import { extractInlineImages } from '../../src/common/inline-images';
import { enforceContent } from '../../src/policy/content-guard';
import { toResendPayload } from '../../src/worker/providers/resend.provider';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const GIF = Buffer.from('GIF89a-tiny').toString('base64');

describe('extractInlineImages', () => {
  it('turns data: images into cid: references with matching attachments', () => {
    const html = `<p>Hi</p><img width=10 src="data:image/png;base64,${PNG}"><img src='data:image/gif;base64,${GIF}' alt=x>`;
    const r = extractInlineImages(html, '0193-abc');
    expect(r.images.map((i) => [i.cid, i.filename, i.contentType])).toEqual([
      ['image1.0193-abc@mail-gateway', 'image1.png', 'image/png'],
      ['image2.0193-abc@mail-gateway', 'image2.gif', 'image/gif'],
    ]);
    expect(r.images[0].content.toString('hex')).toBe('89504e470d0a1a0a0000000d49484452');
    expect(r.html).toBe(`<p>Hi</p><img width=10 src="cid:image1.0193-abc@mail-gateway"><img src='cid:image2.0193-abc@mail-gateway' alt=x>`);
  });

  it('attaches a repeated image once, leaves other sources and SVG alone', () => {
    const img = `<img src="data:image/png;base64,${PNG}">`;
    const html = `${img}${img}<img src="https://cdn.example.com/a.png"><img src="data:image/svg+xml;base64,PHN2Zz4=">`;
    const r = extractInlineImages(html, 'm1');
    expect(r.images).toHaveLength(1);
    expect(r.html.match(/cid:image1\.m1@mail-gateway/g)).toHaveLength(2);
    expect(r.html).toContain('https://cdn.example.com/a.png');
    expect(r.html).toContain('data:image/svg+xml');
  });

  it('leaves HTML without data: images unchanged', () => {
    expect(extractInlineImages('<b>plain</b>', 'm1')).toEqual({ html: '<b>plain</b>', images: [] });
  });
});

describe('inline images in providers and content checks', () => {
  it('Resend payload carries them as attachments with contentId', () => {
    const p = toResendPayload({
      gatewayMessageId: 'm9',
      keyName: 'k',
      headerMessageId: '<m9@gw>',
      from: { address: 'a@example.com' },
      to: ['b@example.com'],
      cc: [],
      bcc: [],
      subject: 's',
      html: `<img src="data:image/png;base64,${PNG}">`,
      attachments: [],
      headers: {},
    });
    expect(p.html).toBe('<img src="cid:image1.m9@mail-gateway">');
    expect(p.attachments).toEqual([{ filename: 'image1.png', content: PNG, contentType: 'image/png', contentId: 'image1.m9@mail-gateway' }]);
  });

  it('secret scanning skips inline image bytes only, not other data: URIs', () => {
    const policy = { name: 'k', allowedLinkDomains: [], maxLinks: null, blockSecrets: true, allowedAttachmentTypes: [] } as never;
    const check = (html: string) => () => enforceContent(policy, { to: ['a@example.com'], cc: [], bcc: [], subject: 's', html, attachments: [] });
    const lookalike = 'AKIAABCDEFGHIJKLMNOP+AAAA'; // matches the AWS key rule
    // image bytes that happen to look like a key: delivered as an attachment, not as text
    expect(check(`<img src="data:image/png;base64,${lookalike}">`)).not.toThrow();
    // the same run anywhere else is still caught
    expect(check(`<a href="data:text/plain;base64,${lookalike}">x</a>`)).toThrow(/secret/);
    expect(check(`<img src="data:image/svg+xml;base64,${lookalike}">`)).toThrow(/secret/);
    expect(check(`<p>data:image/png;base64,${lookalike}</p>`)).toThrow(/secret/);
  });
});
