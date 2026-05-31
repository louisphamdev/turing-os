/**
 * Role-Based Access Control (RBAC)
 * 
 * Defines roles, permissions, and RBAC rules for Turing OS workers.
 * Used by the gateway proxy to enforce access control.
 */

export type Role = 
  | 'software-engineer'
  | 'qa'
  | 'devops'
  | 'data'
  | 'security'
  | 'hr'
  | 'pm'
  | 'po'
  | 'network'
  | 'doctor';

export type Permission =
  // LLM permissions
  | 'llm:read'
  | 'llm:write'
  | 'llm:*'
  // Plane permissions (ticket / user-story persistence)
  | 'plane:read'
  | 'plane:write'
  | 'plane:create-task'
  | 'plane:*'
  // BookStack permissions
  | 'bookstack:read'
  | 'bookstack:write'
  | 'bookstack:*'
  // Matrix permissions
  | 'matrix:read'
  | 'matrix:write'
  | 'matrix:*'
  // GitHub permissions
  | 'github:read'
  | 'github:write'
  | 'github:repo'
  | 'github:*'
  // Remediation permissions (orchestrator-mediated docker control, P4b).
  // Only the doctor role gets this; it gates the POST /remediation endpoint.
  | 'remediation:execute'
  // Admin permissions
  | '*';

// Default permissions per role
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  'software-engineer': [
    'llm:*',
    'plane:read', 'plane:write', 'plane:create-task',
    'bookstack:read', 'bookstack:write',
    'github:read', 'github:write', 'github:repo',
  ],

  'qa': [
    'llm:read',
    'plane:read', 'plane:write', 'plane:create-task',
    'bookstack:read',
    'github:read',
  ],

  'devops': [
    'llm:read',
    'plane:read',
    'bookstack:read', 'bookstack:write',
    'github:read', 'github:write', 'github:repo',
    'matrix:read', 'matrix:write',
  ],

  'data': [
    'llm:*',
    'plane:read',
    'bookstack:read', 'bookstack:write',
  ],

  'security': [
    'llm:read',
    'plane:*',
    'bookstack:*',
    'github:*',
    'matrix:*',
  ],

  'hr': [
    'llm:read',
    'plane:read', 'plane:write',
    'bookstack:read', 'bookstack:write',
  ],

  'pm': [
    'llm:read',
    'plane:*',
    'bookstack:read', 'bookstack:write',
    'matrix:read', 'matrix:write',
  ],

  'po': [
    'llm:read',
    'plane:read', 'plane:write',
    'bookstack:read', 'bookstack:write',
  ],

  'network': [
    'llm:read',
    'plane:read',
    'bookstack:read', 'bookstack:write',
    'github:read',
    'matrix:read', 'matrix:write',
  ],

  'doctor': [
    'llm:read',
    'plane:read', 'plane:write',
    'bookstack:*',
    // Doctor files incident issues via the gateway (create_github_issue is a
    // POST = write), so it needs github:write in addition to github:read.
    'github:read', 'github:write',
    // P4b: Doctor (and ONLY Doctor) may call the orchestrator-mediated
    // remediation API (restart a worker container, read disk usage, prune
    // dangling docker resources). The orchestrator owns the docker socket;
    // the worker never does. This permission gates POST /remediation.
    'remediation:execute',
  ],
};

// Rate limits per role (requests per minute)
export const ROLE_RATE_LIMITS: Record<Role, { requests: number; windowMs: number }> = {
  'software-engineer': { requests: 60, windowMs: 60000 },
  'qa': { requests: 30, windowMs: 60000 },
  'devops': { requests: 60, windowMs: 60000 },
  'data': { requests: 100, windowMs: 60000 },
  'security': { requests: 100, windowMs: 60000 },
  'hr': { requests: 20, windowMs: 60000 },
  'pm': { requests: 40, windowMs: 60000 },
  'po': { requests: 30, windowMs: 60000 },
  'network': { requests: 50, windowMs: 60000 },
  'doctor': { requests: 60, windowMs: 60000 },
};

// Token expiration by role (hours)
export const ROLE_TOKEN_EXPIRY: Record<Role, number> = {
  'software-engineer': 24,
  'qa': 24,
  'devops': 12,      // Shorter for security-sensitive roles
  'data': 48,        // Longer for data processing
  'security': 8,     // Shortest for security
  'hr': 48,
  'pm': 24,
  'po': 48,
  'network': 12,
  'doctor': 24,
};

export interface RBACRule {
  service: string;
  endpoint: string;
  method?: string;
  allowedRoles: Role[];
  allowedPermissions: Permission[];
}

export class RBACService {
  /**
   * Get permissions for a role
   */
  getPermissionsForRole(role: Role): Permission[] {
    return ROLE_PERMISSIONS[role] || [];
  }

  /**
   * Get rate limit for a role
   */
  getRateLimitForRole(role: Role): { requests: number; windowMs: number } {
    return ROLE_RATE_LIMITS[role] || { requests: 30, windowMs: 60000 };
  }

  /**
   * Get token expiry for a role
   */
  getTokenExpiryForRole(role: Role): number {
    return ROLE_TOKEN_EXPIRY[role] || 24;
  }

  /**
   * Check if a role has a specific permission
   */
  hasPermission(role: Role, permission: Permission): boolean {
    const permissions = this.getPermissionsForRole(role);
    
    // Check exact match
    if (permissions.includes(permission)) {
      return true;
    }
    
    // Check wildcard
    const [service] = permission.split(':');
    const wildcard = `${service}:*` as Permission;
    
    return permissions.includes(wildcard) || permissions.includes('*');
  }

  /**
   * Check if a role can access a service
   */
  canAccessService(role: Role, service: 'llm' | 'plane' | 'bookstack' | 'matrix' | 'github'): boolean {
    const permissions = this.getPermissionsForRole(role);

    const servicePermissions = permissions.filter(p =>
      p.startsWith(service) || p === '*'
    );

    return servicePermissions.length > 0;
  }

  /**
   * Check if a role can perform a specific action
   */
  canPerformAction(
    role: Role,
    service: 'llm' | 'plane' | 'bookstack' | 'matrix' | 'github',
    action: 'read' | 'write' | 'admin'
  ): boolean {
    if (action === 'admin') {
      return this.hasPermission(role, '*');
    }
    
    const permission = `${service}:${action}` as Permission;
    
    // Check exact action
    if (this.hasPermission(role, permission)) {
      return true;
    }
    
    // Check service wildcard
    const wildcard = `${service}:*` as Permission;
    if (this.hasPermission(role, wildcard)) {
      return true;
    }
    
    return false;
  }

  /**
   * Validate permission against allowed set
   */
  validatePermission(permission: string): permission is Permission {
    const validPermissions: Permission[] = [
      'llm:read', 'llm:write', 'llm:*',
      'plane:read', 'plane:write', 'plane:create-task', 'plane:*',
      'bookstack:read', 'bookstack:write', 'bookstack:*',
      'matrix:read', 'matrix:write', 'matrix:*',
      'github:read', 'github:write', 'github:repo', 'github:*',
      'remediation:execute',
      '*',
    ];

    return validPermissions.includes(permission as Permission);
  }

  /**
   * Validate role
   */
  validateRole(role: string): role is Role {
    return Object.keys(ROLE_PERMISSIONS).includes(role);
  }

  /**
   * Get all available roles
   */
  getAllRoles(): Role[] {
    return Object.keys(ROLE_PERMISSIONS) as Role[];
  }

  /**
   * Get role metadata
   */
  getRoleMetadata(role: Role): {
    permissions: Permission[];
    rateLimit: { requests: number; windowMs: number };
    tokenExpiryHours: number;
  } {
    return {
      permissions: this.getPermissionsForRole(role),
      rateLimit: this.getRateLimitForRole(role),
      tokenExpiryHours: this.getTokenExpiryForRole(role),
    };
  }
}

// Singleton
let rbacServiceInstance: RBACService | null = null;

export function getRBACService(): RBACService {
  if (!rbacServiceInstance) {
    rbacServiceInstance = new RBACService();
  }
  return rbacServiceInstance;
}

/**
 * Map an HTTP method to the RBAC action it requires.
 * Safe methods are 'read'; mutations are 'write'.
 */
export function methodToAction(method: string): 'read' | 'write' {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS' ? 'read' : 'write';
}
