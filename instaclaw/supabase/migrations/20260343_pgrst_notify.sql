-- Force PostgREST to reload schema cache for any new columns
NOTIFY pgrst, 'reload schema';
