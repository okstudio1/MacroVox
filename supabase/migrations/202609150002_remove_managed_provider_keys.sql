-- Quarantine the legacy client-readable secret table after the application
-- has moved to server-side provider authorization.
DO $$
BEGIN
  IF to_regclass('public.managed_api_keys') IS NOT NULL THEN
    EXECUTE 'UPDATE public.managed_api_keys SET deepgram_key = NULL, anthropic_key = NULL';
    EXECUTE 'ALTER TABLE public.managed_api_keys ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "Users read own keys" ON public.managed_api_keys';
    EXECUTE 'REVOKE ALL ON public.managed_api_keys FROM PUBLIC, anon, authenticated';
  END IF;
END;
$$;
