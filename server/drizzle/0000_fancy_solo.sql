CREATE TYPE "public"."week_status" AS ENUM('active', 'closing', 'closed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "players" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reward_payouts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"week_id" text NOT NULL,
	"player_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weekly_scores" (
	"week_id" text NOT NULL,
	"player_id" uuid NOT NULL,
	"total_earned" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_scores_week_id_player_id_pk" PRIMARY KEY("week_id","player_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weeks" (
	"week_id" text PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "week_status" DEFAULT 'active' NOT NULL,
	"total_earned" bigint DEFAULT 0 NOT NULL,
	"rollover_in" bigint DEFAULT 0 NOT NULL,
	"pool_total" bigint DEFAULT 0 NOT NULL,
	"rollover_out" bigint DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reward_payouts" ADD CONSTRAINT "reward_payouts_week_id_weeks_week_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("week_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reward_payouts" ADD CONSTRAINT "reward_payouts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weekly_scores" ADD CONSTRAINT "weekly_scores_week_id_weeks_week_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("week_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weekly_scores" ADD CONSTRAINT "weekly_scores_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reward_payouts_week_player_uq" ON "reward_payouts" USING btree ("week_id","player_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reward_payouts_week_rank_idx" ON "reward_payouts" USING btree ("week_id","rank");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weekly_scores_week_total_desc_idx" ON "weekly_scores" USING btree ("week_id","total_earned" DESC NULLS LAST);