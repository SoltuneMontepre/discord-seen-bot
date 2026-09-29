import { z } from "zod";
import { DEFAULT_POLICY, type Policy } from "./domain/policy.ts";

const optionalMinutes = z.coerce.number().positive().optional();

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_APPLICATION_ID: z
    .string()
    .regex(/^\d{17,20}$/, "DISCORD_APPLICATION_ID must be a snowflake"),
  DATABASE_PATH: z.string().min(1).default("./data/seen.db"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  SEEN_WEAK_WINDOW_MINUTES: optionalMinutes,
  SEEN_TRACKING_TTL_MINUTES: optionalMinutes,
  SEEN_RETENTION_MINUTES: optionalMinutes,
  SEEN_DEBUG_PAYLOADS: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
});

export interface Config {
  token: string;
  applicationId: string;
  databasePath: string;
  logLevel: string;
  production: boolean;
  debugPayloads: boolean;
  policy: Policy;
}

/** Parses env. Dev-only policy overrides are ignored in production. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const minutes = (m: number | undefined, fallback: number) =>
    !production && m !== undefined ? Math.round(m * 60_000) : fallback;

  return {
    token: e.DISCORD_TOKEN,
    applicationId: e.DISCORD_APPLICATION_ID,
    databasePath: e.DATABASE_PATH,
    logLevel: e.LOG_LEVEL,
    production,
    debugPayloads: !production && e.SEEN_DEBUG_PAYLOADS,
    policy: {
      ...DEFAULT_POLICY,
      weakWindowMs: minutes(e.SEEN_WEAK_WINDOW_MINUTES, DEFAULT_POLICY.weakWindowMs),
      trackingTtlMs: minutes(e.SEEN_TRACKING_TTL_MINUTES, DEFAULT_POLICY.trackingTtlMs),
      retentionMs: minutes(e.SEEN_RETENTION_MINUTES, DEFAULT_POLICY.retentionMs),
    },
  };
}
