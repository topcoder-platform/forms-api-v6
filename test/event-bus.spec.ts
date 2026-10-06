import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config';
import { EventBusService } from '../src/integrations/event-bus.service';
import { testSecret } from './fixtures';

const { postEvent, createClient } = vi.hoisted(() => {
  const postEvent = vi.fn();
  return { postEvent, createClient: vi.fn(() => ({ postEvent })) };
});
vi.mock('tc-bus-api-wrapper', () => ({ default: createClient }));

const baseEnv = {
  DATABASE_URL: 'postgresql://localhost/forms',
  AUTH_SECRET: testSecret,
  VALID_ISSUERS: 'https://forms.test',
};
const busEnv = {
  BUSAPI_URL: 'https://api.topcoder-dev.com/v6/',
  AUTH0_URL: 'https://auth.test',
  AUTH0_AUDIENCE: 'https://api.test',
  AUTH0_CLIENT_ID: 'client',
  AUTH0_CLIENT_SECRET: 'secret',
};
const payload = {
  submissionId: 'c1ab5d27-722a-431f-a811-46737109de1f',
  formKey: 'event_interest',
  version: 1,
  submittedAt: '2026-09-28T01:00:00.000Z',
  memberId: null,
  sourcePage: null,
  answers: { updates: false, age: 0, email: 'member@example.com' },
};

describe('outbound Bus API integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postEvent.mockReset().mockResolvedValue(undefined);
  });

  it('configures the shared wrapper and sends the standard event envelope', async () => {
    const config = readConfig({
      ...baseEnv,
      ...busEnv,
      TOKEN_CACHE_TIME: '60000',
      AUTH0_PROXY_SERVER_URL: 'https://proxy.test',
    });
    const bus = new EventBusService(config);
    expect(createClient).toHaveBeenCalledWith({
      ...busEnv,
      BUSAPI_URL: 'https://api.topcoder-dev.com/v6',
      TOKEN_CACHE_TIME: 60000,
      AUTH0_PROXY_SERVER_URL: 'https://proxy.test',
      KAFKA_ERROR_TOPIC: 'common.error.reporting',
    });
    await bus.publishSubmission(payload);
    expect(postEvent).toHaveBeenCalledExactlyOnceWith({
      topic: 'form.submitted',
      originator: 'forms-api-v6',
      timestamp: payload.submittedAt,
      'mime-type': 'application/json',
      key: payload.submissionId,
      payload,
    });
  });

  it('allows ordinary forms without outbound credentials and explicitly fails requested delivery', async () => {
    const config = readConfig(baseEnv);
    expect(config.busApi).toBeUndefined();
    const bus = new EventBusService(config);
    expect(createClient).not.toHaveBeenCalled();
    await expect(bus.publishSubmission(payload)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('does not expose provider errors to callers', async () => {
    postEvent.mockRejectedValue(new Error('credentials and payload'));
    const bus = new EventBusService(readConfig({ ...baseEnv, ...busEnv }));
    await expect(bus.publishSubmission(payload)).rejects.toThrow(
      'Retry with the same Idempotency-Key and body',
    );
  });

  it.each([
    'https://api.test/v5',
    'https://api.test/v6/bus/events',
    'ftp://api.test/v6',
    'https://api.test/v6?x=1',
  ])('rejects invalid Bus API base %s', (BUSAPI_URL) => {
    expect(() => readConfig({ ...baseEnv, ...busEnv, BUSAPI_URL })).toThrow(
      'BUSAPI_URL',
    );
  });

  it.each([
    'AUTH0_URL',
    'AUTH0_AUDIENCE',
    'AUTH0_CLIENT_ID',
    'AUTH0_CLIENT_SECRET',
  ])('requires %s when bus is enabled', (key) => {
    expect(() => readConfig({ ...baseEnv, ...busEnv, [key]: '' })).toThrow(key);
  });
});
