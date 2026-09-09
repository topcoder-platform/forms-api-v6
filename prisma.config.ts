import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Pin Prisma's migration ledger to the same schema as the generated models.
// Client generation can run without credentials; migrations require a valid URL.
const databaseUrl = process.env.DATABASE_URL;
const datasource = databaseUrl ? new URL(databaseUrl) : undefined;
if (datasource) {
  if (
    !['postgres:', 'postgresql:'].includes(datasource.protocol) ||
    (datasource.searchParams.has('schema') &&
      datasource.searchParams.get('schema') !== 'forms')
  ) {
    throw new Error('Prisma requires a PostgreSQL URL using the forms schema.');
  }
  datasource.searchParams.set('schema', 'forms');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: datasource?.toString() ?? '' },
});
