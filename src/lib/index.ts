import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { getCollection } from 'astro:content';

export function data<T = any>(name: string): T {
  return parse(fs.readFileSync(path.join(process.cwd(), 'src/data', `${name}.yaml`), 'utf8')) as T;
}

export async function allPosts() {
  const posts = await getCollection('posts');
  return posts.sort((a, b) => {
    const da = a.data.date?.getTime() ?? 0;
    const db = b.data.date?.getTime() ?? 0;
    if (da !== db) return db - da;
    return (a.data.order ?? 999) - (b.data.order ?? 999);
  });
}

export const fmtDate = (d?: Date) =>
  d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' }) : '';
