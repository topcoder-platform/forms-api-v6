'use client';

import { useState } from 'react';

/**
 * Lets CMS editors synchronize the last saved definition using their existing Payload session.
 * @param props Saved document ID and host CMS REST API path.
 * @returns A sync button and operation status; no service credentials cross into the browser.
 * @throws No errors to the UI; failed requests remain visible and can be retried.
 */
export function SyncFormButton({
  documentId,
  apiPath,
}: {
  documentId?: string | number;
  apiPath: string;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  /**
   * Sends an authorized sync request for the saved form.
   * @returns Completion after updating status. @throws No errors; failures become status text.
   */
  async function synchronize(): Promise<void> {
    if (documentId == null || pending) return;
    setPending(true);
    setMessage('');
    try {
      const response = await fetch(
        `${apiPath.replace(/\/$/, '')}/form-definitions/${encodeURIComponent(documentId)}/sync`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(60000),
        },
      );
      const result: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          result && typeof result === 'object' && 'message' in result
            ? String(result.message)
            : 'Synchronization failed.',
        );
      const status =
        result && typeof result === 'object' && 'status' in result
          ? String(result.status)
          : 'saved';
      setMessage(`Saved form synchronized. API status: ${status}.`);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Synchronization failed. Retry the saved form.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={documentId == null || pending}
        onClick={synchronize}
      >
        {pending ? 'Synchronizing…' : 'Sync saved form'}
      </button>
      <p role="status">
        {message || 'Save your changes before synchronizing.'}
      </p>
    </div>
  );
}
