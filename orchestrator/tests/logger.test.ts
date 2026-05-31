/**
 * Unit tests for the structured logger.
 *
 * Hermetic: no Express, no network. We stub process.stdout/stderr.write to
 * capture the emitted JSON lines, and we restore LOG_LEVEL after each case so
 * level-gating tests don't leak into one another.
 */

import { logger, redact } from '../src/core/logger';

// Capture every line written to stdout/stderr while `fn` runs, then restore.
function captureWrites(fn: () => void): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
  const errSpy = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    });
  try {
    fn();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout, stderr };
}

// Parse the single JSON record from a captured line array.
function parseOne(lines: string[]): any {
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0]);
}

describe('logger', () => {
  const ORIGINAL_LEVEL = process.env.LOG_LEVEL;
  afterEach(() => {
    if (ORIGINAL_LEVEL === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = ORIGINAL_LEVEL;
  });

  describe('redaction', () => {
    it('masks token / secret / password / authorization values', () => {
      const out = redact({
        token: 'abc123',
        secret: 'shh',
        password: 'hunter2',
        authorization: 'Bearer xyz',
        userId: 'u-1',
        count: 42,
      }) as Record<string, unknown>;

      expect(out.token).toBe('[REDACTED]');
      expect(out.secret).toBe('[REDACTED]');
      expect(out.password).toBe('[REDACTED]');
      expect(out.authorization).toBe('[REDACTED]');
      // Innocuous fields pass through untouched.
      expect(out.userId).toBe('u-1');
      expect(out.count).toBe(42);
    });

    it('redacts nested sensitive fields recursively', () => {
      const out = redact({
        meta: {
          ok: 'visible',
          apiKey: 'sk-deep',
          inner: { bearer: 'tok', label: 'fine' },
        },
        list: [{ accessToken: 'a' }, { plain: 'b' }],
      }) as any;

      expect(out.meta.ok).toBe('visible');
      expect(out.meta.apiKey).toBe('[REDACTED]');
      expect(out.meta.inner.bearer).toBe('[REDACTED]');
      expect(out.meta.inner.label).toBe('fine');
      // Arrays are walked too.
      expect(out.list[0].accessToken).toBe('[REDACTED]');
      expect(out.list[1].plain).toBe('b');
    });

    it('matches case-insensitively (e.g. Authorization, API_KEY)', () => {
      const out = redact({
        Authorization: 'Bearer z',
        API_KEY: 'k',
        PASSWORD: 'p',
      }) as Record<string, unknown>;
      expect(out.Authorization).toBe('[REDACTED]');
      expect(out.API_KEY).toBe('[REDACTED]');
      expect(out.PASSWORD).toBe('[REDACTED]');
    });

    it('does not crash on a cyclic object (and emits the record)', () => {
      const cyclic: any = { name: 'root', token: 'leak' };
      cyclic.self = cyclic; // cycle
      // redact() must not throw / stack-overflow.
      expect(() => redact(cyclic)).not.toThrow();

      process.env.LOG_LEVEL = 'info';
      const { stdout } = captureWrites(() => logger.info('cyclic_msg', cyclic));
      const rec = parseOne(stdout);
      expect(rec.name).toBe('root');
      expect(rec.token).toBe('[REDACTED]');
      // The logger merges fields into a fresh object (spread copy), so the
      // top-level `self` is a redacted copy of `cyclic`; the cycle is broken
      // one level deeper with a marker rather than recursing forever.
      expect(rec.self.name).toBe('root');
      expect(rec.self.token).toBe('[REDACTED]');
      expect(rec.self.self).toBe('[Circular]');
    });
  });

  describe('level filtering', () => {
    it('drops debug and emits error when LOG_LEVEL=info', () => {
      process.env.LOG_LEVEL = 'info';

      const debugCap = captureWrites(() => logger.debug('should_drop', { a: 1 }));
      expect(debugCap.stdout).toHaveLength(0);
      expect(debugCap.stderr).toHaveLength(0);

      const errorCap = captureWrites(() => logger.error('should_emit', { a: 1 }));
      // error goes to stderr.
      expect(errorCap.stdout).toHaveLength(0);
      const rec = parseOne(errorCap.stderr);
      expect(rec.level).toBe('error');
      expect(rec.msg).toBe('should_emit');
      expect(rec.a).toBe(1);
    });

    it('emits debug when LOG_LEVEL=debug', () => {
      process.env.LOG_LEVEL = 'debug';
      const { stdout } = captureWrites(() => logger.debug('verbose', { x: 'y' }));
      const rec = parseOne(stdout);
      expect(rec.level).toBe('debug');
      expect(rec.msg).toBe('verbose');
      expect(rec.x).toBe('y');
    });

    it('defaults to info when LOG_LEVEL is unset', () => {
      delete process.env.LOG_LEVEL;
      const dropped = captureWrites(() => logger.debug('drop_me'));
      expect(dropped.stdout).toHaveLength(0);
      const emitted = captureWrites(() => logger.info('keep_me'));
      expect(parseOne(emitted.stdout).msg).toBe('keep_me');
    });
  });

  describe('record shape', () => {
    it('includes ts (ISO), level, msg and merged fields', () => {
      process.env.LOG_LEVEL = 'info';
      const { stdout } = captureWrites(() => logger.info('shape', { foo: 'bar' }));
      const rec = parseOne(stdout);
      expect(typeof rec.ts).toBe('string');
      // ISO-8601 with Z suffix.
      expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(rec.level).toBe('info');
      expect(rec.msg).toBe('shape');
      expect(rec.foo).toBe('bar');
    });
  });

  describe('child()', () => {
    it('merges base fields into every record', () => {
      process.env.LOG_LEVEL = 'info';
      const child = logger.child({ requestId: 'req-42' });
      const { stdout } = captureWrites(() => child.info('with_base', { extra: true }));
      const rec = parseOne(stdout);
      expect(rec.requestId).toBe('req-42');
      expect(rec.extra).toBe(true);
    });

    it('lets per-call fields override base fields', () => {
      process.env.LOG_LEVEL = 'info';
      const child = logger.child({ requestId: 'base' });
      const { stdout } = captureWrites(() => child.info('override', { requestId: 'call' }));
      expect(parseOne(stdout).requestId).toBe('call');
    });

    it('redacts base fields too (sensitive correlation context)', () => {
      process.env.LOG_LEVEL = 'info';
      const child = logger.child({ requestId: 'r', token: 'leak' });
      const { stdout } = captureWrites(() => child.info('redacted_base'));
      const rec = parseOne(stdout);
      expect(rec.requestId).toBe('r');
      expect(rec.token).toBe('[REDACTED]');
    });
  });
});
