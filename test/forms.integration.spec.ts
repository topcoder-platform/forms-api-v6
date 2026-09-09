import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/bootstrap';
import { DbService } from '../src/db.service';
import {
  answers,
  definition,
  formKey,
  testConfig,
  testSecret,
  token,
} from './fixtures';
import { syncForm, type ManagedForm } from '../integrations/payload/forms';

describe('forms API with real PostgreSQL', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let db: DbService;
  let admin: string;
  let reporter: string;
  let member: string;
  let machine: string;

  beforeAll(async () => {
    app = await createApp(testConfig());
    await app.listen(0, '127.0.0.1');
    db = app.get(DbService);
    admin = await token({ roles: ['Administrator'] });
    reporter = await token({ roles: ['Forms Reporter'] });
    member = await token({
      'https://topcoder.com/roles': ['Member'],
      'https://topcoder.com/userId': '12345',
    });
    machine = await token({
      gty: 'client-credentials',
      scope: 'manage:forms read:forms-submissions',
    });
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  /**
   * Registers and optionally publishes a unique fixture through authenticated HTTP endpoints.
   * @param input Complete definition. @param publish Whether to publish.
   * @returns Unique form key. @throws Supertest assertion errors on unexpected HTTP responses.
   */
  async function create(input = definition(), publish = true) {
    const key = formKey();
    await request(app.getHttpServer())
      .post('/v6/forms')
      .auth(admin, { type: 'bearer' })
      .send({ key })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/v6/forms/${key}/versions/1`)
      .auth(admin, { type: 'bearer' })
      .send(input)
      .expect(200);
    if (publish)
      await request(app.getHttpServer())
        .post(`/v6/forms/${key}/versions/1/publish`)
        .auth(admin, { type: 'bearer' })
        .expect(200);
    return key;
  }

  it('serves health, readiness, OpenAPI, and exact-origin CORS', async () => {
    await request(app.getHttpServer()).get('/v6/health').expect(200);
    await request(app.getHttpServer()).get('/v6/health/ready').expect(200);
    await request(app.getHttpServer()).get('/v6/docs-json').expect(200);
    await request(app.getHttpServer()).get('/v6/forms/health/ready').expect(200);
    const docs = await request(app.getHttpServer())
      .get('/v6/forms/api-docs')
      .expect(200);
    expect(docs.text).toContain('swagger-ui');
    await request(app.getHttpServer())
      .get('/v6/forms/api-docs/swagger-ui-init.js')
      .expect(200);
    const spec = await request(app.getHttpServer())
      .get('/v6/forms/api-docs-json')
      .expect(200);
    expect(spec.body.paths['/v6/forms/{key}/submissions']).toBeDefined();
    const allowed = await request(app.getHttpServer())
      .options('/v6/forms/a/submissions')
      .set('Origin', 'https://www.topcoder.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://www.topcoder.com',
    );
    const denied = await request(app.getHttpServer())
      .get('/v6/health')
      .set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('persists all typed values and exposes named SQL columns and private JSON/CSV reports', async () => {
    const key = await create();
    const schema = await request(app.getHttpServer())
      .get(`/v6/forms/${key}`)
      .expect(200);
    expect(schema.body).not.toHaveProperty('createdBy');
    expect(schema.body.fields[0]).not.toHaveProperty('id');
    const receipt = await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, answers: answers(), sourcePage: '/events/design' })
      .expect(201);
    expect(receipt.body).not.toHaveProperty('answers');
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "forms_reporting"."${key}_v1"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: 'member@example.com',
      age: 0,
      updates: false,
      interests: ['design', 'dev'],
      track: 'design',
    });
    expect(String(rows[0].budget)).toBe('99999999999999.123456');
    const report = await request(app.getHttpServer())
      .get(`/v6/forms/${key}/versions/1/submissions`)
      .auth(reporter, { type: 'bearer' })
      .expect(200);
    expect(report.body.data[0]).toMatchObject({
      budget: '99999999999999.123456',
      event_date: '2028-02-29',
      updates: false,
    });
    const csv = await request(app.getHttpServer())
      .get(`/v6/forms/${key}/versions/1/submissions.csv`)
      .auth(reporter, { type: 'bearer' })
      .expect(200);
    expect(csv.text).toContain('"email"');
    expect(csv.text).toContain('"Line one\nLine two"');
    expect(
      await db.answerSelection.count({
        where: { answer: { submissionId: receipt.body.id } },
      }),
    ).toBe(2);
    const jsonColumns = await db.$queryRaw<
      unknown[]
    >`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')`;
    expect(jsonColumns).toEqual([]);
  });

  it('handles concurrent identical retries once and rejects key reuse with changed answers', async () => {
    const key = await create();
    const retryKey = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post(`/v6/forms/${key}/submissions`)
          .set('Idempotency-Key', retryKey)
          .send({ version: 1, answers: answers() })
          .expect(201),
      ),
    );
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(
      await db.submission.count({ where: { version: { form: { key } } } }),
    ).toBe(1);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', retryKey)
      .send({ version: 1, answers: { ...answers(), age: 1 } })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/versions/1/retire`)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    const replay = await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', retryKey)
      .send({ version: 1, answers: answers() })
      .expect(201);
    expect(replay.body.id).toBe(responses[0].body.id);
  });

  it('rejects malformed, unknown, invalid, and missing fields atomically', async () => {
    const key = await create();
    const invalid = [
      { ...answers(), email: 'bad' },
      { ...answers(), extra: 'injected' },
      { email: 'member@example.com' },
      { ...answers(), age: '2' },
      { ...answers(), age: 121 },
      { ...answers(), updates: 'false' },
      { ...answers(), budget: 2.4 },
      { ...answers(), budget: '1.1234567' },
      { ...answers(), event_date: '2026-02-30' },
      { ...answers(), track: 'unknown' },
      { ...answers(), interests: ['dev', 'dev'] },
      { ...answers(), interests: ['unknown'] },
      { ...answers(), notes: 'null\0byte' },
    ];
    for (const data of invalid)
      await request(app.getHttpServer())
        .post(`/v6/forms/${key}/submissions`)
        .set('Idempotency-Key', randomUUID())
        .send({ version: 1, answers: data })
        .expect(400);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .send({ version: 1, answers: answers() })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, answers: answers(), memberId: 'spoofed' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, answers: answers(), website: 'bot' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, answers: answers(), sourcePage: '/bad\0path' })
      .expect(400);
    expect(
      await db.submission.count({ where: { version: { form: { key } } } }),
    ).toBe(0);
  });

  it('protects administration/reports, validates tokens, and derives member IDs from verified claims', async () => {
    const key = await create({ ...definition(), access: 'MEMBER' });
    await request(app.getHttpServer())
      .post('/v6/forms')
      .send({ key: formKey() })
      .expect(401);
    await request(app.getHttpServer())
      .post('/v6/forms')
      .auth(member, { type: 'bearer' })
      .send({ key: formKey() })
      .expect(403);
    await request(app.getHttpServer())
      .post('/v6/forms')
      .auth(machine, { type: 'bearer' })
      .send({ key: formKey() })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/v6/forms/${key}`)
      .auth('invalid', { type: 'bearer' })
      .expect(401);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, answers: answers() })
      .expect(401);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .auth(machine, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, answers: answers() })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .auth(member, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, answers: answers() })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/v6/forms/${key}/versions/1/submissions`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/v6/forms/${key}/versions/1/submissions`)
      .auth(member, { type: 'bearer' })
      .expect(403);
    const report = await request(app.getHttpServer())
      .get(`/v6/forms/${key}/versions/1/submissions`)
      .auth(machine, { type: 'bearer' })
      .expect(200);
    expect(report.body.data[0].member_id).toBe('12345');
  });

  it('publishes immutable versions, rejects stale pages, and retains historical reports', async () => {
    const key = await create(definition(), false);
    await request(app.getHttpServer()).get(`/v6/forms/${key}`).expect(404);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, answers: answers() })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/versions/1/publish`)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/versions/1/publish`)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/v6/forms/${key}/versions/1`)
      .auth(admin, { type: 'bearer' })
      .send(definition())
      .expect(200);
    await request(app.getHttpServer())
      .put(`/v6/forms/${key}/versions/1`)
      .auth(admin, { type: 'bearer' })
      .send({ ...definition(), title: 'Changed' })
      .expect(409);
    await request(app.getHttpServer())
      .put(`/v6/forms/${key}/versions/2`)
      .auth(admin, { type: 'bearer' })
      .send({ ...definition(), title: 'New revision' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/versions/2/publish`)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    const current = await request(app.getHttpServer())
      .get(`/v6/forms/${key}`)
      .expect(200);
    expect(current.body.version).toBe(2);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, answers: answers() })
      .expect(409);
    await request(app.getHttpServer())
      .get(`/v6/forms/${key}/versions/1/submissions`)
      .auth(reporter, { type: 'bearer' })
      .expect(200);
    await expect(
      db.formField.updateMany({
        where: { version: { form: { key }, version: 1 } },
        data: { label: 'Mutated' },
      }),
    ).rejects.toThrow();
    await expect(
      db.formVersion.updateMany({
        where: { form: { key }, version: 1 },
        data: { title: 'Mutated' },
      }),
    ).rejects.toThrow();
  });

  it('enforces bounded pagination and rejects cursors from another form', async () => {
    const key = await create();
    for (let i = 0; i < 3; i++)
      await request(app.getHttpServer())
        .post(`/v6/forms/${key}/submissions`)
        .set('Idempotency-Key', randomUUID())
        .send({ version: 1, answers: answers() })
        .expect(201);
    const first = await request(app.getHttpServer())
      .get(`/v6/forms/${key}/versions/1/submissions?limit=2`)
      .auth(reporter, { type: 'bearer' })
      .expect(200);
    const next = await request(app.getHttpServer())
      .get(
        `/v6/forms/${key}/versions/1/submissions?limit=2&after=${first.body.nextCursor}`,
      )
      .auth(reporter, { type: 'bearer' })
      .expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(next.body.data).toHaveLength(1);
    expect(next.body.nextCursor).toBeNull();
    await request(app.getHttpServer())
      .get(`/v6/forms/${key}/versions/1/submissions?limit=1001`)
      .auth(reporter, { type: 'bearer' })
      .expect(400);
    await request(app.getHttpServer())
      .get(`/v6/forms/${key}/versions/1/submissions?after=${randomUUID()}`)
      .auth(reporter, { type: 'bearer' })
      .expect(400);
  });

  it('enforces required answers and cross-version field ownership below the API', async () => {
    const key = await create();
    const version = await db.formVersion.findFirstOrThrow({
      where: { form: { key } },
      include: { fields: true },
    });
    await expect(
      db.submission.create({
        data: {
          versionId: version.id,
          idempotencyKey: randomUUID(),
          requestHash: 'a'.repeat(64),
        },
      }),
    ).rejects.toThrow();
    const otherKey = await create();
    const otherField = await db.formField.findFirstOrThrow({
      where: { version: { form: { key: otherKey } }, type: 'EMAIL' },
    });
    await expect(
      db.$transaction(async (tx) => {
        const submission = await tx.submission.create({
          data: {
            versionId: version.id,
            idempotencyKey: randomUUID(),
            requestHash: 'b'.repeat(64),
          },
        });
        await tx.answer.create({
          data: {
            submissionId: submission.id,
            versionId: version.id,
            fieldId: otherField.id,
            type: 'EMAIL',
            textValue: 'member@example.com',
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(
      await db.submission.count({ where: { versionId: version.id } }),
    ).toBe(0);
  });

  it('synchronizes a saved Payload definition, retries it, and accepts the resulting public form', async () => {
    const key = formKey();
    const doc = {
      ...definition(),
      formKey: key,
      version: 1,
      apiStatus: 'PUBLISHED',
      id: 123,
      fields: definition().fields.map((field) => ({
        ...field,
        id: 'payload-array-row',
      })),
    } as ManagedForm;
    const options = {
      apiBaseUrl: `${await app.getUrl()}/v6`,
      getAccessToken: async () => machine,
    };
    await syncForm(doc, options);
    await syncForm(doc, options);
    const schema = await request(app.getHttpServer())
      .get(`/v6/forms/${key}`)
      .expect(200);
    expect(schema.body.title).toBe(doc.title);
    await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', randomUUID())
      .send({ version: schema.body.version, answers: answers() })
      .expect(201);
    await expect(
      syncForm({ ...doc, title: 'Changed without a new version' }, options),
    ).rejects.toThrow(/409/);
    await expect(
      syncForm({ ...doc, apiStatus: 'DRAFT' }, options),
    ).rejects.toThrow(/already published/);
    await syncForm(
      { ...doc, version: 2, title: 'Updated in Payload' },
      options,
    );
    expect(
      (await request(app.getHttpServer()).get(`/v6/forms/${key}`).expect(200))
        .body.version,
    ).toBe(2);
  });

  it('enforces scalar types, choice ownership, and nonempty selections directly in PostgreSQL', async () => {
    const key = await create();
    const receipt = await request(app.getHttpServer())
      .post(`/v6/forms/${key}/submissions`)
      .set('Idempotency-Key', randomUUID())
      .send({
        version: 1,
        answers: { email: 'member@example.com', updates: false },
      })
      .expect(201);
    const version = await db.formVersion.findFirstOrThrow({
      where: { form: { key } },
      include: { fields: { include: { options: true } } },
    });
    const common = {
      submissionId: receipt.body.id as string,
      versionId: version.id,
    };
    const name = version.fields.find((f) => f.key === 'name')!;
    const date = version.fields.find((f) => f.key === 'event_date')!;
    const track = version.fields.find((f) => f.key === 'track')!;
    const interests = version.fields.find((f) => f.key === 'interests')!;
    await expect(
      db.answer.create({
        data: { ...common, fieldId: name.id, type: 'TEXT', integerValue: 7 },
      }),
    ).rejects.toThrow(/Answer_typed_value/);
    await expect(
      db.answer.create({
        data: { ...common, fieldId: name.id, type: 'INTEGER', integerValue: 7 },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      db.answer.create({
        data: {
          ...common,
          fieldId: date.id,
          type: 'DATE',
          textValue: 'invalid',
        },
      }),
    ).rejects.toThrow(/Answer_date_not_null/);
    await expect(
      db.answer.create({
        data: {
          ...common,
          fieldId: track.id,
          type: 'SINGLE_SELECT',
          optionId: interests.options[0].id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      db.answer.create({
        data: { ...common, fieldId: interests.id, type: 'MULTI_SELECT' },
      }),
    ).rejects.toThrow(/Answer violates field rules/);
    expect(
      await db.answer.count({ where: { submissionId: common.submissionId } }),
    ).toBe(2);
  });

  it('rejects expired tokens, wrong issuer/audience, and unsupported signing algorithms', async () => {
    const { SignJWT } = await import('jose');
    const claims = { roles: ['Administrator'] };
    for (const settings of [
      {
        issuer: 'https://wrong.test',
        audience: 'forms-api',
        expiration: '5m',
        algorithm: 'HS256',
      },
      {
        issuer: 'https://forms.test',
        audience: 'wrong-api',
        expiration: '5m',
        algorithm: 'HS256',
      },
      {
        issuer: 'https://forms.test',
        audience: 'forms-api',
        expiration: '-1m',
        algorithm: 'HS256',
      },
      {
        issuer: 'https://forms.test',
        audience: 'forms-api',
        expiration: '5m',
        algorithm: 'HS384',
      },
    ]) {
      const bad = await new SignJWT(claims)
        .setProtectedHeader({ alg: settings.algorithm })
        .setSubject('test-user')
        .setIssuer(settings.issuer)
        .setAudience(settings.audience)
        .setIssuedAt()
        .setExpirationTime(settings.expiration)
        .sign(new TextEncoder().encode(testSecret));
      await request(app.getHttpServer())
        .get('/v6/forms')
        .auth(bad, { type: 'bearer' })
        .expect(401);
    }
  });

  it('throttles anonymous requests and ignores spoofed forwarded addresses by default', async () => {
    const limited = await createApp({ ...testConfig(), throttleLimit: 2 });
    try {
      await request(limited.getHttpServer())
        .get('/v6/forms/missing')
        .expect(404);
      await request(limited.getHttpServer())
        .get('/v6/forms/missing')
        .expect(404);
      await request(limited.getHttpServer())
        .get('/v6/forms/missing')
        .set('X-Forwarded-For', '192.0.2.1')
        .expect(429);
      await request(limited.getHttpServer()).get('/v6/health').expect(200);
    } finally {
      await limited.close();
    }
  });
});
