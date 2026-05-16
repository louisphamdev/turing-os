/**
 * Credential Vault - Secure credential storage and management
 * 
 * Stores encrypted API keys and provides secure retrieval for the gateway proxy.
 * All credentials are AES-256 encrypted at rest.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface StoredCredential {
  id: string;
  type: 'llm' | 'taiga' | 'bookstack' | 'matrix' | 'github';
  provider: 'openai' | 'anthropic' | 'minimax' | 'google' | 'ollama' | 'generic';
  encryptedKey: string;
  keyHash: string;          // SHA-256 hash for verification without decryption
  iv: string;               // Initialization vector for AES-256-CBC
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
  encryptionKey: string;    // Master encryption key (from environment)
  storagePath: string;      // Where to store encrypted credentials
  cacheTTL: number;        // Cache TTL in milliseconds
}

interface CacheEntry {
  credential: DecryptedCredential;
  expiresAt: number;
}

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

export class CredentialVault {
  private config: VaultConfig;
  private credentials: Map<string, StoredCredential> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private readonly cacheTTL: number;

  constructor(config: Partial<VaultConfig> = {}) {
    const rawKey = config.encryptionKey || process.env.VAULT_MASTER_KEY;
    if (!rawKey) {
      throw new Error('[CredentialVault] VAULT_MASTER_KEY is required. Set the VAULT_MASTER_KEY environment variable.');
    }
    if (rawKey.length < KEY_LENGTH) {
      throw new Error(`[CredentialVault] VAULT_MASTER_KEY must be at least ${KEY_LENGTH} characters (got ${rawKey.length}).`);
    }
    const normalisedKey = crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex').slice(0, KEY_LENGTH);

    this.config = {
      encryptionKey: normalisedKey,
      storagePath: config.storagePath || path.join(process.cwd(), 'vault-data'),
      cacheTTL: config.cacheTTL || 5 * 60 * 1000, // 5 minutes default
    };
    
    this.cacheTTL = this.config.cacheTTL;
    this._ensureStorageDir();
    this._loadFromDisk();
  }

  /**
   * Encrypt a plaintext API key using AES-256-CBC
   */
  private encrypt(plaintext: string): { encrypted: string; iv: string; hash: string } {
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = Buffer.from(this.config.encryptionKey, 'utf8');
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Create hash for verification without decryption
    const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      hash,
    };
  }

  /**
   * Decrypt an encrypted API key
   */
  private decrypt(encrypted: string, iv: string): string {
    const key = Buffer.from(this.config.encryptionKey, 'utf8');
    const ivBuffer = Buffer.from(iv, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuffer);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  /**
   * Store a new credential in the vault
   */
  async storeCredential(credential: Omit<StoredCredential, 'id' | 'encryptedKey' | 'keyHash' | 'iv' | 'createdAt'> & { encryptedKey: string }): Promise<string> {
    const id = crypto.randomUUID();
    
    const { encrypted, iv, hash } = this.encrypt(credential.encryptedKey);
    
    const storedCredential: StoredCredential = {
      ...credential,
      id,
      encryptedKey: encrypted,
      keyHash: hash,
      iv,
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
      const key = this.decrypt(stored.encryptedKey, stored.iv);
      
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

    const { encrypted, iv, hash } = this.encrypt(newKey);
    
    stored.encryptedKey = encrypted;
    stored.keyHash = hash;
    stored.iv = iv;
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
      { envVar: 'TAIGA_API_KEY', type: 'taiga', provider: 'generic', label: 'Taiga' },
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

export function getCredentialVault(config?: Partial<VaultConfig>): CredentialVault {
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
