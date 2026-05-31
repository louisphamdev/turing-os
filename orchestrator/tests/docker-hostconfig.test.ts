/**
 * Unit test for worker container least-privilege hardening (Task P2-1).
 *
 * The base-worker image already runs as a non-root `USER worker`, but the
 * spawned container's HostConfig must ALSO drop all Linux capabilities and
 * block privilege escalation. This test locks that config in by inspecting the
 * object passed to a mocked `createContainer` — it does NOT prove the worker
 * still runs under those flags (that requires a live-stack smoke test).
 */

// Mock redis so ConsumerTokenManager's fire-and-forget _initRedis() never tries
// to open a real socket during the test.
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
  })),
}));

// Capture every createContainer payload and stub the dockerode surface that
// spawnWorker touches (listContainers for the max-workers check, and the
// returned container's start()).
const createContainerMock = jest.fn().mockResolvedValue({
  id: 'container-abc123',
  start: jest.fn().mockResolvedValue(undefined),
});
const listContainersMock = jest.fn().mockResolvedValue([]);

jest.mock('dockerode', () => {
  return jest.fn().mockImplementation(() => ({
    createContainer: createContainerMock,
    listContainers: listContainersMock,
  }));
});

import { DockerService } from '../src/core/docker';

describe('spawnWorker HostConfig least-privilege (P2-1)', () => {
  beforeEach(() => {
    createContainerMock.mockClear();
    listContainersMock.mockClear();
    listContainersMock.mockResolvedValue([]);
  });

  it('drops all capabilities and blocks privilege escalation', async () => {
    const docker = new DockerService();
    await docker.spawnWorker('T-1', 'software-engineer', '!room:server');

    expect(createContainerMock).toHaveBeenCalledTimes(1);
    const payload = createContainerMock.mock.calls[0][0];
    const hostConfig = payload.HostConfig;

    expect(hostConfig.CapDrop).toEqual(['ALL']);
    expect(hostConfig.SecurityOpt).toEqual(['no-new-privileges']);
  });

  it('keeps the existing resource limits and bind mount', async () => {
    const docker = new DockerService();
    await docker.spawnWorker('T-2', 'qa', '!room:server');

    const hostConfig = createContainerMock.mock.calls[0][0].HostConfig;
    expect(hostConfig.AutoRemove).toBe(true);
    expect(hostConfig.Binds).toEqual(['worker_workspace:/workspace']);
    expect(typeof hostConfig.Memory).toBe('number');
    expect(typeof hostConfig.NanoCpus).toBe('number');
  });

  it('does NOT set ReadonlyRootfs (deferred — needs tmpfs + live testing)', async () => {
    const docker = new DockerService();
    await docker.spawnWorker('T-3', 'devops', '!room:server');

    const hostConfig = createContainerMock.mock.calls[0][0].HostConfig;
    expect(hostConfig.ReadonlyRootfs).toBeUndefined();
  });
});
