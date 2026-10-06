import 'reflect-metadata';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../src/auth';
import { CONFIG, readConfig } from '../src/config';
import { FormsController } from '../src/forms/forms.controller';
import { FormsService } from '../src/forms/forms.service';
import { testSecret } from './fixtures';

const issuer = 'https://auth.topcoder-dev.com/';
const namespace = 'https://topcoder-dev.com/';
const kid = 'forms-auth-regression';
const directory = vi.fn().mockResolvedValue({ items: [] });
let app: INestApplication;
let privateKey: KeyObject;
let jwks: nock.Scope;

/**
 * Signs synthetic Auth0 claims matching the browser's token format without personal data.
 * @param overrides Negative-test claim overrides. @param key Signing key.
 * @returns Signed RS256 token. @throws JWT signing errors for invalid fixture input.
 */
function browserToken(
  overrides: Record<string, unknown> = {},
  key = privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    [`${namespace}roles`]: ['administrator', 'Topcoder User'],
    [`${namespace}userId`]: '12345',
    iss: issuer,
    aud: 'BXWXUWnilVUPdN01t2Se29Tw2ZYNGZvH',
    sub: 'auth0|12345',
    iat: now,
    exp: now + 300,
    ...overrides,
  };
  return jwt.sign(
    Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined),
    ),
    key,
    { algorithm: 'RS256', keyid: kid },
  );
}

beforeAll(async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = keys.privateKey;
  // Mock only the HTTPS key endpoint; the real shared middleware verifies every signature.
  jwks = nock('https://auth.topcoder-dev.com')
    .get('/.well-known/jwks.json')
    .once()
    .reply(200, {
      keys: [
        {
          ...keys.publicKey.export({ format: 'jwk' }),
          kid,
          alg: 'RS256',
          use: 'sig',
        },
      ],
    });
  const module = await Test.createTestingModule({
    controllers: [FormsController],
    providers: [
      { provide: FormsService, useValue: { reportDirectory: directory } },
      {
        provide: CONFIG,
        useValue: readConfig({
          DATABASE_URL: 'postgresql://localhost/forms',
          AUTH_SECRET: testSecret,
          VALID_ISSUERS: JSON.stringify([
            issuer,
            'https://api.topcoder-dev.com',
          ]),
          // Obsolete deployment settings must not keep rejecting Auth0 browser tokens.
          AUTH_MODE: 'hs256',
          AUTH_AUDIENCE: 'forms-api',
        }),
      },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  }).compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('v6');
  await app.init();
});

afterAll(async () => {
  await app?.close();
  nock.cleanAll();
});

describe('reports directory with the shared Topcoder authenticator', () => {
  it('accepts the browser RS256 administrator profile and caches its JWKS', async () => {
    for (let i = 0; i < 2; i++) {
      const result = await request(app.getHttpServer())
        .get('/v6/forms/reports/directory')
        .auth(browserToken(), { type: 'bearer' })
        .expect(200);
      expect(result.body).toEqual({ items: [] });
    }
    expect(jwks.isDone()).toBe(true);
    expect(directory).toHaveBeenCalledTimes(2);
  });

  it('still accepts legacy HS256 administrators on the same deployment', async () => {
    const token = jwt.sign(
      { userId: '12345', roles: ['Administrator'] },
      testSecret,
      {
        algorithm: 'HS256',
        issuer: 'https://api.topcoder-dev.com',
        expiresIn: '5m',
      },
    );
    await request(app.getHttpServer())
      .get('/v6/forms/reports/directory')
      .auth(token, { type: 'bearer' })
      .expect(200);
  });

  it.each([
    { exp: 1 },
    { iss: 'https://untrusted.example/' },
    { exp: undefined },
    { sub: '' },
  ])('rejects invalid browser claims %# with 401', async (overrides) => {
    await request(app.getHttpServer())
      .get('/v6/forms/reports/directory')
      .auth(browserToken(overrides), { type: 'bearer' })
      .expect(401);
  });

  it('rejects a forged RSA signature', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await request(app.getHttpServer())
      .get('/v6/forms/reports/directory')
      .auth(browserToken({}, other.privateKey), { type: 'bearer' })
      .expect(401);
  });

  it('returns 403 for a verified browser member without report permissions', async () => {
    await request(app.getHttpServer())
      .get('/v6/forms/reports/directory')
      .auth(browserToken({ [`${namespace}roles`]: ['Topcoder User'] }), {
        type: 'bearer',
      })
      .expect(403);
  });

  it('authorizes an RS256 machine by scopes rather than administrator roles', async () => {
    const machine = {
      sub: 'client@clients',
      gty: 'client-credentials',
      azp: 'client',
      [`${namespace}userId`]: undefined,
      [`${namespace}roles`]: undefined,
    };
    await request(app.getHttpServer())
      .get('/v6/forms/reports/directory')
      .auth(browserToken({ ...machine, scope: 'read:forms-submissions' }), {
        type: 'bearer',
      })
      .expect(200);
    await request(app.getHttpServer())
      .get('/v6/forms/reports/directory')
      .auth(browserToken({ ...machine, scope: 'manage:forms' }), {
        type: 'bearer',
      })
      .expect(403);
  });
});
