/**
 * n8n webhook configuration.
 *
 * Same pattern as src/filen/config.ts — module-level state + getter,
 * configured once at startup from environment variables.
 *
 * Environment variables:
 *   N8N_WEBHOOK_URL          — Full base URL (e.g. "https://n8n.example.com")
 *   N8N_WEBHOOK_PATH         — Path segment (default: "/webhook/eo-store")
 *   N8N_WEBHOOK_AUTH_TOKEN   — Optional static bearer token
 *   N8N_MAX_PAYLOAD_BYTES    — Max payload before chunking (default: 5242880)
 *   N8N_TIMEOUT_MS           — Request timeout (default: 30000)
 */

import type { N8nWebhookConfig } from './types.js';

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_WEBHOOK_PATH = '/webhook/eo-store';
const DEFAULT_MAX_PAYLOAD = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT = 30_000;

// ─── Runtime state ─────────────────────────────────────────────────────────

let _config: N8nWebhookConfig | null = null;

// ─── Loader ────────────────────────────────────────────────────────────────

/**
 * Build an N8nWebhookConfig from environment variables.
 * Returns null if N8N_WEBHOOK_URL is not set (feature disabled).
 */
export function loadN8nConfig(): N8nWebhookConfig | null {
  const baseUrl = process.env.N8N_WEBHOOK_URL;
  if (!baseUrl) return null;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''), // strip trailing slashes
    webhookPath: process.env.N8N_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH,
    webhookAuthToken: process.env.N8N_WEBHOOK_AUTH_TOKEN || undefined,
    maxPayloadBytes:
      parseInt(process.env.N8N_MAX_PAYLOAD_BYTES || '', 10) || DEFAULT_MAX_PAYLOAD,
    timeoutMs:
      parseInt(process.env.N8N_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT,
  };
}

// ─── Setter (call once at startup) ─────────────────────────────────────────

export function configureN8nWebhook(cfg: N8nWebhookConfig): void {
  _config = cfg;
}

// ─── Getters ───────────────────────────────────────────────────────────────

export function getN8nConfig(): N8nWebhookConfig | null {
  return _config;
}

/** Full URL for the store/retrieve webhook endpoint. */
export function getWebhookUrl(): string {
  if (!_config) throw new Error('n8n webhook not configured');
  return `${_config.baseUrl}${_config.webhookPath}`;
}
