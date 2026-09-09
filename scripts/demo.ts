import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

/**
 * Creates/publishes the sample form, submits an example, and prints the named-column report.
 * @returns Completion. @throws Error outside local HS256 mode or when an API step fails.
 */
async function demo(): Promise<void> {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.AUTH_MODE !== 'hs256' ||
    !process.env.AUTH_SECRET
  )
    throw new Error('The demo requires local development HS256 configuration.');
  const { SignJWT } = await import('jose');
  const token = await new SignJWT({
    roles: ['Administrator'],
    userId: 'demo-member',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('local-demo')
    .setIssuer(process.env.VALID_ISSUERS!.split(',')[0])
    .setAudience(process.env.AUTH_AUDIENCE!)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
  const base = `http://127.0.0.1:${process.env.PORT ?? '3006'}/v6`;
  const definition: unknown = JSON.parse(
    await readFile(resolve('examples/event-interest.json'), 'utf8'),
  );

  /**
   * Sends one local demo request without printing credentials.
   * @param method HTTP verb. @param path API route. @param body Optional request body.
   * @returns Parsed response. @throws Error on a non-success HTTP response.
   */
  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `Demo ${method} ${path} failed: ${response.status} ${await response.text()}`,
      );
    return response.json();
  }

  await call('POST', '/forms', { key: 'event_interest' });
  await call('PUT', '/forms/event_interest/versions/1', definition);
  await call('POST', '/forms/event_interest/versions/1/publish');
  const receipt = await call('POST', '/forms/event_interest/submissions', {
    version: 1,
    answers: {
      email: 'demo@example.com',
      full_name: 'Demo Member',
      interests: ['design', 'development'],
      receive_updates: false,
    },
    sourcePage: '/events',
  });
  console.log('Saved receipt:', receipt);
  console.log(
    'Report:',
    JSON.stringify(
      await call('GET', '/forms/event_interest/versions/1/submissions'),
      null,
      2,
    ),
  );
}

void demo().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Demo failed.');
  process.exitCode = 1;
});
