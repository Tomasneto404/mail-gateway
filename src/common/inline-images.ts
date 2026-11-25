// Authored by Tomás Neto (TN 2026)

/**
 * Images embedded in the HTML as data: URIs (e.g. a signature loaded into a template) are not shown by
 * Gmail, Outlook and most other clients. Before delivery they become inline attachments referenced
 * with cid:, which every client displays. SVG is left alone (it can carry scripts and clients drop it).
 */
const DATA_IMG_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\s]+?)\2/gi;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export interface InlineImage {
  cid: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

export function extractInlineImages(html: string, messageId: string): { html: string; images: InlineImage[] } {
  const images: InlineImage[] = [];
  const byData = new Map<string, string>();
  const tag = messageId.replace(/[^A-Za-z0-9.-]/g, '') || 'msg';
  const out = html.replace(DATA_IMG_RE, (_all, pre: string, q: string, type: string, b64: string) => {
    const data = b64.replace(/\s+/g, '');
    let cid = byData.get(data);
    if (!cid) {
      const contentType = type.toLowerCase() === 'image/jpg' ? 'image/jpeg' : type.toLowerCase();
      const n = images.length + 1;
      cid = `image${n}.${tag}@mail-gateway`;
      byData.set(data, cid);
      images.push({ cid, filename: `image${n}.${EXT[contentType] ?? 'bin'}`, contentType, content: Buffer.from(data, 'base64') });
    }
    return `${pre}${q}cid:${cid}${q}`;
  });
  return { html: out, images };
}
