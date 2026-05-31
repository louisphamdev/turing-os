jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
  })),
}));

// Set the admin user id before importing config-dependent modules so the
// chat-handler authz check uses a known value.
process.env.MATRIX_ADMIN_USER_ID = '@admin:turing.local';

import { WorkerRegistry } from '../src/core/registry';
import { DockerService } from '../src/core/docker';
import { HealthMonitor } from '../src/core/health-monitor';
import { handleAdminCommand, AdminCommandDeps } from '../src/api/webhooks';
import { matrixService } from '../src/core/matrix';
import { config } from '../src/config';

// Mirror of the production chat command handler in src/index.ts: enforces
// admin-only authz, runs the shared command logic, and posts the text result
// back into the room. Kept here so the test exercises the same control flow
// without booting the whole orchestrator process.
async function runChatCommand(
  command: string,
  args: string[],
  roomId: string,
  sender: string,
  deps: AdminCommandDeps,
): Promise<void> {
  const adminUserId = config.matrix.adminUserId;
  if (!adminUserId || sender !== adminUserId) {
    await matrixService.sendToRoom(roomId, '🚫 Unauthorized: only the admin may run commands.');
    return;
  }
  const result = await handleAdminCommand(command, args, deps);
  await matrixService.sendToRoom(roomId, result.text);
}

describe('Matrix chat slash-commands', () => {
  let registry: WorkerRegistry;
  let deps: AdminCommandDeps;
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    registry = new WorkerRegistry();
    const docker = new DockerService();
    const healthMonitor = new HealthMonitor(registry, docker);
    // getHealthSummary touches Docker stats; stub it for hermetic tests.
    jest.spyOn(healthMonitor, 'getHealthSummary').mockResolvedValue([] as any);
    deps = { registry, docker, healthMonitor };
    sendSpy = jest.spyOn(matrixService, 'sendToRoom').mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleAdminCommand (shared logic)', () => {
    it('/status returns active worker summary', async () => {
      registry.register('T-1', 'RUNNING', 'se');
      const result = await handleAdminCommand('/status', [], deps);
      expect(result.status).toBe(200);
      expect(result.json.workers).toHaveLength(1);
      expect(result.text).toContain('T-1');
      expect(result.text).toContain('Status');
    });

    it('/help lists the available commands', async () => {
      const result = await handleAdminCommand('/help', [], deps);
      expect(result.status).toBe(200);
      expect(result.text).toContain('/status');
      expect(result.text).toContain('/unblock');
      expect(result.text).toContain('/kill');
      expect(result.text).toContain('/help');
    });

    it('/unblock unknown ticket returns 404', async () => {
      const result = await handleAdminCommand('/unblock', ['T-missing'], deps);
      expect(result.status).toBe(404);
      expect(result.text).toContain('not found');
    });

    it('/unblock with no ticket returns 400 usage (not "unknown command")', async () => {
      const result = await handleAdminCommand('/unblock', [], deps);
      expect(result.status).toBe(400);
      expect(result.json.error).toBe('Usage: /unblock <ticketId>');
      expect(result.text).toContain('Usage');
      expect(result.text).not.toContain('Unknown command');
    });

    it('/kill with no ticket returns 400 usage (not "unknown command")', async () => {
      const result = await handleAdminCommand('/kill', [], deps);
      expect(result.status).toBe(400);
      expect(result.json.error).toBe('Usage: /kill <ticketId>');
      expect(result.text).toContain('Usage');
      expect(result.text).not.toContain('Unknown command');
    });

    it('unknown command returns 400 and includes help', async () => {
      const result = await handleAdminCommand('/wat', [], deps);
      expect(result.status).toBe(400);
      expect(result.text).toContain('Unknown command');
      expect(result.text).toContain('/help');
    });
  });

  describe('chat handler authz + room reply', () => {
    it('runs an authorized /status and replies into the room', async () => {
      registry.register('T-9', 'RUNNING', 'pm');
      await runChatCommand('/status', [], '!room:turing.local', '@admin:turing.local', deps);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [roomArg, textArg] = sendSpy.mock.calls[0];
      expect(roomArg).toBe('!room:turing.local');
      expect(textArg).toContain('T-9');
    });

    it('rejects a non-admin sender without running the command', async () => {
      const cmdSpy = jest.spyOn(matrixService, 'getPendingQuestions');
      await runChatCommand('/status', [], '!room:turing.local', '@intruder:turing.local', deps);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [, textArg] = sendSpy.mock.calls[0];
      expect(textArg).toContain('Unauthorized');
      // Command logic must not have run for a non-admin.
      expect(cmdSpy).not.toHaveBeenCalled();
    });

    it('replies with the help list for /help', async () => {
      await runChatCommand('/help', [], '!room:turing.local', '@admin:turing.local', deps);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [, textArg] = sendSpy.mock.calls[0];
      expect(textArg).toContain('/status');
      expect(textArg).toContain('/kill');
    });
  });
});
