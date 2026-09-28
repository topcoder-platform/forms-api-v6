import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AuthGuard, type ActorRequest, type Permission } from '../src/auth';
import { readConfig } from '../src/config';
import { testSecret } from './fixtures';

const config = readConfig({
  DATABASE_URL: 'postgresql://localhost/forms',
  AUTH_MODE: 'hs256',
  AUTH_SECRET: testSecret,
  VALID_ISSUERS:
    'https://api.topcoder-dev.com,https://api.topcoder.com,https://forms.test',
  AUTH_AUDIENCE: 'forms-api',
});

/**
 * Signs Identity API-shaped claims and runs the actual guard without a database.
 * @param overrides Claim overrides, including undefined to omit a claim.
 * @param permission Route access level. @param secret Signing key for negative tests.
 * @param algorithm Signing algorithm for allowlist tests.
 * @returns Verified actor. @throws Authentication/authorization errors from the guard.
 */
async function authenticate(
  overrides: Record<string, unknown> = {},
  permission: Permission = 'report',
  secret = testSecret,
  algorithm = 'HS256',
) {
  const { SignJWT } = await import('jose');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    userId: '12345',
    roles: ['Administrator'],
    iss: 'https://api.topcoder-dev.com',
    iat: now,
    exp: now + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: algorithm })
    .sign(new TextEncoder().encode(secret));
  const request = {
    headers: { authorization: `Bearer ${jwt}` },
  } as ActorRequest;
  const handler = () => undefined;
  Reflect.defineMetadata('forms.permission', permission, handler);
  const context = {
    getHandler: () => handler,
    getClass: () => AuthGuard,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  await new AuthGuard(config, new Reflector()).canActivate(context);
  return request.actor;
}

describe('Topcoder bearer authentication', () => {
  it.each(['https://api.topcoder-dev.com', 'https://api.topcoder.com'])(
    'accepts legacy administrator tokens issued by %s',
    async (iss) => {
      expect(await authenticate({ iss })).toEqual({
        subject: '12345',
        memberId: '12345',
        machine: false,
        roles: ['administrator'],
        scopes: [],
      });
    },
  );

  it('uses a numeric userId for legacy editor audit and member identity', async () => {
    expect(await authenticate({ userId: 12345 }, 'manage')).toMatchObject({
      subject: '12345',
      memberId: '12345',
    });
    expect(await authenticate({ roles: ['Member'] }, 'public')).toMatchObject({
      memberId: '12345',
      machine: false,
    });
  });

  it('still enforces human report permissions', async () => {
    await expect(authenticate({ roles: ['Member'] })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      authenticate({ roles: ['Forms Administrator'] }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await authenticate({ roles: ['Forms Reporter'] })).toBeDefined();
  });

  it.each([
    { exp: 1 },
    { exp: undefined },
    { iat: undefined },
    { iss: 'https://untrusted.example' },
    { iss: 'https://forms.test' },
    { userId: undefined },
    { userId: '' },
    { userId: {} },
    { userId: 1.5 },
    { userId: 0 },
    { userId: '1'.repeat(21) },
    { sub: '', aud: 'forms-api' },
    { sub: 42, aud: 'forms-api' },
    { sub: 'auth0|person' },
    { aud: 'forms-api' },
    { sub: 'auth0|person', aud: 'wrong-api' },
    { gty: 'client-credentials' },
    { isMachine: true },
    { scope: 'read:forms-submissions', roles: [] },
  ])('rejects invalid or nonlegacy claims %#', async (claims) => {
    await expect(authenticate(claims)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects invalid signatures even for the legacy profile', async () => {
    await expect(
      authenticate({}, 'report', `${testSecret}-wrong`),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects other signing algorithms even for the legacy profile', async () => {
    await expect(
      authenticate({}, 'report', testSecret, 'HS384'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each(['forms-api', ['another-api', 'forms-api']])(
    'accepts standard audience %j',
    async (aud) => {
      expect(await authenticate({ sub: 'auth0|person', aud })).toMatchObject({
        subject: 'auth0|person',
      });
    },
  );

  it('keeps machine scope authorization separate from administrator roles', async () => {
    const machine = {
      sub: 'client@clients',
      aud: 'forms-api',
      gty: 'client-credentials',
    };
    await expect(authenticate(machine)).rejects.toMatchObject({ status: 403 });
    expect(
      await authenticate({ ...machine, scope: 'read:forms-submissions' }),
    ).toMatchObject({
      machine: true,
      memberId: undefined,
    });
  });
});
