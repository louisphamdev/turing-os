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
  // Taiga permissions  
  | 'taiga:read'
  | 'taiga:write'
  | 'taiga:create-task'
  | 'taiga:*'
  // Wiki permissions
  | 'wiki:read'
  | 'wiki:write'
  | 'wiki:*'
  // Matrix permissions
  | 'matrix:read'
  | 'matrix:write'
  | 'matrix:*'
  // GitHub permissions
  | 'github:read'
  | 'github:write'
  | 'github:repo'
  | 'github:*'
  // Admin permissions
  | '*';

// Default permissions per role
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  'software-engineer': [
    'llm:*',
    'taiga:read',
    'taiga:write',
    'taiga:create-task',
    'wiki:read',
    'wiki:write',
    'github:read',
    'github:write',
    'github:repo',
  ],
  
  'qa': [
    'llm:read',
    'taiga:read',
    'taiga:write',
    'taiga:create-task',
    'wiki:read',
    'github:read',
  ],
  
  'devops': [
    'llm:read',
    'taiga:read',
    'wiki:read',
    'wiki:write',
    'github:read',
    'github:write',
    'github:repo',
    'matrix:read',
    'matrix:write',
  ],
  
  'data': [
    'llm:*',
    'taiga:read',
    'wiki:read',
    'wiki:write',
  ],
  
  'security': [
    'llm:read',
    'taiga:*',
    'wiki:*',
    'github:*',
    'matrix:*',
  ],
  
  'hr': [
    'llm:read',
    'taiga:read',
    'taiga:write',
    'wiki:read',
    'wiki:write',
  ],
  
  'pm': [
    'llm:read',
    'taiga:*',
    'wiki:read',
    'wiki:write',
    'matrix:read',
    'matrix:write',
  ],
  
  'po': [
    'llm:read',
    'taiga:read',
    'taiga:write',
    'wiki:read',
    'wiki:write',
  ],
  
  'network': [
    'llm:read',
    'taiga:read',
    'wiki:read',
    'wiki:write',
    'github:read',
    'matrix:read',
    'matrix:write',
  ],
  
  'doctor': [
    'llm:read',
    'taiga:read',
    'taiga:write',
    'wiki:*',
    'github:read',
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
  canAccessService(role: Role, service: 'llm' | 'taiga' | 'wiki' | 'matrix' | 'github'): boolean {
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
    service: 'llm' | 'taiga' | 'wiki' | 'matrix' | 'github',
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
      'taiga:read', 'taiga:write', 'taiga:create-task', 'taiga:*',
      'wiki:read', 'wiki:write', 'wiki:*',
      'matrix:read', 'matrix:write', 'matrix:*',
      'github:read', 'github:write', 'github:repo', 'github:*',
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
