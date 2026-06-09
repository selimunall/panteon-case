import { z } from 'zod';

export const Config = z.object({
  week: z.object({
    timezone: z.literal('UTC').default('UTC'),
    resetOffsetHours: z.number().default(0),
  }).default({}),
  pool: z.object({
    rate: z.number().default(0.02),
    top3: z.tuple([z.number(), z.number(), z.number()]).default([0.2, 0.15, 0.1]),
    bandShare: z.number().default(0.55),
    curveExponent: z.number().default(1),
  }).default({}),
  scroll: z.object({
    cap: z.number().int().default(1000),
    pageSize: z.number().int().default(50),
  }).default({}),
  batch: z.object({
    intervalMs: z.number().int().default(5000),
    maxDeltaPerInterval: z.number().int(),
  }),
  cache: z.object({
    top100RefreshMs: z.number().int().default(1000),
    top100TtlMs: z.number().int().default(2000),
  }).default({}),
}).refine(
  (c) => Math.abs(c.pool.top3[0] + c.pool.top3[1] + c.pool.top3[2] + c.pool.bandShare - 1) < 1e-9,
  { message: 'pool.top3 + pool.bandShare must sum to 1 (the whole pool must be distributed)' },
);
export type Config = z.infer<typeof Config>;
