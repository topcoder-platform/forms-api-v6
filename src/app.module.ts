import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './auth';
import { CONFIG, type AppConfig } from './config';
import { DbService } from './db.service';
import { FormsController } from './forms/forms.controller';
import { FormsService } from './forms/forms.service';
import { HealthController } from './health.controller';

/** Composes the forms service with explicit configuration, authentication, and request throttling. */
@Module({})
export class AppModule {
  /**
   * Creates the configured module for bootstrap or real-database integration tests.
   * @param config Validated runtime configuration.
   * @returns Nest dynamic module. @throws No errors; providers validate/connect during initialization.
   */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ThrottlerModule.forRoot([{ ttl: 60000, limit: config.throttleLimit }]),
      ],
      controllers: [HealthController, FormsController],
      providers: [
        { provide: CONFIG, useValue: config },
        DbService,
        FormsService,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
