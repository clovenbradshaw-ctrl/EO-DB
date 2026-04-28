/**
 * Hosted-Amino tenant constants.
 *
 * For users on the `app.aminoimmigration.com` Matrix homeserver, every
 * Airtable call is brokered by the n8n gateway at `webhook/eodb/airtable`.
 * The gateway holds the Airtable OAuth credential and only exposes a single
 * pre-configured base, so the browser never needs `meta/bases` discovery.
 */
export const AMINO_AIRTABLE_BASE_ID = 'app1tsUyKa7F3sy0D';
