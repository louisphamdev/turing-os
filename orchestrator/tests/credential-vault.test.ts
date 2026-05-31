/**
 * Unit tests for CredentialVault authenticated encryption (AES-256-GCM).
 *
 * Verifies: encrypt -> store -> decrypt round-trip, GCM integrity (tampering
 * with the ciphertext or auth tag makes decrypt fail and return null), proper
 * 256-bit key derivation, and that NO plaintext hash is persisted on disk.
 *
 * Hermetic: each test uses a throwaway temp dir for vault-data and never
 * touches real services.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CredentialVault } from '../src/core/credential-vault';

const MASTER_KEY = 'test-vault-key-must-be-at-least-32-chars-long123';

function makeTempVault(): { vault: CredentialVault; storagePath: string } {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  const vault = new CredentialVault({ encryptionKey: MASTER_KEY, storagePath, cacheTTL: 1 });
  return { vault, storagePath };
}

function readStoredFile(storagePath: string, id: string): Record<string, unknown> {
  const content = fs.readFileSync(path.join(storagePath, `${id}.json`), 'utf8');
  return JSON.parse(content);
}

describe('CredentialVault (AES-256-GCM)', () => {
  const tempDirs: string[] = [];

  function track(storagePath: string): void {
    tempDirs.push(storagePath);
  }

  afterAll(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a stored credential back to the original key', async () => {
    const { vault, storagePath } = makeTempVault();
    track(storagePath);

    const secret = 'sk-super-secret-api-key-value-1234567890';
    const id = await vault.storeCredential({
      type: 'llm',
      provider: 'openai',
      encryptedKey: secret,
      authHeader: 'Bearer',
      metadata: { label: 'OpenAI' },
    });

    const decrypted = await vault.getCredential(id);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.key).toBe(secret);
    expect(decrypted!.type).toBe('llm');
    expect(decrypted!.provider).toBe('openai');
    expect(decrypted!.authHeader).toBe('Bearer');
  });

  it('persists ciphertext + iv + authTag and NEVER a plaintext hash', async () => {
    const { vault, storagePath } = makeTempVault();
    track(storagePath);

    const secret = 'sk-another-secret-key-abcdefghijklmnop';
    const id = await vault.storeCredential({
      type: 'plane',
      provider: 'generic',
      encryptedKey: secret,
      authHeader: 'Bearer',
      metadata: {},
    });

    const onDisk = readStoredFile(storagePath, id);
    // Authenticated-encryption fields are present...
    expect(typeof onDisk.encryptedKey).toBe('string');
    expect(typeof onDisk.iv).toBe('string');
    expect(typeof onDisk.authTag).toBe('string');
    // ...the IV is a 12-byte (24 hex chars) GCM nonce and the tag is 16 bytes.
    expect((onDisk.iv as string).length).toBe(24);
    expect((onDisk.authTag as string).length).toBe(32);
    // The plaintext is never stored, and no plaintext hash leaks an oracle.
    expect(onDisk).not.toHaveProperty('keyHash');
    expect(onDisk).not.toHaveProperty('hash');
    const serialized = JSON.stringify(onDisk);
    expect(serialized).not.toContain(secret);
    // A SHA-256 of the plaintext must not be present anywhere on disk.
    const crypto = await import('crypto');
    const plaintextHash = crypto.createHash('sha256').update(secret).digest('hex');
    expect(serialized).not.toContain(plaintextHash);
  });

  it('fails to decrypt when the ciphertext is tampered with (GCM integrity)', async () => {
    const { vault, storagePath } = makeTempVault();
    track(storagePath);

    const secret = 'sk-tamper-target-key-zzzzzzzzzzzzzzzzzz';
    const id = await vault.storeCredential({
      type: 'bookstack',
      provider: 'generic',
      encryptedKey: secret,
      authHeader: 'Bearer',
      metadata: {},
    });

    // Flip a byte in the stored ciphertext on disk, then re-load a fresh vault.
    const filePath = path.join(storagePath, `${id}.json`);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const original = onDisk.encryptedKey as string;
    const flippedNibble = original[0] === 'a' ? 'b' : 'a';
    onDisk.encryptedKey = flippedNibble + original.slice(1);
    fs.writeFileSync(filePath, JSON.stringify(onDisk));

    const reloaded = new CredentialVault({ encryptionKey: MASTER_KEY, storagePath, cacheTTL: 1 });
    // Decrypt must fail closed (auth-tag mismatch is caught) and return null.
    const result = await reloaded.getCredential(id);
    expect(result).toBeNull();
  });

  it('fails to decrypt when the authTag is tampered with (GCM integrity)', async () => {
    const { vault, storagePath } = makeTempVault();
    track(storagePath);

    const secret = 'sk-authtag-target-key-yyyyyyyyyyyyyyyy';
    const id = await vault.storeCredential({
      type: 'matrix',
      provider: 'generic',
      encryptedKey: secret,
      authHeader: 'Bearer',
      metadata: {},
    });

    const filePath = path.join(storagePath, `${id}.json`);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const tag = onDisk.authTag as string;
    const flipped = (tag[0] === 'a' ? 'b' : 'a') + tag.slice(1);
    onDisk.authTag = flipped;
    fs.writeFileSync(filePath, JSON.stringify(onDisk));

    const reloaded = new CredentialVault({ encryptionKey: MASTER_KEY, storagePath, cacheTTL: 1 });
    const result = await reloaded.getCredential(id);
    expect(result).toBeNull();
  });

  it('skips legacy/foreign records lacking an authTag without crashing', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-legacy-'));
    track(storagePath);

    // Simulate an old aes-256-cbc record (no authTag field).
    const legacyId = 'legacy-0000';
    fs.writeFileSync(
      path.join(storagePath, `${legacyId}.json`),
      JSON.stringify({
        id: legacyId,
        type: 'llm',
        provider: 'openai',
        encryptedKey: 'deadbeef',
        iv: '00112233445566778899aabb',
        authHeader: 'Bearer',
        createdAt: new Date().toISOString(),
        metadata: {},
      })
    );

    // Construction loads from disk; the legacy record must be skipped, not throw.
    const vault = new CredentialVault({ encryptionKey: MASTER_KEY, storagePath, cacheTTL: 1 });
    expect(vault.listCredentials()).toHaveLength(0);
    expect(await vault.getCredential(legacyId)).toBeNull();
  });

  it('rejects a master key shorter than 32 characters', () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-shortkey-'));
    track(storagePath);
    expect(() => new CredentialVault({ encryptionKey: 'too-short', storagePath })).toThrow(
      /at least 32 characters/
    );
  });
});
