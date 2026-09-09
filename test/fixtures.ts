import { randomUUID } from 'node:crypto';
import { readConfig } from '../src/config';

export const testSecret = 'forms-integration-test-secret-only-000000000';

/**
 * Creates isolated test configuration using an explicitly supplied disposable database.
 * @returns Validated server settings. @throws Error if TEST_DATABASE_URL is missing.
 */
export function testConfig() {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error(
      'TEST_DATABASE_URL is required; use a disposable migrated PostgreSQL database.',
    );
  return readConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    AUTH_MODE: 'hs256',
    AUTH_SECRET: testSecret,
    VALID_ISSUERS: 'https://forms.test',
    AUTH_AUDIENCE: 'forms-api',
    THROTTLE_LIMIT: '10000',
    CORS_ORIGINS: 'https://www.topcoder.com',
  });
}

/**
 * Signs a local test token using the same JWT verification path as production.
 * @param claims Explicit user or M2M claims. @returns Signed bearer token string.
 * @throws JOSE errors if signing fails.
 */
export async function token(claims: Record<string, unknown>) {
  const { SignJWT } = await import('jose');
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('test-user')
    .setIssuer('https://forms.test')
    .setAudience('forms-api')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(testSecret));
}

/** Produces a unique valid named-form key; no inputs or exceptions, returned value isolates test fixtures. */
export function formKey() {
  return `test_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** Creates the complete all-types test definition; returns editable fixture data and throws no errors. */
export function definition() {
  return {
    title: 'Event interest',
    access: 'ANONYMOUS',
    successMessage: 'Thanks for registering.',
    fields: [
      {
        key: 'email',
        label: 'Email',
        type: 'EMAIL',
        required: true,
        maxLength: 254,
      },
      { key: 'name', label: 'Name', type: 'TEXT', maxLength: 100 },
      { key: 'notes', label: 'Notes', type: 'TEXTAREA' },
      {
        key: 'age',
        label: 'Age',
        type: 'INTEGER',
        minValue: '0',
        maxValue: '120',
      },
      { key: 'budget', label: 'Budget', type: 'DECIMAL', minValue: '0' },
      {
        key: 'updates',
        label: 'Receive updates',
        type: 'BOOLEAN',
        required: true,
      },
      { key: 'event_date', label: 'Date', type: 'DATE' },
      {
        key: 'track',
        label: 'Track',
        type: 'SINGLE_SELECT',
        options: [
          { key: 'design', label: 'Design' },
          { key: 'dev', label: 'Development' },
        ],
      },
      {
        key: 'interests',
        label: 'Interests',
        type: 'MULTI_SELECT',
        options: [
          { key: 'design', label: 'Design' },
          { key: 'dev', label: 'Development' },
        ],
      },
    ],
  };
}

/** Returns an all-types valid answer object preserving false, zero, and exact decimal strings; throws no errors. */
export function answers() {
  return {
    email: 'member@example.com',
    name: 'Example Member',
    notes: 'Line one\nLine two',
    age: 0,
    budget: '99999999999999.123456',
    updates: false,
    event_date: '2028-02-29',
    track: 'design',
    interests: ['dev', 'design'],
  };
}
