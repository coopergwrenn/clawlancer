/**
 * Run database migration directly against Supabase
 *
 * Usage: npx tsx scripts/run-migration.ts
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { config } from 'dotenv';

config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function runMigration() {
  const migrationPath = process.argv[2] || 'supabase/migrations/004_trust_infrastructure.sql';

  console.log(`Running migration: ${migrationPath}`);
  console.log('');

  const sql = readFileSync(migrationPath, 'utf-8');

  // Split by semicolons but handle function definitions (which contain semicolons)
  // We'll run the whole thing as a single statement
  const { error } = await supabase.rpc('exec_sql', { sql_query: sql });

  if (error) {
    // If rpc doesn't exist, try running statements individually
    if (error.message.includes('function') || error.message.includes('exec_sql')) {
      console.log('Running migration via individual statements...');

      // Split carefully - this is a simple split that won't handle all edge cases
      // but should work for our migration
      const statements = sql
        .split(/;\s*\n/)
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

      let success = 0;
      let failed = 0;

      for (const statement of statements) {
        if (!statement || statement.startsWith('--')) continue;

        const { error: stmtError } = await supabase.from('_migrations_temp').select().limit(0);

        // Use raw SQL execution via the REST API
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY!,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
            },
            body: JSON.stringify({ query: statement }),
          }
        );

        if (!response.ok) {
          // This approach won't work - we need to use the SQL editor or psql
          console.log('Direct SQL execution not available via REST API.');
          console.log('');
          console.log('Please run the migration manually:');
          console.log('1. Go to Supabase Dashboard > SQL Editor');
          console.log('2. Paste the contents of: supabase/migrations/004_trust_infrastructure.sql');
          console.log('3. Click "Run"');
          process.exit(1);
        }
      }

      console.log(`Completed: ${success} statements`);
      if (failed > 0) {
        console.log(`Failed: ${failed} statements`);
      }
    } else {
      console.error('Migration failed:', error.message);
      process.exit(1);
    }
  } else {
    console.log('Migration completed successfully!');
  }
}

runMigration().catch(console.error);
