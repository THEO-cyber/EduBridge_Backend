import {
  IsString,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateSessionRequestDto {
  @ApiProperty({ example: 'instructor-uuid' })
  @IsString()
  instructorId: string;

  @ApiProperty({ example: 'React.js Help Session' })
  @IsString()
  @MinLength(5)
  @MaxLength(100)
  title: string;

  @ApiProperty({
    example: 'Need help with React hooks and state management',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: '2024-04-15T10:00:00Z' })
  @IsDateString()
  preferredDate: string;

  @ApiProperty({ example: 60 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  duration: number;

  @ApiProperty({
    example: 'I have specific questions about useEffect',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}
