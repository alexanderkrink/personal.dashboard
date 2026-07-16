/**
 * Connection configuration injected by the calling app.
 * This package never reads process.env — apps validate env vars
 * (via t3-env) and pass them in.
 */
export interface SupabaseConfig {
  url: string;
  /** Publishable key (sb_publishable_...) or legacy anon JWT. Safe for the browser. */
  publishableKey: string;
}

export interface SupabaseAdminConfig {
  url: string;
  /** Secret key (sb_secret_...) or legacy service_role JWT. Server-only. Bypasses RLS. */
  secretKey: string;
}
