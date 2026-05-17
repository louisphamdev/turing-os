jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
  })),
}));

import { ConsumerTokenManager } from '../src/core/consumer-token';

describe('ConsumerTokenManager revocation', () => {
  it('revokeToken makes subsequent validateToken return "Token revoked"', () => {
    const mgr = new ConsumerTokenManager('test-secret-must-be-at-least-32-chars-long!!');
    const { token, tokenId } = mgr.generateToken({
      workerId: 'w1',
      role: 'qa',
      permissions: ['plane:read'],
      expiresIn: 1,
    });

    expect(mgr.validateToken(token).valid).toBe(true);

    const revoked = mgr.revokeToken(tokenId);
    expect(revoked).toBe(true);

    const result = mgr.validateToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Token revoked');
  });

  it('revokeWorkerTokens revokes every token of that worker', () => {
    const mgr = new ConsumerTokenManager('test-secret-must-be-at-least-32-chars-long!!');
    const a = mgr.generateToken({ workerId: 'w2', role: 'qa', permissions: ['plane:read'], expiresIn: 1 });
    const b = mgr.generateToken({ workerId: 'w2', role: 'qa', permissions: ['plane:read'], expiresIn: 1 });

    const count = mgr.revokeWorkerTokens('w2');
    expect(count).toBe(2);

    expect(mgr.validateToken(a.token).error).toBe('Token revoked');
    expect(mgr.validateToken(b.token).error).toBe('Token revoked');
  });

  it('does not impact unrelated tokens', () => {
    const mgr = new ConsumerTokenManager('test-secret-must-be-at-least-32-chars-long!!');
    const keep = mgr.generateToken({ workerId: 'keeper', role: 'pm', permissions: ['plane:read'], expiresIn: 1 });
    const drop = mgr.generateToken({ workerId: 'dropper', role: 'pm', permissions: ['plane:read'], expiresIn: 1 });

    mgr.revokeToken(drop.tokenId);

    expect(mgr.validateToken(keep.token).valid).toBe(true);
    expect(mgr.validateToken(drop.token).error).toBe('Token revoked');
  });
});
