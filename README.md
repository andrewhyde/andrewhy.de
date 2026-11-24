# andrewhy.de

Personal site for Andrew Hyde. Built with [Astro](https://astro.build), edited with [Pages CMS](https://pagescms.org), and runs on any static host.

```
src/content/posts/   one Markdown file per post (the 40 rescued posts live here)
src/data/site.yaml   intro, email, links, "Things I started"
src/data/goals.yaml  the bucket list
src/data/countries.yaml  places visited, by region (the site never shows a total)
public/images/       photos; rescued post images go in public/images/posts/<slug>/
scripts/rescue.mjs   one-time import from the old WordPress blog
.pages.yml           CMS setup
```

## 1. Run it locally

```bash
npm install
npm run dev        # http://localhost:4321
```

## 2. Rescue the 40 posts (once, on your own computer)

The posts start as placeholders that link to the Wayback Machine. This pulls the full text and images from the live WordPress site:

```bash
npm run rescue -- --dry-run   # check that all 40 titles match
npm run rescue                # write them into src/content/posts
```

If the WordPress API is switched off, export instead: WordPress admin → **Tools → Export → Posts**, then

```bash
npm run rescue -- --wxr ~/Downloads/andrewhyde.WordPress.xml
```

- To change which posts come over, edit `scripts/rescue-list.json` (title, topic, optional `slug`).
- Add `--all` to bring over every published post, filed under "Archive".
- Posts keep their old WordPress slugs, so links like `andrewhy.de/extreme-minimalism/` keep working.
- Do this **before** switching the domain, while the old blog is still up.

## 3. Put it online

1. Push this folder to a new GitHub repo.
2. Import the repo into Netlify, Cloudflare Pages or Vercel. Build command `npm run build`, output folder `dist`.
3. Point `andrewhy.de` at the host (they walk you through the DNS records).

Old paths like `/bucket-list/` and `/feed/` redirect to their new homes (`public/_redirects` for Netlify/Cloudflare, `vercel.json` for Vercel).

## 4. Edit with the CMS

Go to [app.pagescms.org](https://app.pagescms.org), sign in with GitHub and open the repo. You'll see **Writing**, **About & contact**, **Goals** and **Places**. Each save commits to GitHub and the host rebuilds in about a minute.

Before launch, set your real email in **About & contact** (it's a placeholder now).
