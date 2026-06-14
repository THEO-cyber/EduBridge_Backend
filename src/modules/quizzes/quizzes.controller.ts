import {
  Controller, Post, Get, Patch, Delete,
  Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { QuizzesService, CreateQuizDto, UpdateQuizDto, CreateQuestionDto, SubmitQuizDto } from './quizzes.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Role, User } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';

class StartAttemptDto {
  @IsOptional() @IsString() enrollmentId?: string;
}

@ApiTags('Quizzes')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('quizzes')
export class QuizzesController {
  constructor(private readonly quizzesService: QuizzesService) {}

  // ── Instructor: quiz management ───────────────────────────────────────────

  @Post('lessons/:lessonId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Create quiz for a lesson (Instructor)' })
  createQuiz(
    @Param('lessonId') lessonId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateQuizDto,
  ) {
    return this.quizzesService.createQuiz(user.id, lessonId, dto);
  }

  @Patch(':quizId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Update quiz (Instructor)' })
  updateQuiz(
    @Param('quizId') quizId: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateQuizDto,
  ) {
    return this.quizzesService.updateQuiz(user.id, quizId, dto);
  }

  @Delete(':quizId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Delete quiz (Instructor)' })
  deleteQuiz(@Param('quizId') quizId: string, @CurrentUser() user: User) {
    return this.quizzesService.deleteQuiz(user.id, quizId);
  }

  // ── Instructor: question management ──────────────────────────────────────

  @Post(':quizId/questions')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Add question to quiz (Instructor)' })
  addQuestion(
    @Param('quizId') quizId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateQuestionDto,
  ) {
    return this.quizzesService.addQuestion(user.id, quizId, dto);
  }

  @Patch('questions/:questionId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Update question (Instructor)' })
  updateQuestion(
    @Param('questionId') questionId: string,
    @CurrentUser() user: User,
    @Body() dto: Partial<CreateQuestionDto>,
  ) {
    return this.quizzesService.updateQuestion(user.id, questionId, dto);
  }

  @Delete('questions/:questionId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Delete question (Instructor)' })
  deleteQuestion(@Param('questionId') questionId: string, @CurrentUser() user: User) {
    return this.quizzesService.deleteQuestion(user.id, questionId);
  }

  // ── Instructor: results ───────────────────────────────────────────────────

  @Get(':quizId/results')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Get quiz results and stats (Instructor)' })
  getResults(
    @Param('quizId') quizId: string,
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.quizzesService.getQuizResults(user.id, quizId, pagination);
  }

  // ── Student: take quiz ────────────────────────────────────────────────────

  @Get('lesson/:lessonId')
  @ApiOperation({ summary: 'Get quiz for a lesson (Student)' })
  getQuizForLesson(@Param('lessonId') lessonId: string, @CurrentUser() user: User) {
    return this.quizzesService.getQuizByLesson(lessonId, user.id);
  }

  @Post(':quizId/start')
  @ApiOperation({ summary: 'Start a quiz attempt (Student)' })
  startAttempt(
    @Param('quizId') quizId: string,
    @CurrentUser() user: User,
    @Body() dto: StartAttemptDto,
  ) {
    return this.quizzesService.startAttempt(quizId, user.id, dto.enrollmentId);
  }

  @Post('attempts/:attemptId/submit')
  @ApiOperation({ summary: 'Submit quiz answers (Student)' })
  submitAttempt(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: User,
    @Body() dto: SubmitQuizDto,
  ) {
    return this.quizzesService.submitAttempt(attemptId, user.id, dto);
  }

  @Get(':quizId/my-attempts')
  @ApiOperation({ summary: 'Get my quiz attempts (Student)' })
  getMyAttempts(@Param('quizId') quizId: string, @CurrentUser() user: User) {
    return this.quizzesService.getMyAttempts(quizId, user.id);
  }
}
