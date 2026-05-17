jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
  })),
}));

import {
  ROLE_PERMISSIONS,
  ROLE_RATE_LIMITS,
  Role,
  Permission,
} from '../src/core/rbac';

/** Helper: check if a permission list grants a specific permission (honours wildcards) */
function hasPermission(perms: Permission[], needed: Permission): boolean {
  if (perms.includes(needed)) return true;
  // Check for wildcard: e.g. 'llm:*' covers 'llm:read'
  const [domain] = needed.split(':') as [string];
  return perms.some((p) => p === `${domain}:*`);
}

describe('RBAC', () => {
  const roles: Role[] = [
    'software-engineer', 'qa', 'devops', 'data', 'security',
    'hr', 'pm', 'po', 'network', 'doctor',
  ];

  it('should have permissions defined for all roles', () => {
    for (const role of roles) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
    }
  });

  it('should have rate limits defined for all roles', () => {
    for (const role of roles) {
      expect(ROLE_RATE_LIMITS[role]).toBeDefined();
      expect(ROLE_RATE_LIMITS[role].requests).toBeGreaterThan(0);
      expect(ROLE_RATE_LIMITS[role].windowMs).toBeGreaterThan(0);
    }
  });

  it('should grant llm:read to all roles', () => {
    for (const role of roles) {
      expect(hasPermission(ROLE_PERMISSIONS[role], 'llm:read')).toBe(true);
    }
  });

  it('should give pm full plane access', () => {
    const perms = ROLE_PERMISSIONS['pm'];
    expect(hasPermission(perms, 'plane:read')).toBe(true);
    expect(hasPermission(perms, 'plane:write')).toBe(true);
    expect(hasPermission(perms, 'plane:create-task')).toBe(true);
    expect(perms).toContain('plane:*');
  });

  it('should give security full access to all systems', () => {
    const perms = ROLE_PERMISSIONS['security'];
    expect(perms).toContain('plane:*');
    expect(perms).toContain('bookstack:*');
    expect(perms).toContain('github:*');
    expect(perms).toContain('matrix:*');
  });

  it('should restrict qa from github:write', () => {
    const perms = ROLE_PERMISSIONS['qa'];
    expect(hasPermission(perms, 'github:write')).toBe(false);
    expect(hasPermission(perms, 'github:repo')).toBe(false);
  });

  it('should give devops matrix read/write', () => {
    const perms = ROLE_PERMISSIONS['devops'];
    expect(hasPermission(perms, 'matrix:read')).toBe(true);
    expect(hasPermission(perms, 'matrix:write')).toBe(true);
  });

  it('should give software-engineer github:repo', () => {
    const perms = ROLE_PERMISSIONS['software-engineer'];
    expect(hasPermission(perms, 'github:repo')).toBe(true);
  });

  it('should limit hr to 20 requests per minute', () => {
    expect(ROLE_RATE_LIMITS['hr'].requests).toBe(20);
  });

  it('should give data role highest rate limit (100/min)', () => {
    expect(ROLE_RATE_LIMITS['data'].requests).toBe(100);
  });

  it('should give pm 40 requests per minute', () => {
    expect(ROLE_RATE_LIMITS['pm'].requests).toBe(40);
  });

  it('should not grant wildcard "*" permission to any role except security', () => {
    for (const role of roles) {
      if (role === 'security') continue;
      expect(ROLE_PERMISSIONS[role]).not.toContain('*');
    }
  });

  it('should have valid permission format for all role permissions', () => {
    const validPermissionPatterns = [
      /^llm:(read|write|\*)$/,
      /^plane:(read|write|create-task|\*)$/,
      /^bookstack:(read|write|\*)$/,
      /^matrix:(read|write|\*)$/,
      /^github:(read|write|repo|\*)$/,
    ];

    for (const role of roles) {
      for (const perm of ROLE_PERMISSIONS[role]) {
        const isValid = validPermissionPatterns.some((pattern) => pattern.test(perm));
        expect(isValid).toBe(true);
      }
    }
  });
});
