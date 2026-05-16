import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _supabase;
}

/**
 * Test-only escape hatch. Overrides the cached supabase client so integration
 * tests can inject a mock with chainable `.from().select()/.update()/.eq()/...`
 * Pass `null` (or call with no args) to reset to the real-client lazy init.
 *
 * **Production code MUST NOT call this.** The double-underscore prefix is the
 * convention signal — anything starting with `__` is internal/testing surface.
 *
 * Used by `scripts/_test-cloud-init-callback-integration.ts` (and any future
 * route-level integration test) to exercise the full request handler without
 * a real Supabase backend or PostgREST mock-server.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __setSupabaseForTests(client: any | null): void {
  _supabase = client;
}
