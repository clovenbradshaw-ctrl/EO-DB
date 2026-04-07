/**
 * Filen listener configuration.
 *
 * Follows the same module-level state + getter pattern as
 * src/config/matrix-domain.ts. Call configureFilenListener() once
 * at startup; the rest of the app reads via getters.
 *
 * Environment variables:
 *   N8N_WEBHOOK_URL        — n8n webhook URL (default: http://localhost:5678/webhook/filen)
 *   FILEN_EMAIL            — Filen account email
 *   FILEN_PASSWORD         — Filen account password
 *   FILEN_FOLDER_UUID      — UUID of the folder to watch
 *   FILEN_FOLDER_PATH      — Virtual FS path (e.g. "/EO-DB"), used for health checks
 *   FILEN_HEALTH_INTERVAL  — Health check interval in ms (default: 30000)
 */

import type { FilenListenerConfig } from './types.js';

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_HEALTH_INTERVAL = 30_000;

// ─── Runtime state ─────────────────────────────────────────────────────────

let _config: FilenListenerConfig | null = null;

// ─── Loader ────────────────────────────────────────────────────────────────

/**
 * Build a FilenListenerConfig from environment variables.
 * Returns null if FILEN_FOLDER_UUID is not set (feature disabled).
 */
export function loadFilenConfig(): FilenListenerConfig | null {
  const folderUuid = process.env.FILEN_FOLDER_UUID;
  if (!folderUuid) return null;

  const masterKeysRaw = process.env.FILEN_MASTER_KEYS;
  const masterKeys = masterKeysRaw
    ? masterKeysRaw.split(',').map(k => k.trim()).filter(Boolean)
    : undefined;

  return {
    email: process.env.FILEN_EMAIL || undefined,
    password: process.env.FILEN_PASSWORD || undefined,
    twoFactorCode: process.env.FILEN_2FA_CODE || undefined,
    apiKey: process.env.FILEN_API_KEY || undefined,
    masterKeys,
    folderUuid,
    folderPath: process.env.FILEN_FOLDER_PATH || '/',
    healthCheckIntervalMs: parseInt(process.env.FILEN_HEALTH_INTERVAL || '', 10) || DEFAULT_HEALTH_INTERVAL,
  };
}

// ─── Setter (call once at startup) ─────────────────────────────────────────

export function configureFilenListener(cfg: FilenListenerConfig): void {
  _config = cfg;
}

// ─── Getters ───────────────────────────────────────────────────────────────

export function getFilenConfig(): FilenListenerConfig | null {
  return _config;
}

export function getFilenFolderUuid(): string {
  if (!_config) throw new Error('Filen listener not configured');
  return _config.folderUuid;
}
