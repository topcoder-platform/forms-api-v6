import { readFile } from 'node:fs/promises';

/**
 * Idempotently publishes the reviewed /lets-talk definition to the selected Forms API (development by default).
 * @param No arguments; reads FORMS_API_BASE_URL and FORMS_ADMIN_TOKEN from the environment.
 * @returns Completion after registration, immutable version save, and publication; creates no submissions.
 * @throws Error for a missing token, unsupported API base, conflicting revision, or failed API request.
 */
async function publishLetsTalk(): Promise<void> {
  const apiBase = (
    process.env.FORMS_API_BASE_URL ?? 'https://api.topcoder-dev.com/v6'
  ).replace(/\/+$/, '');
  if (
    ![
      'https://api.topcoder-dev.com/v6',
      'https://api.topcoder.com/v6',
    ].includes(apiBase)
  )
    throw new Error(
      'FORMS_API_BASE_URL must select the dev or production Topcoder API.',
    );
  const token = process.env.FORMS_ADMIN_TOKEN;
  if (!token)
    throw new Error(
      'FORMS_ADMIN_TOKEN with manage:forms or Administrator access is required.',
    );
  const definition: unknown = JSON.parse(
    await readFile('examples/lets-talk.json', 'utf8'),
  );
  const base = `${apiBase}/forms`;
  for (const [method, path, body] of [
    ['POST', '', { key: 'lets_talk' }],
    ['PUT', '/lets_talk/versions/1', definition],
    ['POST', '/lets_talk/versions/1/publish', undefined],
  ] as const) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `${method} ${path} failed (${response.status}); no credentials or response data logged.`,
      );
  }
  console.log(`Published lets_talk version 1 to ${apiBase}.`);
}

void publishLetsTalk().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Publication failed.');
  process.exitCode = 1;
});
