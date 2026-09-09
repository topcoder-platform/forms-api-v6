import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Access } from './auth';
import { DbService } from './db.service';

/** Supplies unauthenticated liveness and database readiness checks for deployment probes. */
@Controller()
@Access('public')
@SkipThrottle()
export class HealthController {
  /** @param db Shared database connection for readiness. @throws No errors. */
  constructor(private readonly db: DbService) {}

  /** Liveness probe with no input; returns ok when the event loop serves requests and never throws. */
  @Get('health')
  live() {
    return { status: 'ok' };
  }

  /** Readiness probe with no input; returns ok after SELECT 1, or throws ServiceUnavailableException on database failure. */
  @Get(['health/ready', 'forms/health/ready'])
  async ready() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Database is unavailable.');
    }
  }
}
