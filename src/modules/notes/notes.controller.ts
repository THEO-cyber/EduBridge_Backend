import {
  Controller, Post, Get, Patch, Delete, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotesService, CreateNoteDto, UpdateNoteDto } from './notes.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { User } from '@prisma/client';

@ApiTags('Notes')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('notes')
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Post('lessons/:lessonId')
  @ApiOperation({ summary: 'Create a note for a lesson' })
  create(
    @Param('lessonId') lessonId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateNoteDto,
  ) {
    return this.notesService.create(user.id, lessonId, dto);
  }

  @Get('lessons/:lessonId')
  @ApiOperation({ summary: 'Get all notes for a lesson' })
  getForLesson(@Param('lessonId') lessonId: string, @CurrentUser() user: User) {
    return this.notesService.getForLesson(user.id, lessonId);
  }

  @Get()
  @ApiOperation({ summary: 'Get all my notes across all courses' })
  getAll(@CurrentUser() user: User, @Query() pagination: PaginationDto) {
    return this.notesService.getAll(user.id, pagination);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a note' })
  update(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: UpdateNoteDto) {
    return this.notesService.update(user.id, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a note' })
  delete(@Param('id') id: string, @CurrentUser() user: User) {
    return this.notesService.delete(user.id, id);
  }
}
