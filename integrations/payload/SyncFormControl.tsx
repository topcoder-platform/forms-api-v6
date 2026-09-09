import type { ServerProps } from 'payload' with { 'resolution-mode': 'import' };
import { SyncFormButton } from './SyncFormButton';

/**
 * Passes the saved document ID and configured REST prefix into the Payload admin sync control.
 * @param props Payload's server component document context.
 * @returns Client button, disabled until the form document is saved.
 * @throws No errors for Payload-provided server props.
 */
export function SyncFormControl({
  id,
  payload,
}: Pick<ServerProps, 'id' | 'payload'>) {
  return <SyncFormButton documentId={id} apiPath={payload.config.routes.api} />;
}
