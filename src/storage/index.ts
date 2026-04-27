/**
 * Canonical storage entry point.
 *
 * `BlobClient` (encrypted, room-scoped, versioned) is the default data storage
 * for EO-DB. New code SHOULD call `getDefaultBlobClient()` / `requireDefaultBlobClient()`
 * rather than importing lower-level webhook clients directly.
 */

export * from './blob-client.js';
