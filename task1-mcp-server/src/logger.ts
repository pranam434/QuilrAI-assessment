const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

type Level = keyof typeof LEVELS;

function resolveLevel(value: string | undefined): Level {
  const normalized = value?.toLowerCase();

  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }

  return "info";
}

const threshold = LEVELS[resolveLevel(process.env.LOG_LEVEL)];

function describe(details: unknown): string {
  if (details instanceof Error) {
    return details.stack ?? `${details.name}: ${details.message}`;
  }

  if (typeof details === "string") {
    return details;
  }

  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function write(level: Level, message: string, details?: unknown): void {
  if (LEVELS[level] < threshold) {
    return;
  }

  const suffix = details === undefined ? "" : ` ${describe(details)}`;

  process.stderr.write(
    `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}\n`
  );
}

export const logger = {
  debug(message: string, details?: unknown): void {
    write("debug", message, details);
  },
  info(message: string, details?: unknown): void {
    write("info", message, details);
  },
  warn(message: string, details?: unknown): void {
    write("warn", message, details);
  },
  error(message: string, details?: unknown): void {
    write("error", message, details);
  },
};