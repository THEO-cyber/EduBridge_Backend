import {
  Injectable, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateNoteDto {
  @ApiProperty() @IsString() content!: string;
  @ApiPropertyOptional({ description: 'Video timestamp in seconds' })
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) timestamp?: number;
}

export class UpdateNoteDto {
  @ApiPropertyOptional() @IsOptional() @IsString() content?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Type(() => Number) timestamp?: number;
}

@Injectable()
export class NotesService {
  private get db() { return this.prisma as any; }

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, lessonId: string, dto: CreateNoteDto) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw new NotFoundException('Lesson not found');

    return this.db.studentNote.create({
      data: { userId, lessonId, content: dto.content, timestamp: dto.timestamp ?? null },
    });
  }

  async update(userId: string, noteId: string, dto: UpdateNoteDto) {
    const note = await this.db.studentNote.findUnique({ where: { id: noteId } });
    if (!note) throw new NotFoundException('Note not found');
    if (note.userId !== userId) throw new ForbiddenException('Not your note');

    return this.db.studentNote.update({
      where: { id: noteId },
      data: {
        ...(dto.content   !== undefined && { content: dto.content }),
        ...(dto.timestamp !== undefined && { timestamp: dto.timestamp }),
      },
    });
  }

  async delete(userId: string, noteId: string) {
    const note = await this.db.studentNote.findUnique({ where: { id: noteId } });
    if (!note) throw new NotFoundException('Note not found');
    if (note.userId !== userId) throw new ForbiddenException('Not your note');
    await this.db.studentNote.delete({ where: { id: noteId } });
    return { message: 'Note deleted' };
  }

  async getForLesson(userId: string, lessonId: string) {
    const notes = await this.db.studentNote.findMany({
      where:   { userId, lessonId },
      orderBy: { timestamp: 'asc' },
    });
    return { notes, total: notes.length };
  }

  async getAll(userId: string, pagination: PaginationDto) {
    const { page = 1, limit = 20, skip = 0 } = pagination;

    const [notes, total] = await Promise.all([
      this.db.studentNote.findMany({
        where:   { userId },
        skip,
        take:    limit,
        include: { lesson: { select: { id: true, title: true, section: { select: { course: { select: { id: true, title: true, slug: true } } } } } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.studentNote.count({ where: { userId } }),
    ]);

    return { notes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }
}
