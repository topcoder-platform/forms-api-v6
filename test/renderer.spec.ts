// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TopcoderForm,
  collectAnswers,
} from '../integrations/react/TopcoderForm';
import type { PublicForm } from '../integrations/contracts';

const schema: PublicForm = {
  key: 'signup',
  version: 3,
  title: 'Sign up',
  access: 'ANONYMOUS',
  successMessage: 'Submission received.',
  fields: [
    { key: 'email', type: 'EMAIL', label: 'Email', required: true },
    { key: 'updates', type: 'BOOLEAN', label: 'Updates', required: true },
    { key: 'budget', type: 'DECIMAL', label: 'Budget' },
    { key: 'count', type: 'INTEGER', label: 'Count' },
    {
      key: 'interests',
      type: 'MULTI_SELECT',
      label: 'Interests',
      options: [
        { key: 'design', label: 'Design' },
        { key: 'dev', label: 'Development' },
      ],
    },
  ],
};

describe('embedded React form', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('preserves decimal text, explicit false, zero, and multiple selections', () => {
    const data = new FormData();
    data.set('email', 'member@example.com');
    data.set('updates', 'false');
    data.set('budget', '99999999999999.123456');
    data.set('count', '0');
    data.append('interests', 'design');
    data.append('interests', 'dev');
    expect(collectAnswers(schema.fields, data)).toEqual({
      email: 'member@example.com',
      updates: false,
      budget: '99999999999999.123456',
      count: 0,
      interests: ['design', 'dev'],
    });
  });

  it('keeps entered values and reuses the same retry key after a lost response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(schema))
      .mockRejectedValueOnce(new TypeError('Network error'))
      .mockResolvedValueOnce(
        Response.json({ id: 'receipt-1' }, { status: 201 }),
      );
    vi.stubGlobal('fetch', fetcher);
    await act(async () =>
      root.render(
        createElement(TopcoderForm, {
          formKey: 'signup',
          apiBaseUrl: 'https://forms.example/v6',
        }),
      ),
    );
    const email = container.querySelector<HTMLInputElement>('[name="email"]')!;
    email.value = 'member@example.com';
    container.querySelector<HTMLSelectElement>('[name="updates"]')!.value =
      'false';
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'could not confirm',
    );
    expect(email.value).toBe('member@example.com');
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(container.textContent).toContain('Submission received.');
    const first = fetcher.mock.calls[1][1] as RequestInit;
    const retry = fetcher.mock.calls[2][1] as RequestInit;
    expect(retry.body).toBe(first.body);
    expect(retry.headers).toEqual(first.headers);
    expect(JSON.parse(String(first.body))).toMatchObject({
      version: 3,
      answers: { updates: false },
      website: '',
    });
  });

  it('requires a member token before submission', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...schema, access: 'MEMBER' }));
    vi.stubGlobal('fetch', fetcher);
    await act(async () =>
      root.render(
        createElement(TopcoderForm, {
          formKey: 'signup',
          apiBaseUrl: 'https://forms.example/v6',
        }),
      ),
    );
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'sign in',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('renders API field errors beside retained controls and forwards the visitor token', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...schema, access: 'MEMBER' }))
      .mockResolvedValueOnce(
        Response.json(
          {
            message: 'Form validation failed.',
            errors: { email: 'Use a valid email address.' },
          },
          { status: 400 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    await act(async () =>
      root.render(
        createElement(TopcoderForm, {
          formKey: 'signup',
          apiBaseUrl: 'https://forms.example/v6',
          getAccessToken: async () => 'visitor-token',
        }),
      ),
    );
    const email = container.querySelector<HTMLInputElement>('[name="email"]')!;
    email.value = 'entered-value';
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(email.value).toBe('entered-value');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Use a valid email address.');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe(
      'Bearer visitor-token',
    );
  });

  it('does not render controls for an unavailable or malformed schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json({
          ...schema,
          fields: [{ key: 'unknown', label: 'Bad', type: 'SCRIPT' }],
        }),
      ),
    );
    await act(async () =>
      root.render(
        createElement(TopcoderForm, {
          formKey: 'signup',
          apiBaseUrl: 'https://forms.example/v6',
        }),
      ),
    );
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('unavailable');
  });

  it('cannot complete a newly selected form with a previous form receipt', async () => {
    let resolveSubmission!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSubmission = resolve;
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(schema))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(
        Response.json({ ...schema, key: 'another', title: 'Another form' }),
      );
    vi.stubGlobal('fetch', fetcher);
    await act(async () =>
      root.render(
        createElement(TopcoderForm, {
          formKey: 'signup',
          apiBaseUrl: 'https://forms.example/v6',
        }),
      ),
    );
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    await act(async () =>
      root.render(
        createElement(TopcoderForm, {
          formKey: 'another',
          apiBaseUrl: 'https://forms.example/v6',
        }),
      ),
    );
    await act(async () => {
      resolveSubmission(Response.json({ id: 'old-receipt' }, { status: 201 }));
    });
    expect(container.querySelector('form')?.getAttribute('aria-label')).toBe(
      'Another form',
    );
    expect(container.textContent).not.toContain('Submission received.');
  });
});
