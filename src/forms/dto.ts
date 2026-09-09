import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  NotContains,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FieldType, FormAccess } from '../generated/prisma/enums';

export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;
export const RESERVED_KEYS = new Set([
  'submission_id',
  'submitted_at',
  'member_id',
  'source_page',
  'form_version',
]);

/** Validates the stable named-form identity submitted to administration endpoints. */
export class CreateFormDto {
  @ApiProperty({ example: 'event_interest', pattern: KEY_PATTERN.source })
  @Matches(KEY_PATTERN)
  key!: string;
}

/** Validates an allowlisted option owned by one field; used in nested version definitions. */
export class OptionDto {
  @ApiProperty({ example: 'design' }) @Matches(KEY_PATTERN) key!: string;
  @ApiProperty({ example: 'Design' })
  @IsString()
  @NotContains('\0')
  @Length(1, 200)
  label!: string;
}

/** Describes a typed, named form field and its bounded validation rules for editors. */
export class FieldDto {
  @ApiProperty({ example: 'email' }) @Matches(KEY_PATTERN) key!: string;
  @ApiProperty({ example: 'Email address' })
  @IsString()
  @NotContains('\0')
  @Length(1, 200)
  label!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @NotContains('\0')
  @MaxLength(1000)
  helpText?: string;
  @ApiProperty({ enum: FieldType }) @IsEnum(FieldType) type!: FieldType;
  @ApiPropertyOptional({ default: false }) @IsBoolean() required: boolean =
    false;
  @ApiPropertyOptional({ maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  maxLength?: number;
  @ApiPropertyOptional({
    type: String,
    description:
      'Exact decimal text, up to 14 integer and 6 fractional digits.',
  })
  @IsOptional()
  @Matches(DECIMAL_PATTERN)
  minValue?: string;
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @Matches(DECIMAL_PATTERN)
  maxValue?: string;
  @ApiPropertyOptional({ type: [OptionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OptionDto)
  options?: OptionDto[];
}

/** Validates a complete immutable revision; changes must use the next version number. */
export class DefinitionDto {
  @ApiProperty() @IsString() @NotContains('\0') @Length(1, 200) title!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @NotContains('\0')
  @MaxLength(2000)
  description?: string;
  @ApiPropertyOptional({ default: 'Thank you. Your submission was received.' })
  @IsString()
  @NotContains('\0')
  @Length(1, 1000)
  successMessage: string = 'Thank you. Your submission was received.';
  @ApiPropertyOptional({ enum: FormAccess, default: FormAccess.ANONYMOUS })
  @IsEnum(FormAccess)
  access: FormAccess = FormAccess.ANONYMOUS;
  @ApiProperty({ type: [FieldDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FieldDto)
  fields!: FieldDto[];
}

/** Validates the public submission envelope; answer values are checked against the stored revision. */
export class SubmissionDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(1000000) version!: number;
  @ApiProperty({
    type: Object,
    additionalProperties: true,
    example: { email: 'member@example.com' },
  })
  @IsObject()
  answers!: Record<string, unknown>;
  @ApiPropertyOptional({ example: '/events/design' })
  @IsOptional()
  @IsString()
  @NotContains('\0')
  @MaxLength(1000)
  @Matches(/^\/(?!\/)[^?#\r\n]*$/)
  sourcePage?: string;
  @ApiPropertyOptional({ description: 'Honeypot. Keep empty.' })
  @IsOptional()
  @IsString()
  @MaxLength(0)
  website?: string;
}

/** Defines bounded keyset pagination for reporting; only cursors in this version are accepted. */
export class PageDto {
  @ApiPropertyOptional({ default: 100, maximum: 1000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit: number = 100;
  @ApiPropertyOptional() @IsOptional() @IsUUID() after?: string;
}
