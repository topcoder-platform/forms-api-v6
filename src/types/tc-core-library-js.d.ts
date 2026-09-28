declare module 'tc-core-library-js' {
  /** Minimal request shape populated by the shared Topcoder authenticator. */
  interface AuthenticatorRequest {
    headers: { authorization: string };
    authUser?: Record<string, unknown>;
  }

  /** Response adapter converts the library's HTTP failures to Nest exceptions. */
  interface AuthenticatorResponse {
    status(code: number): AuthenticatorResponse;
    json(body?: unknown): void;
    send(...args: unknown[]): void;
    end(body?: unknown): void;
  }

  /** Callback middleware exported by the shared Topcoder library. */
  type JwtAuthenticator = (
    request: AuthenticatorRequest,
    response: AuthenticatorResponse,
    next: (error?: unknown) => void,
  ) => void;

  /** Shared JWT verifier and Topcoder claim-normalization entry point. */
  export const middleware: {
    jwtAuthenticator(config: {
      AUTH_SECRET: string;
      VALID_ISSUERS: string;
    }): JwtAuthenticator;
  };
}
