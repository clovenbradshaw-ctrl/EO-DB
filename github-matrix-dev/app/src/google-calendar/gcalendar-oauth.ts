/**
 * Google Calendar OAuth — thin re-export of the shared Google OAuth module.
 */

export {
  getAccessToken,
  isConnected,
  startOAuthFlow,
  clearTokens,
  handleOAuthCallback,
  initGoogleOAuth,
  isGoogleOAuthConfigured,
} from '../google-oauth/google-oauth';
