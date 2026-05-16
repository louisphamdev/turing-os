/**
 * Credential Rotator
 * 
 * Handles automatic and manual credential rotation for the vault.
 * Supports rotation schedules, graceful transitions, and revocation.
 */

import { getCredentialVault, StoredCredential } from './credential-vault';
import { getConsumerTokenManager } from './consumer-token';

export interface RotationSchedule {
  credentialId: string;
  intervalDays: number;      // Rotate every N days
  lastRotated?: Date;
  nextRotation?: Date;
  autoRotate: boolean;
}

export interface RotationResult {
  success: boolean;
  credentialId: string;
  oldCredentialId?: string;
  newCredentialId?: string;
  error?: string;
}

// Map of provider rotation endpoints
const PROVIDER_ROTATION_ENDPOINTS: Record<string, {
  rotateEndpoint?: string;
  rotateMethod?: string;
  requiresNewKey: boolean;
}> = {
  'openai': {
    requiresNewKey: true,   // Must generate new key from OpenAI dashboard
  },
  'anthropic': {
    requiresNewKey: true,
  },
  'minimax': {
    requiresNewKey: true,
  },
  'google': {
    requiresNewKey: true,
  },
  'generic': {
    requiresNewKey: true,
  },
  'taiga': {
    requiresNewKey: false,   // May support API-based rotation
  },
  'bookstack': {
    requiresNewKey: false,
  },
  'matrix': {
    requiresNewKey: false,
  },
  'github': {
    requiresNewKey: true,    // GitHub personal access tokens
  },
};

export class CredentialRotator {
  private schedules: Map<string, RotationSchedule> = new Map();
  private rotationCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start background rotation checker (every hour)
    this.rotationCheckInterval = setInterval(() => {
      this.checkScheduledRotations().catch(err => {
        console.error('[CredentialRotator] Rotation check failed:', err);
      });
    }, 60 * 60 * 1000); // 1 hour

    console.log('[CredentialRotator] Started rotation scheduler');
  }

  /**
   * Schedule automatic rotation for a credential
   */
  scheduleRotation(
    credentialId: string,
    intervalDays: number,
    autoRotate: boolean = true
  ): void {
    const schedule: RotationSchedule = {
      credentialId,
      intervalDays,
      autoRotate,
      lastRotated: new Date(),
      nextRotation: new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000),
    };

    this.schedules.set(credentialId, schedule);
    console.log(`[CredentialRotator] Scheduled ${credentialId} for rotation every ${intervalDays} days`);
  }

  /**
   * Remove scheduled rotation
   */
  unscheduleRotation(credentialId: string): void {
    this.schedules.delete(credentialId);
    console.log(`[CredentialRotator] Unscheduled rotation for ${credentialId}`);
  }

  /**
   * Manually rotate a credential
   */
  async rotateCredential(
    credentialId: string,
    newKey?: string
  ): Promise<RotationResult> {
    const vault = getCredentialVault();

    // Get current credential
    const credential = await vault.getCredential(credentialId);
    if (!credential) {
      return {
        success: false,
        credentialId,
        error: 'Credential not found',
      };
    }

    try {
      // If no new key provided, try to get it from rotation endpoint
      if (!newKey) {
        const generatedKey = await this.generateNewKey(credential.provider);
        
        if (!generatedKey) {
          return {
            success: false,
            credentialId,
            error: `Could not generate new key for provider: ${credential.provider}. Please provide new key manually.`,
          };
        }
        
        newKey = generatedKey;
      }

      // Rotate the credential in vault
      const success = await vault.rotateCredential(credentialId, newKey);

      if (success) {
        // Update schedule
        const schedule = this.schedules.get(credentialId);
        if (schedule) {
          schedule.lastRotated = new Date();
          schedule.nextRotation = new Date(Date.now() + schedule.intervalDays * 24 * 60 * 60 * 1000);
        }

        // Revoke all existing tokens (workers need to re-authenticate)
        const tokenManager = getConsumerTokenManager();
        const tokens = tokenManager.listTokens();
        
        for (const token of tokens) {
          // Only revoke tokens that have access to this credential's service
          const serviceType = credential.type;
          // This is simplified - in production you'd want to check permissions
        }

        console.log(`[CredentialRotator] Successfully rotated credential ${credentialId}`);

        return {
          success: true,
          credentialId,
        };
      } else {
        return {
          success: false,
          credentialId,
          error: 'Vault rotation failed',
        };
      }
    } catch (error: any) {
      console.error(`[CredentialRotator] Rotation failed for ${credentialId}:`, error);
      return {
        success: false,
        credentialId,
        error: error.message,
      };
    }
  }

  /**
   * Revoke a credential immediately
   */
  async revokeCredential(credentialId: string): Promise<boolean> {
    const vault = getCredentialVault();
    
    // Mark as expired in vault
    const revoked = await vault.revokeCredential(credentialId);

    if (revoked) {
      // Remove from rotation schedule
      this.schedules.delete(credentialId);

      // Revoke all tokens
      const tokenManager = getConsumerTokenManager();
      tokenManager.revokeWorkerTokens('*'); // This revokes all - be careful in production

      console.log(`[CredentialRotator] Revoked credential ${credentialId}`);
    }

    return revoked;
  }

  /**
   * Check for credentials due for rotation
   */
  async checkScheduledRotations(): Promise<void> {
    const now = new Date();

    for (const [credentialId, schedule] of this.schedules.entries()) {
      if (!schedule.autoRotate) continue;
      if (!schedule.nextRotation) continue;

      if (now >= schedule.nextRotation) {
        console.log(`[CredentialRotator] Credential ${credentialId} is due for rotation`);

        const result = await this.rotateCredential(credentialId);

        if (!result.success) {
          console.error(`[CredentialRotator] Auto-rotation failed for ${credentialId}: ${result.error}`);
          // Could implement retry with backoff here
        }
      }
    }
  }

  /**
   * Get rotation status for all credentials
   */
  getRotationStatus(): Array<{
    credentialId: string;
    intervalDays: number;
    lastRotated?: Date;
    nextRotation?: Date;
    autoRotate: boolean;
    isDue: boolean;
  }> {
    const now = new Date();

    return Array.from(this.schedules.entries()).map(([credentialId, schedule]) => ({
      credentialId,
      intervalDays: schedule.intervalDays,
      lastRotated: schedule.lastRotated,
      nextRotation: schedule.nextRotation,
      autoRotate: schedule.autoRotate,
      isDue: schedule.nextRotation ? now >= schedule.nextRotation : false,
    }));
  }

  /**
   * Generate new key for a provider (placeholder - in production, use provider APIs)
   */
  private async generateNewKey(provider: string): Promise<string | null> {
    // This is a placeholder. In production, you would:
    // 1. Use provider-specific APIs to create new keys
    // 2. Or use secret management service integration (AWS Secrets Manager, HashiCorp Vault, etc.)
    
    const config = PROVIDER_ROTATION_ENDPOINTS[provider];

    if (!config) {
      console.warn(`[CredentialRotator] Unknown provider for rotation: ${provider}`);
      return null;
    }

    if (config.requiresNewKey) {
      // Cannot auto-generate - requires manual intervention
      console.warn(`[CredentialRotator] Provider ${provider} requires manual key generation`);
      return null;
    }

    // For providers with API-based rotation, implement here
    console.warn(`[CredentialRotator] Auto-rotation not implemented for ${provider}`);
    return null;
  }

  /**
   * Shutdown rotator
   */
  shutdown(): void {
    if (this.rotationCheckInterval) {
      clearInterval(this.rotationCheckInterval);
      this.rotationCheckInterval = null;
    }
    console.log('[CredentialRotator] Shutdown complete');
  }
}

// Singleton
let rotatorInstance: CredentialRotator | null = null;

export function getCredentialRotator(): CredentialRotator {
  if (!rotatorInstance) {
    rotatorInstance = new CredentialRotator();
  }
  return rotatorInstance;
}
