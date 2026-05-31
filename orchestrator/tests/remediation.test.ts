/**
 * Unit tests for the orchestrator-mediated remediation API (Task P4b).
 *
 * Hermetic: dockerode is fully mocked, so no real docker daemon is touched.
 * We assert:
 *   - restart_container restarts a worker-labelled container (Dockerode restart()),
 *   - restart_container REJECTS a non-worker / infra target (label check),
 *   - an unknown action is reported (isKnownAction → false; executeRemediation throws),
 *   - check_disk_usage returns df()-derived info (read-only),
 *   - cleanup_docker prunes ONLY dangling resources (dangling=true filters),
 *   - the doctor role passes the remediation:execute permission check and a
 *     non-doctor role is rejected,
 *   - every call is audit-logged via the structured logger.
 */

// Mock redis so any singleton that opens a client during import never touches a socket.
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
  })),
}));

// ─── Dockerode mock ─────────────────────────────────────────────────────────
const restartMock = jest.fn().mockResolvedValue(undefined);
const getContainerMock = jest.fn(() => ({ restart: restartMock }));
const listContainersMock = jest.fn();
const dfMock = jest.fn();
const pruneImagesMock = jest.fn();
const pruneVolumesMock = jest.fn();
const pruneNetworksMock = jest.fn();

jest.mock('dockerode', () => {
  return jest.fn().mockImplementation(() => ({
    getContainer: getContainerMock,
    listContainers: listContainersMock,
    df: dfMock,
    pruneImages: pruneImagesMock,
    pruneVolumes: pruneVolumesMock,
    pruneNetworks: pruneNetworksMock,
  }));
});

import { DockerService } from '../src/core/docker';
import {
  REMEDIATION_ACTIONS,
  isKnownAction,
  executeRemediation,
} from '../src/core/remediation';
import { logger } from '../src/core/logger';
import { RBACService } from '../src/core/rbac';

const WORKER_CONTAINER = {
  Id: 'aaaaaaaaaaaa1111',
  Names: ['/turing-worker-doctor-init-doctor'],
  Labels: { 'turing-worker': 'true', 'ticket-id': 'T-123' },
  State: 'running',
};

const INFRA_CONTAINER = {
  Id: 'bbbbbbbbbbbb2222',
  Names: ['/turing-postgres'],
  Labels: {}, // no turing-worker label
  State: 'running',
};

describe('remediation (P4b)', () => {
  let docker: DockerService;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // The worker-only listContainers (filtered by turing-worker=true) returns
    // only the worker — exactly what dockerode would do given the label filter.
    listContainersMock.mockResolvedValue([WORKER_CONTAINER]);
    docker = new DockerService();
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  // ─── allow-list shape ─────────────────────────────────────────────────────
  describe('allow-list', () => {
    it('exposes exactly the three ported actions with their guards', () => {
      expect(Object.keys(REMEDIATION_ACTIONS).sort()).toEqual(
        ['check_disk_usage', 'cleanup_docker', 'restart_container'],
      );
      expect(REMEDIATION_ACTIONS.restart_container.requiresAdmin).toBe(false);
      expect(REMEDIATION_ACTIONS.restart_container.destructive).toBe(true);
      expect(REMEDIATION_ACTIONS.check_disk_usage.requiresAdmin).toBe(false);
      expect(REMEDIATION_ACTIONS.check_disk_usage.destructive).toBe(false);
      // cleanup_docker is broad → admin-gated.
      expect(REMEDIATION_ACTIONS.cleanup_docker.requiresAdmin).toBe(true);
      expect(REMEDIATION_ACTIONS.cleanup_docker.destructive).toBe(true);
    });

    it('isKnownAction is true only for allow-listed actions', () => {
      expect(isKnownAction('restart_container')).toBe(true);
      expect(isKnownAction('check_disk_usage')).toBe(true);
      expect(isKnownAction('cleanup_docker')).toBe(true);
      expect(isKnownAction('rm_-rf')).toBe(false);
      expect(isKnownAction('exec')).toBe(false);
    });

    it('executeRemediation throws for an unknown action', async () => {
      await expect(
        executeRemediation('not_an_action', {}, docker),
      ).rejects.toThrow(/Unknown remediation action/);
    });
  });

  // ─── restart_container ────────────────────────────────────────────────────
  describe('restart_container', () => {
    it('restarts a worker-labelled container matched by ticket-id', async () => {
      const result = await executeRemediation(
        'restart_container',
        { target: 'T-123' },
        docker,
        { role: 'doctor', ticketId: 'init-doctor' },
      );

      expect(result.ok).toBe(true);
      expect(getContainerMock).toHaveBeenCalledWith(WORKER_CONTAINER.Id);
      expect(restartMock).toHaveBeenCalledTimes(1);
      expect(result.detail).toContain('T-123');
    });

    it('restarts a worker container matched by name (leading slash tolerant)', async () => {
      const result = await executeRemediation(
        'restart_container',
        { target: 'turing-worker-doctor-init-doctor' },
        docker,
      );
      expect(result.ok).toBe(true);
      expect(restartMock).toHaveBeenCalledTimes(1);
    });

    it('REJECTS a non-worker / infra target and never restarts it', async () => {
      // Worst case: even if the listContainers label filter were bypassed and
      // an infra container surfaced in the candidate set, the infra target name
      // must NOT match (it carries no turing-worker label and is not a worker).
      listContainersMock.mockResolvedValue([WORKER_CONTAINER, INFRA_CONTAINER]);

      const result = await executeRemediation(
        'restart_container',
        { target: 'turing-postgres' },
        docker,
      );

      expect(result.ok).toBe(false);
      // Rejected because the infra container carries no turing-worker label —
      // the label re-verification refuses to act on it.
      expect(result.detail).toMatch(/non-worker|No worker container matched/i);
      expect(restartMock).not.toHaveBeenCalled();
    });

    it('rejects when no target is provided', async () => {
      const result = await executeRemediation('restart_container', {}, docker);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/requires a "target"/);
      expect(restartMock).not.toHaveBeenCalled();
    });
  });

  // ─── check_disk_usage ─────────────────────────────────────────────────────
  describe('check_disk_usage', () => {
    it('returns df-style disk usage info (read-only, no mutation)', async () => {
      dfMock.mockResolvedValue({
        Images: [{ Size: 100 * 1024 * 1024 }, { Size: 50 * 1024 * 1024 }],
        Containers: [{ SizeRw: 10 * 1024 * 1024 }],
        Volumes: [{ UsageData: { Size: 200 * 1024 * 1024 } }],
        BuildCache: [{ Size: 5 * 1024 * 1024 }],
      });

      const result = await executeRemediation('check_disk_usage', {}, docker);

      expect(result.ok).toBe(true);
      expect(dfMock).toHaveBeenCalledTimes(1);
      const data = result.data as any;
      expect(data.images.count).toBe(2);
      expect(data.images.sizeBytes).toBe(150 * 1024 * 1024);
      expect(data.volumes.sizeBytes).toBe(200 * 1024 * 1024);
      // Read-only: no prune / restart side effects.
      expect(pruneImagesMock).not.toHaveBeenCalled();
      expect(restartMock).not.toHaveBeenCalled();
    });
  });

  // ─── cleanup_docker ───────────────────────────────────────────────────────
  describe('cleanup_docker', () => {
    it('prunes ONLY dangling images/volumes + unused networks', async () => {
      pruneImagesMock.mockResolvedValue({ ImagesDeleted: [{}, {}], SpaceReclaimed: 1234 });
      pruneVolumesMock.mockResolvedValue({ VolumesDeleted: ['v1'], SpaceReclaimed: 5678 });
      pruneNetworksMock.mockResolvedValue({ NetworksDeleted: ['n1', 'n2'] });

      const result = await executeRemediation('cleanup_docker', {}, docker);

      expect(result.ok).toBe(true);

      // Images + volumes pruned with the dangling=true filter ONLY.
      expect(pruneImagesMock).toHaveBeenCalledTimes(1);
      const imgArg = pruneImagesMock.mock.calls[0][0];
      expect(imgArg.filters).toEqual({ dangling: ['true'] });

      const volArg = pruneVolumesMock.mock.calls[0][0];
      expect(volArg.filters).toEqual({ dangling: ['true'] });

      expect(pruneNetworksMock).toHaveBeenCalledTimes(1);

      const data = result.data as any;
      expect(data.imagesDeleted).toBe(2);
      expect(data.volumesDeleted).toBe(1);
      expect(data.networksDeleted).toBe(2);
    });
  });

  // ─── RBAC permission check ────────────────────────────────────────────────
  describe('RBAC remediation:execute', () => {
    const rbac = new RBACService();

    it('grants remediation:execute to the doctor role', () => {
      expect(rbac.hasPermission('doctor', 'remediation:execute')).toBe(true);
    });

    it('denies remediation:execute to non-doctor roles', () => {
      for (const role of ['software-engineer', 'qa', 'devops', 'pm', 'po', 'hr', 'network', 'data'] as const) {
        expect(rbac.hasPermission(role, 'remediation:execute')).toBe(false);
      }
    });

    it('security role does NOT get remediation via its wildcards (no remediation:* and no global *)', () => {
      // security has plane:*, bookstack:*, github:*, matrix:* — none of which
      // cover remediation:execute, and it has no global '*'.
      expect(rbac.hasPermission('security', 'remediation:execute')).toBe(false);
    });

    it('validatePermission accepts remediation:execute', () => {
      expect(rbac.validatePermission('remediation:execute')).toBe(true);
    });
  });

  // ─── audit logging ────────────────────────────────────────────────────────
  describe('audit logging', () => {
    it('records an audit entry for a successful action with caller attribution', async () => {
      await executeRemediation(
        'restart_container',
        { target: 'T-123' },
        docker,
        { role: 'doctor', ticketId: 'init-doctor', workerId: 'w-doctor', tokenId: 'tok-1' },
      );

      expect(infoSpy).toHaveBeenCalledWith(
        'remediation_action',
        expect.objectContaining({
          action: 'restart_container',
          target: 'T-123',
          callerRole: 'doctor',
          callerTicketId: 'init-doctor',
          callerWorkerId: 'w-doctor',
          callerTokenId: 'tok-1',
          ok: true,
        }),
      );
    });

    it('records an audit entry even when the action fails', async () => {
      const result = await executeRemediation(
        'restart_container',
        { target: 'turing-postgres' },
        docker,
        { role: 'doctor' },
      );

      expect(result.ok).toBe(false);
      expect(infoSpy).toHaveBeenCalledWith(
        'remediation_action',
        expect.objectContaining({ action: 'restart_container', ok: false }),
      );
    });
  });
});
