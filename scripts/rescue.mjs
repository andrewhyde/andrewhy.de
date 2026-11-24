#!/usr/bin/env node
/**
 * Rescue posts from the old WordPress blog into src/content/posts as Markdown.
 *
 *   npm run rescue                      # pull the 40 posts in scripts/rescue-list.json from the live site
 *   npm run rescue -- --wxr export.xml  # use a WordPress export file instead (Tools → Export → Posts)
 *   npm run rescue -- --all             # also bring over every other published post
 *   npm run rescue -- --wayback         # old site is offline: rebuild posts from the Internet Archive
 *   npm run rescue -- --dry-run         # just report what would match
 *   npm run rescue -- --site https://example.com --no-images
 *
 * If the WordPress API is blocked, it falls back to the sitemap and reads each post page directly.
 *
 * Images in posts are downloaded to public/images/posts/<slug>/ so nothing depends on the old host.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TurndownService from 'turndown';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml } from 'node-html-parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSTS_DIR = path.join(root, 'src/content/posts');
const IMG_DIR = path.join(root, 'public/images/posts');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};
const SITE = opt('site', 'https://andrewhy.de').replace(/\/$/, '');
const WXR = opt('wxr');
const DRY = flag('dry-run');
const IMAGES = !flag('no-images');
const ALL = flag('all');
const WAYBACK = flag('wayback');
const ARCHIVE = opt('archive', 'https://web.archive.org');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = new Map(); // original image/page URL -> wayback timestamp
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };

// ---------- helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export const decode = (s = '') =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
export const norm = (s) =>
  decode(s).toLowerCase().replace(/[‘’'"“”]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1));
export function score(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  const A = tokens(a), B = tokens(b);
  const inter = [...A].filter((t) => B.has(t)).length;
  const jaccard = inter / (A.size + B.size - inter || 1);
  const contains = nb.includes(na) || na.includes(nb) ? 0.75 : 0;
  return Math.max(jaccard, contains);
}
const stripTags = (h) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const yamlStr = (s) => JSON.stringify(s);

/** WordPress's wpautop, simplified: raw export content uses blank lines for paragraphs. */
function autop(html) {
  if (/<p[\s>]/i.test(html)) return html;
  return html
    .split(/\n\s*\n/)
    .map((block) => {
      const b = block.trim();
      if (!b) return '';
      if (/^<(h\d|ul|ol|blockquote|figure|div|table|pre|iframe|img|hr)/i.test(b)) return b;
      return `<p>${b.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}
function cleanHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/g, (_, inner) => {
      const img = inner.match(/<img[^>]*>/)?.[0] ?? '';
      const cap = stripTags(inner.replace(/<img[^>]*>/, ''));
      return `<figure>${img}${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;
    })
    .replace(/\[(\/?)(gallery|embed|video|audio)[^\]]*\]/g, '')
    .replace(/\s(srcset|sizes|loading|decoding)="[^"]*"/g, '');
}

const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
td.keep(['iframe', 'video', 'audio']);
td.addRule('figure', {
  filter: 'figure',
  replacement: (_c, node) => {
    const img = node.querySelector('img');
    const cap = node.querySelector('figcaption')?.textContent?.trim();
    if (!img) return _c;
    const md = `![${(img.getAttribute('alt') || cap || '').replace(/[\[\]]/g, '')}](${img.getAttribute('src')})`;
    return `\n\n${md}${cap ? `\n*${cap}*` : ''}\n\n`;
  },
});

// ---------- sources ----------
async function getJson(url) {
  const res = await fetch(url, { headers: { ...H, Accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { status: res.status, res });
  return { data: await res.json(), res };
}

async function fromRest() {
  const fields = 'id,slug,date,title,content,excerpt,link,featured_media,status';
  const bases = [`${SITE}/wp-json/wp/v2`, `${SITE}/?rest_route=/wp/v2`];
  for (const base of bases) {
    const sep = base.includes('?') ? '&' : '?';
    const out = [];
    try {
      for (let page = 1; ; page++) {
        const { data, res } = await getJson(`${base}/posts${sep}per_page=100&page=${page}&_fields=${fields}`);
        out.push(...data);
        const total = +res.headers.get('x-wp-totalpages') || 1;
        process.stdout.write(`\r  fetched ${out.length} posts (page ${page}/${total})`);
        if (page >= total || data.length === 0) break;
      }
      process.stdout.write('\n');
      const posts = out.map((p) => ({
        slug: p.slug,
        date: p.date,
        title: decode(p.title?.rendered),
        html: p.content?.rendered ?? '',
        excerpt: stripTags(p.excerpt?.rendered ?? ''),
        link: p.link,
        featured: p.featured_media,
      }));
      // featured images
      for (const p of posts) {
        if (!p.featured) continue;
        try { p.cover = (await getJson(`${base}/media/${p.featured}${sep}_fields=source_url`)).data.source_url; } catch {}
      }
      return posts;
    } catch (e) {
      console.warn(`  ${base} didn't work (${e.message}).`);
    }
  }
  return null;
}

// ---------- fallback: sitemap + reading each post page ----------
async function getText(url) {
  const res = await fetch(url, { headers: { ...H, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' } });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { status: res.status });
  return res.text();
}
const slugOf = (url) => decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop() || '');
const guessSlug = (t) => norm(t).replace(/ /g, '-');

async function sitemapUrls() {
  const seen = new Set(), pages = new Set();
  const queue = ['/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap.xml', '/post-sitemap.xml'].map((p) => SITE + p);
  while (queue.length && seen.size < 60) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    let xml;
    try { xml = await getText(u); } catch { continue; }
    for (const [, loc] of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/g)) {
      const l = decode(loc.trim());
      if (/\.xml(\?|$)/.test(l)) { if (!/(page|categor|tag|user|author|attachment)/i.test(l)) queue.push(l); }
      else pages.add(l);
    }
  }
  return [...pages];
}

function readPostPage(html, url) {
  const doc = parseHtml(html);
  const meta = (k) => doc.querySelector(`meta[property="${k}"]`)?.getAttribute('content') || doc.querySelector(`meta[name="${k}"]`)?.getAttribute('content');
  const first = (sels) => { for (const q of sels) { const n = doc.querySelector(q); if (n) return n; } return null; };
  const title = decode(
    first(['h1.entry-title', 'h1.wp-block-post-title', '.entry-title', 'article h1', 'main h1'])?.text?.trim() ||
      (meta('og:title') || doc.querySelector('title')?.text || '').replace(/\s*[|–—-]\s*[^|–—-]*$/, ''),
  );
  const body = first(['.entry-content', '.wp-block-post-content', '.post-content', '.post-entry', 'article .content', 'article', 'main']);
  if (!body) return null;
  body.querySelectorAll('script, style, noscript, .sharedaddy, .jp-relatedposts, .wp-block-comments, #comments, .comments-area, .post-navigation, .entry-meta, .entry-footer, form').forEach((n) => n.remove());
  const date = meta('article:published_time') || doc.querySelector('time[datetime]')?.getAttribute('datetime') || '';
  const og = meta('og:image');
  return {
    slug: slugOf(url),
    date,
    title,
    html: body.innerHTML,
    excerpt: (meta('description') || meta('og:description') || '').trim(),
    link: url,
    cover: og && isOwnImage(og) ? og : undefined,
  };
}

async function fromPages(list) {
  console.log('  Trying the sitemap and post pages instead…');
  const urls = await sitemapUrls();
  console.log(`  ${urls.length} URLs in the sitemap.`);
  const want = new Set();
  for (const item of list) {
    const ranked = urls
      .map((u) => ({ u, s: item.slug && slugOf(u) === item.slug ? 1 : score(item.title, slugOf(u).replace(/-/g, ' ')) }))
      .filter((x) => x.s >= (item.fuzzy ? 0.2 : 0.35))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => x.u);
    ranked.forEach((u) => want.add(u));
    if (!ranked.length) want.add(`${SITE}/${item.slug || guessSlug(item.title)}/`);
  }
  if (ALL) urls.forEach((u) => want.add(u));
  const posts = [];
  let n = 0;
  for (const u of want) {
    process.stdout.write(`\r  reading pages ${++n}/${want.size}`);
    try {
      const p = readPostPage(await getText(u), u);
      if (p && p.title && p.html.trim()) posts.push(p);
    } catch {}
  }
  process.stdout.write('\n');
  if (!posts.length) {
    throw new Error(
      `Couldn't read posts from ${SITE} (the site is blocking automated requests).\n` +
        `Export them instead: WordPress admin → Tools → Export → Posts, then run\n  npm run rescue -- --wxr path/to/export.xml`,
    );
  }
  return posts;
}

async function fromWxr(file) {
  const xml = await fs.readFile(file, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: false, processEntities: true, htmlEntities: true });
  const doc = parser.parse(xml);
  let items = doc?.rss?.channel?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  const attachments = new Map(
    items.filter((i) => i['wp:post_type'] === 'attachment').map((i) => [String(i['wp:post_id']), i['wp:attachment_url']]),
  );
  return items
    .filter((i) => i['wp:post_type'] === 'post' && i['wp:status'] === 'publish')
    .map((i) => {
      const meta = [].concat(i['wp:postmeta'] ?? []);
      const thumb = meta.find((m) => m['wp:meta_key'] === '_thumbnail_id');
      return {
        slug: String(i['wp:post_name'] || ''),
        date: String(i['wp:post_date'] || '').replace(' ', 'T'),
        title: decode(String(i.title ?? '')),
        html: autop(String(i['content:encoded'] ?? '')),
        excerpt: stripTags(String(i['excerpt:encoded'] ?? '')),
        link: i.link,
        cover: thumb ? attachments.get(String(thumb['wp:meta_value'])) : undefined,
      };
    });
}

// ---------- images ----------
const siteHost = new URL(SITE).hostname.replace(/^www\./, '');
function isOwnImage(src) {
  try {
    const u = new URL(src, SITE);
    const h = u.hostname.replace(/^www\./, '');
    return (h === siteHost || /^i\d\.wp\.com$/.test(h)) && u.pathname.includes('/wp-content/uploads/');
  } catch { return false; }
}
async function download(src, slug) {
  const u = new URL(src, SITE);
  if (/^i\d\.wp\.com$/.test(u.hostname)) { const [, host, ...rest] = u.pathname.split('/'); u.hostname = host; u.pathname = '/' + rest.join('/'); u.search = ''; }
  u.search = '';
  const file = decodeURIComponent(path.basename(u.pathname));
  const dir = path.join(IMG_DIR, slug);
  const dest = path.join(dir, file.replace(/-\d+x\d+(?=\.\w+$)/, ''));
  const publicPath = `/images/posts/${slug}/${path.basename(dest)}`;
  try { await fs.access(dest); return publicPath; } catch {}
  // prefer the full-size original over WordPress's resized copy
  const candidates = [u.href.replace(/-\d+x\d+(?=\.\w+$)/, ''), u.href];
  for (const orig of [...new Set(candidates)]) {
    const url = WAYBACK ? `${ARCHIVE}/web/${snap.get('page') || '2015'}id_/${orig}` : orig;
    try {
      if (WAYBACK) await sleep(800);
      const res = await fetch(url, { headers: H });
      if (!res.ok) continue;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return publicPath;
    } catch {}
  }
  return null;
}
async function localizeImages(html, slug) {
  if (!IMAGES) return html;
  const srcs = new Set();
  html.replace(/<img[^>]+src="([^"]+)"/g, (_, s) => srcs.add(s));
  html.replace(/<a[^>]+href="([^"]+\.(?:jpe?g|png|gif|webp))"/gi, (_, s) => srcs.add(s));
  for (const src of srcs) {
    if (!isOwnImage(src)) continue;
    const local = await download(decode(src), slug);
    if (local) html = html.split(src).join(local);
    else console.warn(`    couldn't download ${src}`);
  }
  return html;
}

// ---------- fallback: the Internet Archive's copies ----------
async function archiveGet(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    await sleep(1200 * (i + 1));
    try {
      const res = await fetch(url, { headers: H });
      if (res.ok) return res.text();
      if (res.status === 404) return null;
    } catch {}
  }
  return null;
}

async function fromWayback(list) {
  const host = new URL(SITE).hostname;
  console.log(`  Asking the Internet Archive which pages of ${host} it saved…`);
  const cdx = `${ARCHIVE}/cdx/search/cdx?url=${host}/*&output=json&fl=original,timestamp&filter=statuscode:200&filter=mimetype:text/html&collapse=urlkey&limit=20000`;
  const txt = await archiveGet(cdx);
  if (!txt) throw new Error("Couldn't reach the Internet Archive. Check your connection and try again in a few minutes.");
  const rows = JSON.parse(txt).slice(1);
  // newest snapshot per slug, ignoring comment pages, feeds, tags and query strings
  const bySlug = new Map();
  for (const [original, ts] of rows) {
    let u;
    try { u = new URL(original.replace(/^http:/, 'https:')); } catch { continue; }
    if (u.search && !/^\?p=\d+$/.test(u.search)) continue;
    if (/\/(comment-page-\d+|feed|tag|category|author|page|wp-content|wp-json|amp)(\/|$)/.test(u.pathname)) continue;
    const slug = slugOf(u.href);
    if (!slug || slug.includes('.')) continue;
    const prev = bySlug.get(slug);
    if (!prev || ts > prev.ts) bySlug.set(slug, { url: u.href, ts });
  }
  console.log(`  ${bySlug.size} archived pages found.`);
  const want = new Map();
  for (const item of list) {
    const ranked = [...bySlug.entries()]
      .map(([slug, v]) => ({ v, s: item.slug === slug ? 1 : score(item.title, slug.replace(/-/g, ' ')) }))
      .filter((x) => x.s >= (item.fuzzy ? 0.2 : 0.4))
      .sort((a, b) => b.s - a.s)
      .slice(0, 2);
    ranked.forEach((x) => want.set(x.v.url, x.v));
  }
  if (ALL) bySlug.forEach((v) => want.set(v.url, v));
  const posts = [];
  let n = 0;
  for (const v of want.values()) {
    process.stdout.write(`\r  reading archived pages ${++n}/${want.size} (the Archive is slow, hang tight)`);
    const html = await archiveGet(`${ARCHIVE}/web/${v.ts}id_/${v.url}`);
    if (!html) continue;
    const p = readPostPage(html, v.url);
    if (p && p.title && p.html.trim()) { p.ts = v.ts; posts.push(p); }
  }
  process.stdout.write('\n');
  return posts;
}

// ---------- main ----------
async function readStubs() {
  const files = (await fs.readdir(POSTS_DIR)).filter((f) => f.endsWith('.md'));
  const out = [];
  for (const f of files) {
    const txt = await fs.readFile(path.join(POSTS_DIR, f), 'utf8');
    out.push({ file: f, stub: /^stub:\s*true/m.test(txt) });
  }
  return out;
}

async function main() {
  const list = JSON.parse(await fs.readFile(path.join(root, 'scripts/rescue-list.json'), 'utf8'));
  console.log(WXR ? `Reading ${WXR}…` : WAYBACK ? 'Rebuilding posts from the Internet Archive…' : `Fetching posts from ${SITE}…`);
  const source = WXR ? await fromWxr(WXR) : WAYBACK ? await fromWayback(list) : (await fromRest()) ?? (await fromPages(list));
  console.log(`  ${source.length} published posts found.\n`);

  const used = new Set();
  const plan = list.map((item, i) => {
    let best = null, bestScore = 0;
    for (const p of source) {
      if (used.has(p.slug)) continue;
      const s = item.slug && item.slug === p.slug ? 1 : score(item.title, p.title);
      if (s > bestScore) { best = p; bestScore = s; }
    }
    const ok = best && bestScore >= (item.fuzzy ? 0.3 : 0.6);
    if (ok) used.add(best.slug);
    return { item, order: i + 1, post: ok ? best : null, score: bestScore };
  });
  if (ALL) {
    for (const p of source) if (!used.has(p.slug)) plan.push({ item: { title: p.title, category: 'Archive' }, order: 1000, post: p, score: 1 });
  }

  const stubs = await readStubs();
  let written = 0;
  const missing = [];
  for (const { item, order, post, score: s } of plan) {
    if (!post) { missing.push(item.title); continue; }
    const tag = s < 1 ? ` (matched "${post.title}", ${Math.round(s * 100)}%)` : '';
    console.log(`✓ ${item.title}${tag}`);
    if (DRY) continue;

    snap.set('page', post.ts);
    let html = cleanHtml(post.html);
    html = await localizeImages(html, post.slug);
    let cover = post.cover && IMAGES && isOwnImage(post.cover) ? await download(post.cover, post.slug) : undefined;
    const body = td.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
    const description = item.description || (post.excerpt ? post.excerpt.replace(/\s*\[?(…|&hellip;|\.\.\.)\]?\s*$/, '…').slice(0, 220) : undefined);

    const fm = [
      '---',
      `title: ${yamlStr(post.title || item.title)}`,
      `category: ${yamlStr(item.category || 'Notes')}`,
      post.date ? `date: ${post.date.slice(0, 10)}` : null,
      description ? `description: ${yamlStr(description)}` : null,
      cover ? `cover: ${yamlStr(cover)}` : null,
      post.link ? `originalUrl: ${yamlStr(post.link)}` : null,
      `order: ${order}`,
      '---',
      '',
      body,
      '',
    ].filter((l) => l !== null).join('\n');

    const target = `${post.slug}.md`;
    await fs.writeFile(path.join(POSTS_DIR, target), fm);
    // remove the placeholder that stood in for this post, if it had a different filename
    const guess = item.slug || norm(item.title).replace(/ /g, '-');
    const stub = stubs.find((x) => x.stub && x.file === `${guess}.md` && x.file !== target);
    if (stub) await fs.unlink(path.join(POSTS_DIR, stub.file));
    written++;
  }

  console.log(`\n${DRY ? 'Would write' : 'Wrote'} ${DRY ? plan.filter((p) => p.post).length : written} posts.`);
  if (missing.length) {
    console.log(`\nNo match for ${missing.length}:`);
    missing.forEach((t) => console.log(`  - ${t}`));
    console.log('Fix the title (or add "slug") in scripts/rescue-list.json and run again. Their placeholder pages link to the Wayback Machine until then.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
}
