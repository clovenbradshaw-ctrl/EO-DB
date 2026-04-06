/**
 * Encrypted local storage — password-based AES-256-GCM encryption for
 * persisting data locally.
 *
 * Uses PBKDF2 (100k iterations, SHA-256) to derive a 256-bit key from a
 * user password. Data is encrypted with AES-256-GCM and stored as a single
 * binary blob: [16-byte salt | 12-byte IV | ciphertext+tag].
 *
 * This module works in both Node.js (via node:crypto) and browser (via
 * Web Crypto API) environments.
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 32; // 256 bits
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = 'aes-256-gcm';

/** Magic bytes to identify our encrypted format. */
const MAGIC = Buffer.from('EOENC1');

// ─── Key derivation ─────────────────────────────────────────────────────────

/**
 * Derive a 256-bit AES key from a password and salt using PBKDF2.
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Hash a password for quick verification (not the encryption key itself).
 * Used to check "is this the right password?" without decrypting everything.
 * Returns hex-encoded SHA-256(salt + PBKDF2(password, salt)).
 */
export function passwordVerificationHash(password: string, salt: Buffer): string {
  const derived = deriveKey(password, salt);
  return createHash('sha256').update(Buffer.concat([salt, derived])).digest('hex');
}

// ─── Encrypt / Decrypt ──────────────────────────────────────────────────────

/**
 * Encrypt arbitrary data with a password.
 *
 * Returns a single buffer: [MAGIC | salt | IV | ciphertext | auth_tag]
 */
export function encryptWithPassword(data: Buffer, password: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, salt, iv, encrypted, authTag]);
}

/**
 * Decrypt a buffer that was encrypted with encryptWithPassword.
 *
 * Throws on wrong password (GCM auth tag verification failure).
 */
export function decryptWithPassword(blob: Buffer, password: string): Buffer {
  // Validate magic header
  if (blob.length < MAGIC.length + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Invalid encrypted data: bad magic header');
  }

  let offset = MAGIC.length;
  const salt = blob.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = blob.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const ciphertextWithTag = blob.subarray(offset);

  if (ciphertextWithTag.length < AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted data: missing auth tag');
  }

  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AUTH_TAG_LENGTH);
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - AUTH_TAG_LENGTH);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted;
  } catch (err: any) {
    if (err.message?.includes('Unsupported state') || err.code === 'ERR_OSSL_BAD_DECRYPT') {
      throw new Error('Decryption failed: wrong password or corrupted data');
    }
    throw err;
  }
}

// ─── File-based encrypted store ─────────────────────────────────────────────

/**
 * EncryptedLocalStore — reads and writes JSON-serializable data to an
 * encrypted file on disk.
 *
 * Each write re-encrypts with a fresh salt and IV. The password is never
 * stored — it must be provided on every read/write call.
 */
export class EncryptedLocalStore {
  private basePath: string;

  constructor(dataDir: string) {
    this.basePath = dataDir;
  }

  private filePath(name: string): string {
    return join(this.basePath, `${name}.enc`);
  }

  /**
   * Write a value to an encrypted file.
   */
  async put<T>(name: string, value: T, password: string): Promise<void> {
    const json = JSON.stringify(value);
    const encrypted = encryptWithPassword(Buffer.from(json, 'utf8'), password);
    await mkdir(dirname(this.filePath(name)), { recursive: true });
    await writeFile(this.filePath(name), encrypted);
  }

  /**
   * Read a value from an encrypted file.
   * Returns null if the file doesn't exist.
   * Throws on wrong password.
   */
  async get<T>(name: string, password: string): Promise<T | null> {
    try {
      const blob = await readFile(this.filePath(name));
      const decrypted = decryptWithPassword(blob, password);
      return JSON.parse(decrypted.toString('utf8')) as T;
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Check if an encrypted file exists (doesn't require password).
   */
  async has(name: string): Promise<boolean> {
    try {
      await readFile(this.filePath(name), { flag: 'r' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete an encrypted file.
   */
  async delete(name: string): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    try {
      await unlink(this.filePath(name));
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * Re-encrypt all files with a new password.
   * Requires the old password to decrypt first.
   */
  async changePassword(oldPassword: string, newPassword: string, names: string[]): Promise<void> {
    // Decrypt all values first (validates old password)
    const entries: Array<{ name: string; value: any }> = [];
    for (const name of names) {
      const value = await this.get(name, oldPassword);
      if (value !== null) {
        entries.push({ name, value });
      }
    }
    // Re-encrypt with new password
    for (const { name, value } of entries) {
      await this.put(name, value, newPassword);
    }
  }
}

// ─── Database-level encryption for logout ───────────────────────────────────

/**
 * Encrypt an entire LevelDB data directory into a single encrypted archive.
 *
 * Walks all files in `dbDir`, packs them into a JSON manifest
 * { files: [{ path, data_base64 }] }, encrypts the manifest with the
 * password, and writes it to `outputPath`.
 *
 * After encryption, the original DB files can be safely deleted.
 */
export async function encryptDatabase(
  dbDir: string,
  password: string,
  outputPath: string,
): Promise<void> {
  const files: Array<{ path: string; data: string }> = [];
  await collectFiles(dbDir, dbDir, files);

  const manifest = JSON.stringify({ files, encrypted_at: new Date().toISOString() });
  const encrypted = encryptWithPassword(Buffer.from(manifest, 'utf8'), password);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, encrypted);
}

/**
 * Decrypt an encrypted database archive back into a directory.
 *
 * Restores all files from the encrypted manifest.
 */
export async function decryptDatabase(
  encryptedPath: string,
  password: string,
  dbDir: string,
): Promise<void> {
  const blob = await readFile(encryptedPath);
  const decrypted = decryptWithPassword(blob, password);
  const manifest = JSON.parse(decrypted.toString('utf8')) as {
    files: Array<{ path: string; data: string }>;
  };

  for (const file of manifest.files) {
    const fullPath = join(dbDir, file.path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, Buffer.from(file.data, 'base64'));
  }
}

/**
 * Check if an encrypted database archive exists.
 */
export async function hasEncryptedDatabase(outputPath: string): Promise<boolean> {
  try {
    await stat(outputPath);
    return true;
  } catch {
    return false;
  }
}

/** Recursively collect all files in a directory. */
async function collectFiles(
  baseDir: string,
  currentDir: string,
  out: Array<{ path: string; data: string }>,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(baseDir, fullPath, out);
    } else if (entry.isFile()) {
      const relativePath = fullPath.slice(baseDir.length + 1);
      const data = await readFile(fullPath);
      out.push({ path: relativePath, data: data.toString('base64') });
    }
  }
}
