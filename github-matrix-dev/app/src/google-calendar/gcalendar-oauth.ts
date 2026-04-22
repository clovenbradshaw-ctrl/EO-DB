/**
 * Google Calendar OAuth — thin re-export of the shared Google OAuth module.
 *
 * The single PKCE flow in google-drive/gdrive-oauth.ts requests both Drive
 * (drive.file) and Calendar (calendar + calendar.events) scopes in one
 * consent, issuing one access token that works for both APIs. This module
 * exists purely for namespace hygiene so calendar code can import from
 * `google-calendar/` without reaching into `google-drive/`.
 */

export {
  getAccessToken,
  isConnected,
  startOAuthFlow,
  clearTokens,
  handleOAuthCallback,
  initGoogleOAuth,
  isGoogleOAuthConfigured,
} from '../google-drive/gdrive-oauth';
