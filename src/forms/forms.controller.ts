import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Access, type ActorRequest } from '../auth';
import { CreateFormDto, DefinitionDto, PageDto, SubmissionDto } from './dto';
import { FormsService } from './forms.service';

/** Exposes public form schemas/submissions and separately authorized editing/reporting operations. */
@ApiTags('Forms')
@ApiBearerAuth()
@Controller('forms')
export class FormsController {
  /** @param forms Domain service injected by Nest. @throws No errors. */
  constructor(private readonly forms: FormsService) {}

  /** Lists form identities; accepts a key cursor, returns a page, and propagates invalid-cursor/read errors. */
  @Get()
  @Access('manage')
  @ApiOperation({ summary: 'List named forms for editors' })
  list(@Query('after') after?: string) {
    return this.forms.listForms(after);
  }

  /** Registers a named form; accepts its key, returns its identity, and propagates persistence errors. */
  @Post()
  @Access('manage')
  @ApiOperation({ summary: 'Register a named form (idempotent by key)' })
  create(@Body() body: CreateFormDto) {
    return this.forms.createForm(body.key);
  }

  /** Reads the active schema for a key; returns public fields or throws NotFoundException when closed/unpublished. */
  @Get(':key')
  @Access('public')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the current published form schema' })
  getPublic(@Param('key') key: string) {
    return this.forms.getPublicForm(key);
  }

  /** Reads a pinned revision for an editor; returns metadata or propagates invalid/missing-revision errors. */
  @Get(':key/versions/:version')
  @Access('manage')
  getVersion(
    @Param('key') key: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.forms.getVersion(key, version);
  }

  /** Saves a full next-version definition for the request actor; returns metadata or definition/conflict/not-found errors. */
  @Put(':key/versions/:version')
  @Access('manage')
  @ApiOperation({
    summary:
      'Save an immutable draft; retry identical content at the same version',
  })
  putVersion(
    @Param('key') key: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() body: DefinitionDto,
    @Req() request: ActorRequest,
  ) {
    return this.forms.putVersion(key, version, body, request.actor!);
  }

  /** Publishes a revision for the actor, returning metadata; throws for missing/retired/obsolete revisions or failed DDL. */
  @Post(':key/versions/:version/publish')
  @HttpCode(200)
  @Access('manage')
  publish(
    @Param('key') key: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() request: ActorRequest,
  ) {
    return this.forms.publish(key, version, request.actor!);
  }

  /** Closes a revision for the actor, returning metadata; throws for drafts or missing revisions. */
  @Post(':key/versions/:version/retire')
  @HttpCode(200)
  @Access('manage')
  retire(
    @Param('key') key: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() request: ActorRequest,
  ) {
    return this.forms.retire(key, version, request.actor!);
  }

  /** Saves an envelope under a UUID retry key; returns a receipt or validation, authentication, stale-version, or conflict errors. */
  @Post(':key/submissions')
  @Access('public')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'One random UUID per attempted submission, reused unchanged on network retries.',
  })
  @ApiOperation({
    summary: 'Submit against the exact version displayed to the visitor',
  })
  submit(
    @Param('key') key: string,
    @Body() body: SubmissionDto,
    @Headers('idempotency-key') retryKey: string,
    @Req() request: ActorRequest,
  ) {
    return this.forms.submit(key, body, retryKey, request.actor);
  }

  /** Returns a private named-column report for a revision/page; propagates cursor, draft, and missing-revision errors. */
  @Get(':key/versions/:version/submissions')
  @Access('report')
  @Header('Cache-Control', 'no-store')
  report(
    @Param('key') key: string,
    @Param('version', ParseIntPipe) version: number,
    @Query() page: PageDto,
  ) {
    return this.forms.report(key, version, page);
  }

  /** Exports a private CSV page and cursor header; accepts revision/pagination and propagates report errors. */
  @Get(':key/versions/:version/submissions.csv')
  @Access('report')
  @Header('Cache-Control', 'no-store')
  async csv(
    @Param('key') key: string,
    @Param('version', ParseIntPipe) version: number,
    @Query() page: PageDto,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.forms.csv(key, version, page);
    if (result.nextCursor)
      response.setHeader('X-Next-Cursor', result.nextCursor);
    response
      .type('text/csv')
      .attachment(`${key}_v${version}.csv`)
      .send(result.csv);
  }
}
