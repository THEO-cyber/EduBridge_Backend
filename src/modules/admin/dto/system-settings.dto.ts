import { IsString, IsBoolean, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSystemSettingDto {
  @ApiProperty({ example: 'platform.maintenance_mode' })
  @IsString() @MaxLength(100)
  key!: string;

  @ApiProperty({ example: 'false' })
  @IsString() @MaxLength(5000)
  value!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Whether this setting is readable without auth' })
  @IsOptional() @IsBoolean()
  isPublic?: boolean;
}

export class UpdateSystemSettingDto {
  @ApiProperty()
  @IsString() @MaxLength(5000)
  value!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  isPublic?: boolean;
}
