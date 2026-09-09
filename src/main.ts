import 'reflect-metadata';
import { createApp } from './bootstrap';
import { readConfig } from './config';

/**
 * Starts the service using environment configuration.
 * @returns Completion after listening. @throws Startup/configuration errors to the process-level handler.
 */
async function main(): Promise<void> {
  const config = readConfig();
  const app = await createApp(config);
  await app.listen(config.port, '0.0.0.0');
}

void main().catch(() => {
  console.error(
    'Forms API startup failed. Check environment configuration and database availability.',
  );
  process.exitCode = 1;
});
