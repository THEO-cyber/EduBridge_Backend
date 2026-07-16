import { IsString, IsOptional, IsInt, IsBoolean, Min, Max, IsDateString, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../../common/dto/pagination.dto';

// my-sessions query: pagination + an optional role filter.
// Extending PaginationDto keeps `role` whitelisted so the global
// ValidationPipe (forbidNonWhitelisted) doesn't reject it.
export class GetUserSessionsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ['instructor', 'student'] })
  @IsOptional()
  @IsIn(['instructor', 'student'])
  role?: 'instructor' | 'student';
}

export class CreateLiveSessionDto {
  @ApiProperty({ example: 'Advanced React Hooks — Live Class' })
  @IsString()
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: '2026-07-10T10:00:00Z' })
  @IsDateString()
  scheduledAt!: string;

  @ApiProperty({ example: 90, description: 'Duration in minutes' })
  @IsInt() @Min(15) @Max(480)
  @Type(() => Number)
  duration!: number;

  @ApiPropertyOptional({ example: 30, description: 'Max accepted students' })
  @IsOptional()
  @IsInt() @Min(1) @Max(500)
  @Type(() => Number)
  maxStudents?: number;

  @ApiPropertyOptional({ description: 'Link to a specific course' })
  @IsOptional()
  @IsString()
  courseId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class UpdateLiveSessionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt() @Min(15) @Max(480)
  @Type(() => Number)
  duration?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt() @Min(1) @Max(500)
  @Type(() => Number)
  maxStudents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class NotifySessionDto {
  @ApiProperty({ example: 'Class starts in 1 hour — check your LiveKit link!' })
  @IsString()
  message!: string;

  @ApiPropertyOptional({ example: 'Class Starting Soon' })
  @IsOptional()
  @IsString()
  title?: string;
}
