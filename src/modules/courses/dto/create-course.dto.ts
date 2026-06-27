import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsNumber,
  Min,
  ArrayMinSize,
  MinLength,
  MaxLength,
  IsUrl,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CourseLevel } from '@prisma/client';
import { Type } from 'class-transformer';

export class CreateCourseDto {
  @ApiProperty({ example: 'Complete React Development Course' })
  @IsString()
  @MinLength(10)
  @MaxLength(100)
  title!: string;

  @ApiProperty({
    example: 'Learn React.js from beginner to advanced with hands-on projects',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(500)
  description!: string;

  @ApiProperty({ example: 'Master React.js development', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  shortDescription?: string;

  @ApiProperty({ example: 'category-uuid' })
  @IsString()
  categoryId!: string;

  @ApiProperty({ example: 99.99, description: 'Set to 0 for free courses' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  price!: number;

  @ApiProperty({ example: 79.99, required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  discountPrice?: number;

  @ApiProperty({ example: 'USD', required: false })
  @IsOptional()
  @IsString()
  currency?: string = 'USD';

  @ApiProperty({ enum: CourseLevel, example: CourseLevel.INTERMEDIATE })
  @IsEnum(CourseLevel)
  level!: CourseLevel;

  @ApiProperty({ example: 'en', required: false })
  @IsOptional()
  @IsString()
  language?: string = 'en';

  @ApiProperty({ example: ['Basic JavaScript knowledge'], isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  requirements!: string[];

  @ApiProperty({ example: ['Build modern React applications'], isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  objectives!: string[];

  @ApiProperty({
    example: ['react', 'javascript', 'frontend'],
    isArray: true,
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  thumbnail?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  previewVideo?: string;
}
