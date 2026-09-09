import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { normalizeActor } from '../src/auth';
import { readConfig } from '../src/config';
import { DefinitionDto } from '../src/forms/dto';
import { csvCell, reportViewName } from '../src/forms/reporting';
import { validateDefinition } from '../src/forms/validation';
import { definition, testSecret } from './fixtures';

describe('definition and deployment policies', () => {
  it.each([
    {
      ...definition(),
      fields: [definition().fields[0], definition().fields[0]],
    },
    {
      ...definition(),
      fields: [{ key: 'submission_id', label: 'Reserved', type: 'TEXT' }],
    },
    {
      ...definition(),
      fields: [{ key: 'bad', label: 'Bad', type: 'TEXT', minValue: '1' }],
    },
    {
      ...definition(),
      fields: [{ key: 'bad', label: 'Bad', type: 'INTEGER', maxLength: 10 }],
    },
    {
      ...definition(),
      fields: [{ key: 'bad', label: 'Bad', type: 'SINGLE_SELECT' }],
    },
    {
      ...definition(),
      fields: [
        {
          key: 'bad',
          label: 'Bad',
          type: 'TEXT',
          options: [{ key: 'one', label: 'One' }],
        },
      ],
    },
    {
      ...definition(),
      fields: [{ key: 'bad', label: 'Bad', type: 'INTEGER', minValue: '1.2' }],
    },
    {
      ...definition(),
      fields: [
        {
          key: 'bad',
          label: 'Bad',
          type: 'DECIMAL',
          minValue: '10',
          maxValue: '1',
        },
      ],
    },
    { ...definition(), fields: [{ key: 'bad', label: '   ', type: 'TEXT' }] },
  ])('rejects inconsistent definitions %#', (input) => {
    expect(() =>
      validateDefinition(plainToInstance(DefinitionDto, input)),
    ).toThrow();
  });

  it('validates nested fields, disallows unrecognized metadata, and requires a nonempty field array', async () => {
    for (const input of [
      { ...definition(), fields: [null] },
      { ...definition(), fields: [] },
      { ...definition(), unexpected: 'value' },
      {
        ...definition(),
        fields: [{ key: 'unsafe;DROP TABLE', label: 'Bad', type: 'TEXT' }],
      },
    ]) {
      expect(
        await validate(plainToInstance(DefinitionDto, input), {
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
        }),
      ).not.toHaveLength(0);
    }
  });

  it('rejects unsafe SQL view identifiers and keeps names below PostgreSQL limits', () => {
    for (const key of [
      'x";DROP TABLE "Form"',
      'a-b',
      'A',
      '_private',
      'a'.repeat(41),
    ])
      expect(() => reportViewName(key, 1)).toThrow();
    for (const version of [0, -1, 1.5, 1000001, NaN])
      expect(() => reportViewName('safe', version)).toThrow();
    expect(reportViewName('a'.repeat(40), 1000000)).toContain(
      `${'a'.repeat(40)}_v1000000`,
    );
  });

  it.each([
    '=SUM(1,2)',
    '+cmd',
    '-1+1',
    '@SUM(A1)',
    '\t=HYPERLINK("bad")',
    '  =1',
  ])('neutralizes CSV formula %s', (input) => {
    expect(csvCell(input).startsWith('"\'')).toBe(true);
  });

  it('uses the explicit namespace and separates machines from member identities', () => {
    const actor = normalizeActor(
      {
        sub: 'auth0|person',
        'https://topcoder.com/userId': 42,
        'https://topcoder.com/roles': ['Member'],
        'https://untrusted.example/roles': ['Administrator'],
      },
      'https://topcoder.com/',
    );
    expect(actor).toMatchObject({
      memberId: '42',
      machine: false,
      roles: ['member'],
    });
    expect(
      normalizeActor(
        {
          sub: 'client@clients',
          userId: 'forged',
          roles: ['Administrator'],
          gty: 'client-credentials',
        },
        'https://topcoder.com/',
      ),
    ).toMatchObject({ memberId: undefined, machine: true });
  });

  it('requires signed-token settings and exact CORS origins, defaulting to untrusted proxy headers', () => {
    const env = {
      DATABASE_URL: 'postgresql://localhost/forms',
      AUTH_MODE: 'hs256',
      AUTH_SECRET: testSecret,
      VALID_ISSUERS: 'https://forms.test',
      AUTH_AUDIENCE: 'forms-api',
    };
    expect(readConfig(env).trustProxy).toEqual([]);
    expect(new URL(readConfig(env).databaseUrl).searchParams.get('schema')).toBe(
      'forms',
    );
    expect(() =>
      readConfig({
        ...env,
        DATABASE_URL: 'postgresql://localhost/topcoder-services?schema=public',
      }),
    ).toThrow();
    expect(() => readConfig({ ...env, AUTH_SECRET: '' })).toThrow();
    expect(() => readConfig({ ...env, AUTH_AUDIENCE: '' })).toThrow();
    expect(() => readConfig({ ...env, CORS_ORIGINS: '*' })).toThrow();
    expect(() =>
      readConfig({
        ...env,
        DATABASE_URL: 'postgresql://localhost/forms?schema=another',
      }),
    ).toThrow();
    expect(() =>
      readConfig({
        ...env,
        AUTH_MODE: 'jwks',
        JWKS_URL: 'http://issuer.example/jwks',
      }),
    ).toThrow();
  });
});
