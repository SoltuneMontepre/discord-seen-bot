import { type Logger as PinoLogger, pino } from "pino";

export type Logger = PinoLogger;

/** Structured logger. Message content must never be logged; `content` paths are redacted defensively. */
export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    redact: {
      paths: ["content", "*.content", "*.*.content", "message.content", "data.content"],
      censor: "[redacted]",
    },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}
