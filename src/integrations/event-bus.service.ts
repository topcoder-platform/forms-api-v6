import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import createBusApiClient, { type BusApiClient } from 'tc-bus-api-wrapper';
import { CONFIG, type AppConfig } from '../config';
import type { AnswerValue } from '../forms/validation';

/** Validated submission event contract consumed by downstream form processors. */
export interface FormSubmittedPayload {
  submissionId: string;
  formKey: string;
  version: number;
  submittedAt: string;
  memberId: string | null;
  sourcePage: string | null;
  answers: Record<string, AnswerValue>;
}

/** Publishes opted-in form submissions using the shared authenticated Topcoder Bus API wrapper. */
@Injectable()
export class EventBusService {
  private readonly client?: BusApiClient;

  /**
   * Initializes the shared wrapper when outbound Bus API settings are configured.
   * @param config Validated application settings injected by Nest.
   * @throws Error if the wrapper rejects supplied credentials or URLs.
   */
  constructor(@Inject(CONFIG) config: AppConfig) {
    if (config.busApi) this.client = createBusApiClient(config.busApi);
  }

  /**
   * Sends the standard event envelope to the fixed form.submitted topic.
   * @param payload Validated answers and server-derived receipt/member metadata.
   * @returns Nothing once Bus API accepts the event.
   * @throws ServiceUnavailableException when unconfigured or delivery fails; never exposes provider errors or submitted data.
   */
  async publishSubmission(payload: FormSubmittedPayload): Promise<void> {
    try {
      if (!this.client) throw new Error('Bus API is not configured.');
      await this.client.postEvent({
        topic: 'form.submitted',
        originator: 'forms-api-v6',
        timestamp: payload.submittedAt,
        'mime-type': 'application/json',
        key: payload.submissionId,
        payload,
      });
    } catch {
      throw new ServiceUnavailableException(
        'Submission saved but event delivery failed. Retry with the same Idempotency-Key and body.',
      );
    }
  }
}
