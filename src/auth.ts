import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { middleware, type AuthenticatorRequest } from 'tc-core-library-js';
import { CONFIG, type AppConfig } from './config';

export type Permission = 'public' | 'manage' | 'report';
/**
 * Marks a controller route with its forms permission.
 * @param permission Required access level. @returns Nest metadata decorator. @throws No errors.
 */
export const Access = (permission: Permission) =>
  SetMetadata('forms.permission', permission);
export interface Actor {
  subject: string;
  memberId?: string;
  machine: boolean;
  roles: string[];
  scopes: string[];
}
export interface ActorRequest extends Request {
  actor?: Actor;
}

/** Validates bearer JWTs and applies the v6 human-role / M2M-scope permission split. */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly authenticator: ReturnType<
    typeof middleware.jwtAuthenticator
  >;

  /**
   * Injects configuration and route metadata for authentication.
   * @param config Validated JWT settings. @param reflector Nest route metadata reader.
   * @throws Error when the shared authenticator receives invalid configuration.
   */
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {
    this.authenticator = middleware.jwtAuthenticator({
      AUTH_SECRET: config.authSecret,
      VALID_ISSUERS: JSON.stringify(config.issuers),
    });
  }

  /**
   * Authenticates HS256/RS256 tokens through the shared Topcoder library, then checks route access.
   * Legacy tokens without sub use their verified userId as the audit subject.
   * @param context Current HTTP route and request.
   * @returns True after assigning a verified actor, or for an anonymous public request.
   * @throws UnauthorizedException for invalid/missing JWTs; ForbiddenException for insufficient roles/scopes.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<Permission>(
      'forms.permission',
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<ActorRequest>();
    const header = request.headers.authorization;
    if (!header) {
      if (permission === 'public') return true;
      throw new UnauthorizedException('A bearer token is required.');
    }
    if (!/^Bearer [^\s]+$/i.test(header))
      throw new UnauthorizedException('Invalid Authorization header.');
    try {
      const payload = await this.authenticate(header.slice(7));
      request.actor = normalizeActor(payload, this.config.claimNamespace);
    } catch {
      throw new UnauthorizedException('Invalid or expired bearer token.');
    }
    if (permission === 'public') return true;
    const actor = request.actor;
    const allowed = actor.machine
      ? actor.scopes.includes(
          permission === 'report' ? 'read:forms-submissions' : 'manage:forms',
        )
      : actor.roles.includes('administrator') ||
        (permission === 'manage' &&
          actor.roles.includes('forms administrator')) ||
        (permission === 'report' && actor.roles.includes('forms reporter'));
    if (!permission || !allowed)
      throw new ForbiddenException('Insufficient forms permissions.');
    return true;
  }

  /**
   * Adapts the standard Topcoder middleware to Nest's 401 handling.
   * @param token Compact bearer JWT; claims are consumed only after verification.
   * @returns Verified claims with Topcoder namespaced identities normalized by the library.
   * @throws Error for unsupported algorithms, invalid tokens or missing time claims.
   */
  private async authenticate(token: string): Promise<Record<string, unknown>> {
    // The shared verifier does not call back for unsupported algorithms.
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !['HS256', 'RS256'].includes(decoded.header.alg))
      throw new Error('Unsupported token algorithm.');
    return new Promise((resolve, reject) => {
      const request: AuthenticatorRequest = {
        headers: { authorization: `Bearer ${token}` },
      };
      const fail = () => reject(new Error('Token authentication failed.'));
      const response = {
        status: () => response,
        json: fail,
        send: fail,
        end: fail,
      };
      this.authenticator(request, response, (error?: unknown) => {
        const payload = request.authUser;
        if (
          error ||
          !payload ||
          typeof payload.exp !== 'number' ||
          typeof payload.iat !== 'number'
        ) {
          fail();
          return;
        }
        resolve(payload);
      });
    });
  }
}

/**
 * Converts verified Topcoder/Auth0 claims into the service actor model.
 * @param claims Cryptographically verified claims. @param namespace Exact configured custom-claim prefix.
 * @returns Normalized actor; memberId is absent for machines, and legacy human subjects use memberId.
 * @throws Error if the token lacks a usable subject or contains oversized identity claims.
 */
export function normalizeActor(
  claims: Record<string, unknown>,
  namespace: string,
): Actor {
  const roles = stringList(
    claims.roles ?? claims[`${namespace}roles`],
    ',',
  ).map((r) => r.toLowerCase());
  const scopes = stringList(claims.scope ?? claims.scopes, /\s+/);
  const machine =
    claims.gty === 'client-credentials' ||
    claims.isMachine === true ||
    (typeof claims.sub === 'string' && claims.sub.endsWith('@clients')) ||
    (scopes.length > 0 && roles.length === 0);
  const userId = claims.userId ?? claims[`${namespace}userId`];
  const memberId =
    !machine &&
    (typeof userId === 'string' ||
      (typeof userId === 'number' && Number.isSafeInteger(userId)))
      ? String(userId)
      : undefined;
  if (memberId && memberId.length > 200)
    throw new Error('Invalid member identity.');
  const subject =
    claims.sub ??
    (!machine && memberId && /^[1-9]\d*$/.test(memberId)
      ? memberId
      : undefined);
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200)
    throw new Error('Invalid token subject.');
  return { subject, memberId, machine, roles, scopes };
}

/**
 * Normalizes trusted JWT list claims without splitting multiword role names.
 * @param value Claim value. @param separator Separator for string claims.
 * @returns Trimmed string list. @throws No errors; unsupported claims become empty lists.
 */
function stringList(value: unknown, separator: string | RegExp): string[] {
  if (Array.isArray(value))
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(separator)
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}
