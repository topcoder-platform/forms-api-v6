declare module 'tc-bus-api-wrapper' {
  /** Configuration accepted by the shared Topcoder Bus API wrapper. */
  export interface BusApiConfiguration {
    AUTH0_URL: string;
    AUTH0_AUDIENCE: string;
    AUTH0_CLIENT_ID: string;
    AUTH0_CLIENT_SECRET: string;
    BUSAPI_URL: string;
    KAFKA_ERROR_TOPIC: string;
    TOKEN_CACHE_TIME?: number;
    AUTH0_PROXY_SERVER_URL?: string;
  }

  /** Complete legacy-compatible event envelope published through Bus API. */
  export interface BusApiEvent<T> {
    topic: string;
    originator: string;
    timestamp: string;
    'mime-type': 'application/json';
    payload: T;
    key?: string;
  }

  /** Subset of the shared wrapper used by Forms API. */
  export interface BusApiClient {
    postEvent<T>(event: BusApiEvent<T>): Promise<unknown>;
  }

  /** Creates an authenticated client whose base URL is the Topcoder API v6 base. */
  export default function createBusApiClient(
    config: BusApiConfiguration,
  ): BusApiClient;
}
