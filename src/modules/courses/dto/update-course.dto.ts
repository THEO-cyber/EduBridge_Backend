import { PartialType } from '@nestjs/swagger';
import { CreateCourseDto } from './create-course.dto';
import { IsOptional, IsEnum } from 'class-validator';
import { CourseStatus } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateCourseDto extends PartialType(CreateCourseDto) {
  @ApiProperty({ enum: CourseStatus, required: false })
  @IsOptional()
  @IsEnum(CourseStatus)
  status?: CourseStatus;
}
