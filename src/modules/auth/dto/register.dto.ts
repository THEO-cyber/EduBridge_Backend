import { Expose, Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsEnum,
  Matches,
} from 'class-validator';
import { Role } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'john_doe' })
  @IsString()
  @MinLength(3)
  @Expose({ name: 'name' })
  @Transform(({ value, obj }) => value ?? obj.username, { toClassOnly: true })
  username!: string;

  @ApiProperty({ example: 'John' })
  @IsString()
  @MinLength(2)
  @Expose({ name: 'first_name' })
  @Transform(({ value, obj }) => value ?? obj.firstName, { toClassOnly: true })
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @MinLength(2)
  @Expose({ name: 'last_name' })
  @Transform(({ value, obj }) => value ?? obj.lastName, { toClassOnly: true })
  lastName!: string;

  @ApiProperty({
    example: 'MyPass123!',
    description: 'Min 8 chars, at least one uppercase, one lowercase, one number, one special character',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).+$/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character',
  })
  password!: string;

  @ApiProperty({ enum: Role, example: Role.STUDENT, required: false })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toUpperCase();
    if (normalized === 'LECTURER') return Role.INSTRUCTOR;
    return normalized as Role;
  })
  @IsEnum(Role)
  role?: Role = Role.STUDENT;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bio?: string;
}
