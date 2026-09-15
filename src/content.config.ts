import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    order: z.number(),
    tags: z.array(z.string()).default([]),
    reading: z.string().optional(),
    series: z.string().optional(),
    showCover: z.boolean().default(false),
  }).refine(data => !data.updatedAt || data.updatedAt >= data.date, { message: 'updatedAt must not precede publication', path: ['updatedAt'] }),
});

export const collections = { blog };
