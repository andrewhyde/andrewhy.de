import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    category: z.string().default('Notes'),
    date: z.coerce.date().optional(),
    description: z.string().optional(),
    order: z.number().optional(),
    // true until the rescue script fills in the full text from the old WordPress blog
    stub: z.boolean().default(false),
    cover: z.string().optional(),
    originalUrl: z.string().optional(),
  }),
});

export const collections = { posts };
