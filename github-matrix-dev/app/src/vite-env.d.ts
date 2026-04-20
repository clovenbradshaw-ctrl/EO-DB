/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID: string;
  /**
   * Optional build-time pin. When set, the login form hides the
   * homeserver input and every Matrix request is forced to this base URL,
   * producing an "instance-locked" build suitable for external repos that
   * reference the compiled assets but must only talk to a single server.
   */
  readonly VITE_MATRIX_HOMESERVER?: string;
  /**
   * Optional pre-fill for the homeserver input on unlocked builds. Lets a
   * deploy show its own server as the default placeholder without baking
   * the value into the source. Ignored when VITE_MATRIX_HOMESERVER is set.
   */
  readonly VITE_DEFAULT_HOMESERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
