import { allPosts } from '../lib';

const esc = (s = '') => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function GET({ site }: { site: URL }) {
  const posts = (await allPosts()).filter((p) => !p.data.stub);
  const items = posts
    .map((p) => {
      const url = new URL(`/${p.id}/`, site).href;
      return `<item><title>${esc(p.data.title)}</title><link>${url}</link><guid>${url}</guid>${
        p.data.date ? `<pubDate>${p.data.date.toUTCString()}</pubDate>` : ''
      }${p.data.description ? `<description>${esc(p.data.description)}</description>` : ''}</item>`;
    })
    .join('');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Andrew Hyde</title><link>${site}</link><description>Writing from andrewhy.de</description>${items}</channel></rss>`,
    { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } },
  );
}
