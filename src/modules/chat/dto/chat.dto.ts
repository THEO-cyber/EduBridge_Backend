import {
  IsString,
  IsOptional,
  IsArray,
  IsBoolean,
  MinLength,
  MaxLength,
  IsUUID,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateChatRoomDto {
  @ApiProperty({ example: 'Study Group Chat' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ enum: ['direct', 'group', 'course'] })
  @IsString()
  type!: 'direct' | 'group' | 'course';

  @ApiProperty({ example: ['user1-uuid', 'user2-uuid'] })
  @IsArray()
  @IsUUID('4', { each: true })
  participants!: string[];

  @ApiProperty({ example: 'course-uuid', required: false })
  @IsOptional()
  @IsUUID('4')
  relatedId?: string;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;
}

export class SendMessageDto {
  @ApiProperty({ example: 'Hello, how are you?' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content!: string;

  @ApiProperty({
    example: 'text',
    enum: ['text', 'image', 'file', 'video', 'audio'],
    required: false,
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiProperty({ example: 'message-uuid', required: false })
  @IsOptional()
  @IsUUID('4')
  replyToId?: string;
}

export class AddParticipantDto {
  @ApiProperty({ example: 'user-uuid' })
  @IsUUID('4')
  participantId!: string;
}

export class RemoveParticipantDto {
  @ApiProperty({ example: 'user-uuid' })
  @IsUUID('4')
  participantId!: string;
}
