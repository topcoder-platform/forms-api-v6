import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { CONFIG, type AppConfig } from './config';

/** Owns the Prisma 7 PostgreSQL adapter and connection lifecycle for Nest services. */
@Injectable()
export class DbService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  /**
   * Creates the shared database client.
   * @param config Validated connection settings.
   * @throws Error if the PostgreSQL adapter cannot be configured.
   */
  constructor(@Inject(CONFIG) config: AppConfig) {
    super({
      adapter: new PrismaPg(
        {
          connectionString: config.databaseUrl,
          max: 10,
          connectionTimeoutMillis: 5000,
        },
        { schema: 'forms' },
      ),
    });
  }

  /** Connects at startup; takes no arguments, returns completion, and throws on database failure. */
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /** Closes the pool at shutdown; takes no arguments, returns completion, and propagates driver errors. */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
