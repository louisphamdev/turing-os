/**
 * Credential Vault - Secure credential storage and management
 *
 * Stores encrypted API keys and provides secure retrieval for the gateway proxy.
 * All credentials are encrypted at rest with AES-256-GCM (authenticated
 * encryption) so any tampering with the stored ciphertext is detected on
 * decrypt and rejected.
 *
 * NOTE: The on-disk format changed from aes-256-cbc to aes-256-gcm (new
 * `authTag` field, no plaintext hash). Any pre-existing `vault-data/` written
 * by an older build is NOT compatible and must be re-imported (e.g. via
 * `importFromEnvironment`). Old/foreign records fail to decrypt gracefully
 * (caught + logged, returns null) rather than crashing the orchestrator.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface StoredCredential {
  id: string;
  type: 'llm' | 'plane' | 'bookstack' | 'matrix' | 'github';
  provider: 'openai' | 'anthropic' | 'minimax' | 'google' | 'ollama' | 'generic';
  encryptedKey: string;
  iv: string;               // Initialization vector for AES-256-GCM (12 bytes, hex)
  authTag: string;          // GCM authentication tag (16 bytes, hex) - integrity check
  authHeader: string;       // 'Bearer' | 'ApiKey' | 'Basic'
  createdAt: Date;
  rotatedAt?: Date;
  expiresAt?: Date;
  metadata: {
    label?: string;
    projectId?: string;
    lastUsed?: Date;
    lastRotatedBy?: string;
  };
}

export interface DecryptedCredential {
  id: string;
  type: string;
  provider: string;
  key: string;
  authHeader: string;
}

interface VaultConfig {
  encryptionKey: Buffer;    // 32-byte AES-256 key derived from the master key
  storagePath: string;      // Where to store encrypted credentials
  cacheTTL: number;        // Cache TTL in milliseconds
}

/**
 * Options accepted by the CredentialVault constructor / getCredentialVault().
 * The master key is provided as a raw string (>= 32 chars) and is turned into a
 * proper 256-bit AES key internally; callers never supply key material as bytes.
 */
export interface VaultOptions {
  encryptionKey?: string;   // Raw master key (defaults to VAULT_MASTER_KEY env)
  storagePath?: string;
  cacheTTL?: number;
}

interface CacheEntry {
  credential: DecryptedCredential;
  expiresAt: number;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12; // 96-bit IV is the recommended nonce size for GCM

export class CredentialVault {
  private config: VaultConfig;
  private credentials: Map<string, StoredCredential> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private readonly cacheTTL: number;

  constructor(config: VaultOptions = {}) {
    const rawKey = config.encryptionKey || process.env.VAULT_MASTER_KEY;
    if (!rawKey) {
      throw new Error('[CredentialVault] VAULT_MASTER_KEY is required. Set the VAULT_MASTER_KEY environment variable.');
    }
    if (rawKey.length < KEY_LENGTH) {
      throw new Error(`[CredentialVault] VAULT_MASTER_KEY must be at least ${KEY_LENGTH} characters (got ${rawKey.length}).`);
    }
    // Derive a full 256-bit AES key from the master key: the raw SHA-256 digest
    // is a 32-byte Buffer used directly as the key. (Previously the hex digest
    // was sliced to 32 chars and used as UTF-8 bytes, leaving only the hex
    // charset and ~128 bits of effective entropy.)
    const derivedKey = crypto.createHash('sha256').update(rawKey, 'utf8').digest();

    this.config = {
      encryptionKey: derivedKey,
      storagePath: config.storagePath || path.join(process.cwd(), 'vault-data'),
      cacheTTL: config.cacheTTL || 5 * 60 * 1000, // 5 minutes default
    };
    
    this.cacheTTL = this.config.cacheTTL;
    this._ensureStorageDir();
    this._loadFromDisk();
  }

  /**
   * Encrypt a plaintext API key using AES-256-GCM (authenticated encryption).
   * Returns the ciphertext, a fresh random IV and the GCM auth tag (all hex).
   */
  private encrypt(plaintext: string): { encrypted: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = this.config.encryptionKey;

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // The auth tag is only available after final() and binds the ciphertext so
    // any tampering is detected on decrypt.
    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
    };
  }

  /**
   * Decrypt an AES-256-GCM encrypted API key. Throws if the auth tag does not
   * verify (i.e. the ciphertext/IV/tag was tampered with, or the record was
   * written by an incompatible/older build). Callers catch and treat that as
   * a non-decryptable credential.
   */
  private decrypt(encrypted: string, iv: string, authTag: string): string {
    const key = this.config.encryptionKey;
    const ivBuffer = Buffer.from(iv, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuffer);
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8'); // throws on auth-tag mismatch

    return decrypted;
  }

  /**
   * Store a new credential in the vault
   */
  async storeCredential(credential: Omit<StoredCredential, 'id' | 'encryptedKey' | 'iv' | 'authTag' | 'createdAt'> & { encryptedKey: string }): Promise<string> {
    const id = crypto.randomUUID();

    const { encrypted, iv, authTag } = this.encrypt(credential.encryptedKey);

    const storedCredential: StoredCredential = {
      ...credential,
      id,
      encryptedKey: encrypted,
      iv,
      authTag,
      createdAt: new Date(),
    };
    
    this.credentials.set(id, storedCredential);
    await this._saveToDisk(storedCredential);
    
    console.log(`[CredentialVault] Stored credential: ${id} (${credential.type}/${credential.provider})`);
    return id;
  }

  /**
   * Retrieve and decrypt a credential by ID
   */
  async getCredential(id: string, useCache = true): Promise<DecryptedCredential | null> {
    // Check cache first
    if (useCache) {
      const cached = this.cache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.credential;
      }
    }

    const stored = this.credentials.get(id);
    if (!stored) {
      console.warn(`[CredentialVault] Credential not found: ${id}`);
      return null;
    }

    // Check expiration
    if (stored.expiresAt && stored.expiresAt < new Date()) {
      console.warn(`[CredentialVault] Credential expired: ${id}`);
      return null;
    }

    try {
      const key = this.decrypt(stored.encryptedKey, stored.iv, stored.authTag);

      const decrypted: DecryptedCredential = {
        id: stored.id,
        type: stored.type,
        provider: stored.provider,
        key,
        authHeader: stored.authHeader,
      };

      // Update cache
      this.cache.set(id, {
        credential: decrypted,
        expiresAt: Date.now() + this.cacheTTL,
      });

      // Update last used
      stored.metadata.lastUsed = new Date();
      this._saveToDisk(stored);

      return decrypted;
    } catch (error) {
      console.error(`[CredentialVault] Failed to decrypt credential ${id}:`, error);
      return null;
    }
  }

  /**
   * Get credential by type and provider (e.g., 'llm' + 'openai')
   */
  async getCredentialByType(type: StoredCredential['type'], provider?: string): Promise<DecryptedCredential | null> {
    for (const [id, stored] of this.credentials.entries()) {
      if (stored.type === type) {
        if (provider && stored.provider !== provider) {
          continue;
        }
        return this.getCredential(id);
      }
    }
    return null;
  }

  /**
   * List all credential IDs (metadata only, no decrypted keys)
   */
  listCredentials(): Array<{ id: string; type: string; provider: string; label?: string; createdAt: Date; expiresAt?: Date }> {
    return Array.from(this.credentials.values()).map(stored => ({
      id: stored.id,
      type: stored.type,
      provider: stored.provider,
      label: stored.metadata.label,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    }));
  }

  /**
   * Delete a credential from the vault
   */
  async deleteCredential(id: string): Promise<boolean> {
    if (!this.credentials.has(id)) {
      return false;
    }

    this.credentials.delete(id);
    this.cache.delete(id);
    await this._deleteFromDisk(id);
    
    console.log(`[CredentialVault] Deleted credential: ${id}`);
    return true;
  }

  /**
   * Rotate a credential (store new, keep ID for continuity)
   */
  async rotateCredential(id: string, newKey: string): Promise<boolean> {
    const stored = this.credentials.get(id);
    if (!stored) {
      return false;
    }

    const { encrypted, iv, authTag } = this.encrypt(newKey);

    stored.encryptedKey = encrypted;
    stored.iv = iv;
    stored.authTag = authTag;
    stored.rotatedAt = new Date();
    stored.metadata.lastRotatedBy = 'system';
    stored.metadata.lastUsed = undefined;

    // Clear cache
    this.cache.delete(id);
    
    await this._saveToDisk(stored);
    
    console.log(`[CredentialVault] Rotated credential: ${id}`);
    return true;
  }

  /**
   * Revoke a credential (mark as expired immediately)
   */
  async revokeCredential(id: string): Promise<boolean> {
    const stored = this.credentials.get(id);
    if (!stored) {
      return false;
    }

    stored.expiresAt = new Date();
    this.cache.delete(id);
    
    await this._saveToDisk(stored);
    
    console.log(`[CredentialVault] Revoked credential: ${id}`);
    return true;
  }

  /**
   * Clear internal cache
   */
  clearCache(): void {
    this.cache.clear();
    console.log('[CredentialVault] Cache cleared');
  }

  /**
   * Bulk import credentials from environment variables
   */
  async importFromEnvironment(): Promise<number> {
    const envMappings: Array<{ envVar: string; type: StoredCredential['type']; provider: StoredCredential['provider']; label?: string }> = [
      { envVar: 'OPENAI_API_KEY', type: 'llm', provider: 'openai', label: 'OpenAI' },
      { envVar: 'ANTHROPIC_API_KEY', type: 'llm', provider: 'anthropic', label: 'Anthropic' },
      { envVar: 'MINIMAX_API_KEY', type: 'llm', provider: 'minimax', label: 'MiniMax' },
      { envVar: 'GOOGLE_API_KEY', type: 'llm', provider: 'google', label: 'Google' },
      { envVar: 'PLANE_API_TOKEN', type: 'plane', provider: 'generic', label: 'Plane' },
      { envVar: 'BOOKSTACK_TOKEN', type: 'bookstack', provider: 'generic', label: 'BookStack' },
      { envVar: 'MATRIX_BOT_TOKEN', type: 'matrix', provider: 'generic', label: 'Matrix' },
      { envVar: 'GITHUB_TOKEN', type: 'github', provider: 'generic', label: 'GitHub' },
    ];

    let imported = 0;
    
    for (const mapping of envMappings) {
      const key = process.env[mapping.envVar];
      if (key) {
        await this.storeCredential({
          type: mapping.type,
          provider: mapping.provider,
          encryptedKey: key,
          authHeader: mapping.type === 'llm' ? 'Bearer' : 'Bearer',
          metadata: { label: mapping.label || mapping.envVar },
        });
        imported++;
      }
    }
    
    console.log(`[CredentialVault] Imported ${imported} credentials from environment`);
    return imported;
  }

  // ============ Private Methods ============

  private _ensureStorageDir(): void {
    if (!fs.existsSync(this.config.storagePath)) {
      fs.mkdirSync(this.config.storagePath, { recursive: true });
    }
  }

  private _getCredentialFilePath(id: string): string {
    return path.join(this.config.storagePath, `${id}.json`);
  }

  private _loadFromDisk(): void {
    try {
      const files = fs.readdirSync(this.config.storagePath);
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        const filePath = path.join(this.config.storagePath, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const stored = JSON.parse(content) as StoredCredential;

        // Records written by an older (aes-256-cbc) build lack an authTag and
        // cannot be decrypted under GCM. Skip them rather than loading a record
        // that would silently fail every decrypt. Such vaults must be
        // re-imported (see file header note).
        if (typeof stored.authTag !== 'string') {
          console.warn(`[CredentialVault] Skipping incompatible credential file (no authTag): ${file}. Re-import required.`);
          continue;
        }

        // Convert date strings back to Date objects
        stored.createdAt = new Date(stored.createdAt);
        if (stored.rotatedAt) stored.rotatedAt = new Date(stored.rotatedAt);
        if (stored.expiresAt) stored.expiresAt = new Date(stored.expiresAt);
        
        this.credentials.set(stored.id, stored);
      }
      
      console.log(`[CredentialVault] Loaded ${this.credentials.size} credentials from disk`);
    } catch (error) {
      console.error('[CredentialVault] Failed to load credentials from disk:', error);
    }
  }

  private async _saveToDisk(credential: StoredCredential): Promise<void> {
    try {
      const filePath = this._getCredentialFilePath(credential.id);
      fs.writeFileSync(filePath, JSON.stringify(credential, null, 2));
    } catch (error) {
      console.error(`[CredentialVault] Failed to save credential ${credential.id}:`, error);
    }
  }

  private async _deleteFromDisk(id: string): Promise<void> {
    try {
      const filePath = this._getCredentialFilePath(id);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error(`[CredentialVault] Failed to delete credential ${id}:`, error);
    }
  }
}

// Singleton instance
let vaultInstance: CredentialVault | null = null;

export function getCredentialVault(config?: VaultOptions): CredentialVault {
  if (!vaultInstance) {
    vaultInstance = new CredentialVault(config);
  }
  return vaultInstance;
}

export function resetCredentialVault(): void {
  if (vaultInstance) {
    vaultInstance.clearCache();
    vaultInstance = null;
  }
}
