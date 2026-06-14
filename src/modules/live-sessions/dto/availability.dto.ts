import {
  IsInt, IsString, IsBoolean, IsOptional, Min, Max, Matches, MinLength, MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAvailabilitySlotDto {
  @ApiProperty({ description: 'Day of week: 0=Sunday, 6=Saturday', minimum: 0, maximum: 6 })
  @IsInt() @Min(0) @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ description: 'Start time in HH:MM format (24h)', example: '09:00' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'startTime must be in HH:MM format' })
  startTime!: string;

  @ApiProperty({ description: 'End time in HH:MM format (24h)', example: '17:00' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'endTime must be in HH:MM format' })
  endTime!: string;

  @ApiProperty({ description: 'IANA timezone', example: 'America/New_York' })
  @IsString()
  timezone!: string;

  @ApiProperty({ description: 'Session duration in minutes', minimum: 15 })
  @IsInt() @Min(15)
  sessionDuration!: number;

  @ApiPropertyOptional({ description: 'Max concurrent students per slot', default: 1 })
  @IsOptional() @IsInt() @Min(1) @Max(10)
  maxStudents?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class UpdateAvailabilitySlotDto {
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'startTime must be in HH:MM format' })
  startTime?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'endTime must be in HH:MM format' })
  endTime?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsInt() @Min(15)
  sessionDuration?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsInt() @Min(1) @Max(10)
  maxStudents?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}
