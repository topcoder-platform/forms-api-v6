import 'dotenv/config';

/** Runtime configuration validated once before Nest starts serving requests. */
export interface AppConfig {
  databaseUrl: string;
  port: number;
  origins: string[];
  authMode: 'hs256' | 'jwks';
  authSecret?: string;
  jwksUrl?: string;
  issuers: string[];
  audience: string;
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
    throw new Error(
      'DATABASE_URL must be PostgreSQL using the forms schema.',
    );
  }
  database.searchParams.set('schema', 'forms');
  const authMode = env.AUTH_MODE ?? 'jwks';
  if (authMode !== 'hs256' && authMode !== 'jwks')
    throw new Error('AUTH_MODE must be jwks or hs256.');
  if (authMode === 'hs256' && required(env, 'AUTH_SECRET').length < 32) {
    throw new Error('AUTH_SECRET must contain at least 32 characters.');
  }
  if (
    authMode === 'jwks' &&
    new URL(required(env, 'JWKS_URL')).protocol !== 'https:'
  ) {
    throw new Error('JWKS_URL must use HTTPS.');
  }
  const origins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of origins) {
    if (new URL(origin).origin !== origin || !/^https?:/.test(origin))
      throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins.');
  }
  const issuers = required(env, 'VALID_ISSUERS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!issuers.length)
    throw new Error('VALID_ISSUERS must contain at least one issuer.');
  return {
    databaseUrl: database.toString(),
    port: integerSetting(env.PORT ?? '3000', 1, 65535),
    origins,
    authMode,
    authSecret: env.AUTH_SECRET,
    jwksUrl: env.JWKS_URL,
    issuers,
    audience: required(env, 'AUTH_AUDIENCE'),
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
