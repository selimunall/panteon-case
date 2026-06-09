import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, bigint, bigserial, text, integer,
  timestamp, primaryKey, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

export const weekStatus = pgEnum('week_status', ['active', 'closing', 'closed']);

export const players = pgTable('players', {
  id: uuid('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const weeks = pgTable('weeks', {
  weekId: text('week_id').primaryKey(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: weekStatus('status').notNull().default('active'),
  totalEarned: bigint('total_earned', { mode: 'bigint' }).notNull().default(sql`0`),
  rolloverIn: bigint('rollover_in', { mode: 'bigint' }).notNull().default(sql`0`),
  poolTotal: bigint('pool_total', { mode: 'bigint' }).notNull().default(sql`0`),
  rolloverOut: bigint('rollover_out', { mode: 'bigint' }).notNull().default(sql`0`),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const weeklyScores = pgTable('weekly_scores', {
  weekId: text('week_id').notNull().references(() => weeks.weekId),
  playerId: uuid('player_id').notNull().references(() => players.id),
  totalEarned: bigint('total_earned', { mode: 'bigint' }).notNull().default(sql`0`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.weekId, t.playerId] }),
  topRank: index('weekly_scores_week_total_desc_idx').on(t.weekId, t.totalEarned.desc()),
}));

export const rewardPayouts = pgTable('reward_payouts', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  weekId: text('week_id').notNull().references(() => weeks.weekId),
  playerId: uuid('player_id').notNull().references(() => players.id),
  rank: integer('rank').notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  weekPlayer: uniqueIndex('reward_payouts_week_player_uq').on(t.weekId, t.playerId),
  weekRank: index('reward_payouts_week_rank_idx').on(t.weekId, t.rank),
}));
