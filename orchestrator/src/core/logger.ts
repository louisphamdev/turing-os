/**
 * Structured logger — one JSON object per line to stdout/stderr.
 *
 * Goals:
 *   - Level-gated (error|warn|info|debug) via the LOG_LEVEL env (default `info`).
 *     A message below the configured threshold is dropped (cheaply — fields are
 *     not even serialized).
 *   - Machine-parseable: every line is `JSON.stringify({ ts, level, msg, ...fields })`
 *     so log aggregators (Loki/ELK) can index it without a grok pattern.
 *   - Secret redaction: any field whose KEY name (case-insensitive) contains a
 *     sensitive substring (token/secret/key/password/authorization/apikey/bearer)
 *     has its VALUE masked to '[REDACTED]', recursively for nested objects/arrays.
 *     We deliberately over-redact (e.g. `keyName` matches `key`) — leaking a
 *     secret is far worse than masking an innocuous field.
 *
 * This is app code (a long-lived Node process), NOT a Temporal/workflow script,
 * so `new Date().toISOString()` and `console.*` are fine here.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Numeric severity — lower number = higher priority. */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export type LogFields = Record<string, unknown>;

/**
 * Resolve the configured threshold from LOG_LEVEL (default `info`). Read at
 * call time (not cached at import) so tests can flip the env between cases.
 */
function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') {
    return raw;
  }
  return 'info';
}

/** Substrings (lowercased) that mark a field name as sensitive. */
const SENSITIVE_KEY_SUBSTRINGS = [
  'token',
  'secret',
  'key',
  'password',
  'authorization',
  'apikey',
  'bearer',
];

const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Recursively mask sensitive values. Walks plain objects and arrays, masking
 * any value whose key matches a sensitive substring. Guards against cycles via
 * a `seen` set AND a hard depth cap, so a self-referential or pathologically
 * deep object can never spin the logger.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  // Hard depth cap — defends against deep (non-cyclic) nesting too.
  if (depth > 8) return '[Truncated]';
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Cycle guard: if we've already visited this object reference, stop.
  if (seen.has(value as object)) {
    return '[Circular]';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
    } else if (val !== null && typeof val === 'object') {
      out[key] = redact(val, seen, depth + 1);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Write a single JSON line. error/warn → stderr; info/debug → stdout. */
function write(level: LogLevel, msg: string, fields?: LogFields, base?: LogFields): void {
  if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[configuredLevel()]) {
    return; // below threshold — dropped
  }

  // Merge base (child) fields with per-call fields, then redact the whole lot.
  const merged: LogFields = { ...(base || {}), ...(fields || {}) };
  const safeFields = redact(merged) as LogFields;

  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...safeFields,
  };

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // Last-ditch fallback if something non-serializable slipped through.
    line = JSON.stringify({ ts: new Date().toISOString(), level, msg, _logError: 'unserializable fields' });
  }

  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export interface Logger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  /** Return a logger that prepends `baseFields` to every record (e.g. a requestId). */
  child(baseFields: LogFields): Logger;
}

function makeLogger(base?: LogFields): Logger {
  return {
    error: (msg, fields) => write('error', msg, fields, base),
    warn: (msg, fields) => write('warn', msg, fields, base),
    info: (msg, fields) => write('info', msg, fields, base),
    debug: (msg, fields) => write('debug', msg, fields, base),
    child: (baseFields) => makeLogger({ ...(base || {}), ...baseFields }),
  };
}

/** The shared application logger. */
export const logger: Logger = makeLogger();
