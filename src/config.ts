import 'dotenv/config';
import type { BusApiConfiguration } from 'tc-bus-api-wrapper';

/** Runtime configuration validated once before Nest starts serving requests. */
export interface AppConfig {
  databaseUrl: string;
  busApi?: BusApiConfiguration;
  port: number;
  origins: string[];
  authSecret: string;
  issuers: string[];
  claimNamespace: string;
  throttleLimit: number;
  trustProxy: string[];
}

/**
 * Parses server environment for bootstrap and tests.
 * @param env Environment variables, defaulting to process.env.
 * @returns Validated runtime settings.
 * @throws Error for missing values, unsafe authentication settings, or malformed URLs/numbers.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const database = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    (database.searchParams.has('schema') &&
      database.searchParams.get('schema') !== 'forms')
  ) {
    throw new Error('DATABASE_URL must be PostgreSQL using the forms schema.');
  }
  database.searchParams.set('schema', 'forms');
  const authSecret = required(env, 'AUTH_SECRET');
  if (authSecret.length < 32)
    throw new Error('AUTH_SECRET must contain at least 32 characters.');
  const origins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of origins) {
    if (new URL(origin).origin !== origin || !/^https?:/.test(origin))
      throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins.');
  }
  const issuers = parseIssuers(required(env, 'VALID_ISSUERS'));
  return {
    databaseUrl: database.toString(),
    busApi: readBusConfig(env),
    port: integerSetting(env.PORT ?? '3000', 1, 65535),
    origins,
    authSecret,
    issuers,
    claimNamespace: env.AUTH_CLAIM_NAMESPACE ?? 'https://topcoder.com/',
    throttleLimit: integerSetting(env.THROTTLE_LIMIT ?? '30', 1, 10000),
    trustProxy: (env.TRUST_PROXY_CIDRS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Reads a required nonempty environment variable for readConfig.
 * @param env Environment map. @param key Variable name.
 * @returns Trimmed value. @throws Error when missing or empty.
 */
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

/**
 * Validates a bounded integer configuration setting.
 * @param raw Decimal text. @param min Inclusive minimum. @param max Inclusive maximum.
 * @returns Parsed integer. @throws Error for invalid or out-of-range values.
 */
function integerSetting(raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Expected an integer between ${min} and ${max}.`);
  return value;
}

export const CONFIG = Symbol('forms.config');

/**
 * Reads optional outbound Bus API settings without requiring them for ordinary forms.
 * @param env Environment map used by readConfig.
 * @returns Wrapper configuration when BUSAPI_URL is set, otherwise undefined.
 * @throws Error for partial credentials, invalid URLs, or invalid cache duration.
 */
function readBusConfig(
  env: NodeJS.ProcessEnv,
): BusApiConfiguration | undefined {
  if (!env.BUSAPI_URL?.trim()) return undefined;
  const url = new URL(env.BUSAPI_URL.trim());
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.pathname.endsWith('/v6') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('BUSAPI_URL must be an HTTP(S) API base ending in /v6.');
  return {
    BUSAPI_URL: url.toString().replace(/\/$/, ''),
    AUTH0_URL: required(env, 'AUTH0_URL'),
    AUTH0_AUDIENCE: required(env, 'AUTH0_AUDIENCE'),
    AUTH0_CLIENT_ID: required(env, 'AUTH0_CLIENT_ID'),
    AUTH0_CLIENT_SECRET: required(env, 'AUTH0_CLIENT_SECRET'),
    KAFKA_ERROR_TOPIC:
      env.KAFKA_ERROR_TOPIC?.trim() || 'common.error.reporting',
    ...(env.TOKEN_CACHE_TIME
      ? { TOKEN_CACHE_TIME: integerSetting(env.TOKEN_CACHE_TIME, 0, 86400000) }
      : {}),
    ...(env.AUTH0_PROXY_SERVER_URL?.trim()
      ? { AUTH0_PROXY_SERVER_URL: env.AUTH0_PROXY_SERVER_URL.trim() }
      : {}),
  };
}

/**
 * Accepts the shared Topcoder JSON issuer list or the existing comma-separated form.
 * @param raw Configured exact trusted issuer URLs.
 * @returns Nonempty issuer allowlist. @throws Error for malformed or empty lists.
 */
function parseIssuers(raw: string): string[] {
  const values: unknown = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw.split(',');
  if (
    !Array.isArray(values) ||
    !values.length ||
    !values.every((value) => typeof value === 'string' && value.trim())
  )
    throw new Error('VALID_ISSUERS must contain nonempty issuer strings.');
  return values.map((value: string) => value.trim());
}
