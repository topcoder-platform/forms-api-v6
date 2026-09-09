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
import type { JWTPayload, JWTVerifyGetKey } from 'jose' with {
  'resolution-mode': 'import',
};
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
  private key?: Uint8Array | JWTVerifyGetKey;

  /**
   * Injects configuration and route metadata for authentication.
   * @param config Validated JWT settings. @param reflector Nest route metadata reader.
   * @throws No errors; verification happens per request.
   */
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Authenticates an optional public-route token or a required administration token.
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
      const { jwtVerify, createRemoteJWKSet } = await import('jose');
      this.key ??=
        this.config.authMode === 'hs256'
          ? new TextEncoder().encode(this.config.authSecret)
          : createRemoteJWKSet(new URL(this.config.jwksUrl!));
      const verificationOptions = {
        algorithms: [this.config.authMode === 'hs256' ? 'HS256' : 'RS256'],
        issuer: this.config.issuers,
        audience: this.config.audience,
        requiredClaims: ['exp', 'sub', 'iat'],
      };
      const { payload } =
        this.key instanceof Uint8Array
          ? await jwtVerify(header.slice(7), this.key, verificationOptions)
          : await jwtVerify(header.slice(7), this.key, verificationOptions);
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
}

/**
 * Converts verified Topcoder/Auth0 claims into the service actor model.
 * @param claims Cryptographically verified claims. @param namespace Exact configured custom-claim prefix.
 * @returns Normalized actor; memberId is absent for machine tokens.
 * @throws Error if the token lacks a usable subject or contains oversized identity claims.
 */
export function normalizeActor(claims: JWTPayload, namespace: string): Actor {
  const subject = claims.sub;
  if (!subject || subject.length > 200)
    throw new Error('Invalid token subject.');
  const roles = stringList(
    claims.roles ?? claims[`${namespace}roles`],
    ',',
  ).map((r) => r.toLowerCase());
  const scopes = stringList(claims.scope ?? claims.scopes, /\s+/);
  const machine =
    claims.gty === 'client-credentials' ||
    claims.isMachine === true ||
    subject.endsWith('@clients') ||
    (scopes.length > 0 && roles.length === 0);
  const userId = claims.userId ?? claims[`${namespace}userId`];
  const memberId =
    !machine && (typeof userId === 'string' || typeof userId === 'number')
      ? String(userId)
      : undefined;
  if (memberId && memberId.length > 200)
    throw new Error('Invalid member identity.');
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
