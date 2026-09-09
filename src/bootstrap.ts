import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded, type Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { AppConfig } from './config';

/** Returns safe HTTP errors without logging submitted answers or Prisma query parameter values. */
@Catch()
class SafeExceptionFilter implements ExceptionFilter {
  /**
   * Converts route exceptions into public errors.
   * @param exception Thrown request error. @param host HTTP response context.
   * @returns Nothing after sending a response. @throws No errors for normal Express responses.
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response
        .status(exception.getStatus())
        .json(
          typeof body === 'string'
            ? { statusCode: exception.getStatus(), message: body }
            : body,
        );
      return;
    }
    // Parser errors are safe to classify but their bodies can contain submitted PII.
    const parserType =
      typeof exception === 'object' && exception !== null && 'type' in exception
        ? exception.type
        : undefined;
    if (
      parserType === 'entity.too.large' ||
      parserType === 'entity.parse.failed'
    ) {
      response.status(parserType === 'entity.too.large' ? 413 : 400).json({
        message:
          parserType === 'entity.too.large'
            ? 'Request body is too large.'
            : 'Malformed JSON request.',
      });
      return;
    }
    Logger.error(
      'Request failed unexpectedly. Check database/service availability.',
      'FormsAPI',
    );
    response
      .status(500)
      .json({ statusCode: 500, message: 'Internal server error.' });
  }
}

/**
 * Creates a configured HTTP application used identically in production and integration tests.
 * @param config Validated runtime configuration.
 * @returns Initialized Nest application, not yet listening on a port.
 * @throws Errors for invalid providers or unavailable database connections.
 */
export async function createApp(
  config: AppConfig,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config),
    { bodyParser: false },
  );
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  if (config.trustProxy.length) app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.use(json({ limit: '512kb' }));
  app.use(urlencoded({ extended: false, limit: '512kb' }));
  app.enableCors({
    origin: config.origins,
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['X-Next-Cursor'],
    credentials: false,
  });
  app.setGlobalPrefix('v6');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new SafeExceptionFilter());
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Topcoder Forms API')
      .setDescription(
        'Typed relational forms, versioned publication, and private reporting. Public schema/submission routes accept optional bearer tokens.',
      )
      .setVersion('6')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('v6/docs', app, document);
  app.enableShutdownHooks();
  await app.init();
  return app;
}
