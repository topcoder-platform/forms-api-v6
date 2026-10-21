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
import { auth, type Principal } from 'tc-core-library-js';
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
  private readonly validator: ReturnType<typeof auth.createValidator>;

  /**
   * Injects configuration and route metadata for authentication.
   * @param config Validated JWT settings. @param reflector Nest route metadata reader.
   * @throws Error when the shared authenticator receives invalid configuration.
   */
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {
    this.validator = auth.createValidator({
      AUTH_SECRET: config.authSecret,
      VALID_ISSUERS: JSON.stringify(config.issuers),
    });
  }

  /**
   * Authenticates HS256/RS256 tokens through the shared Topcoder library, then checks route access.
   * The shared validator supplies the verified subject and service/user classification.
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
    let principal: Principal;
    try {
      principal = await this.validator.verify(header.slice(7));
      request.actor = normalizeActor(principal);
    } catch {
      throw new UnauthorizedException('Invalid or expired bearer token.');
    }
    if (permission === 'public') return true;
    const actor = request.actor;
    const allowed = actor.machine
      ? auth.hasScopes(principal, [permission === 'report' ? 'read:forms-submissions' : 'manage:forms'])
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
 * Adapts the shared verified principal into the forms audit actor.
 * @param principal Normalized identity returned by the shared core validator.
 * @returns Actor with exact service scopes or member roles/ID; legacy member subjects use the verified ID.
 * @throws Error for an invalid subject; token verification precedes this function.
 */
export function normalizeActor(
  principal: Pick<Principal, 'kind' | 'isMachine' | 'userId' | 'sub' | 'scopes' | 'roles'>,
): Actor {
  const machine = principal.kind === 'service' && principal.isMachine;
  const subject = principal.sub ?? (!machine && principal.userId !== undefined ? String(principal.userId) : undefined);
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) throw new Error('Invalid token subject.');
  return { subject, machine,
    memberId: !machine && principal.userId !== undefined ? String(principal.userId) : undefined,
    roles: machine ? [] : principal.roles.map(role => role.toLowerCase()),
    scopes: machine ? principal.scopes : [],
  };
}
