import {
  Injectable, NotFoundException, BadRequestException,
  ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  IsString, IsOptional, IsInt, IsBoolean, IsArray, IsEnum,
  IsIn, Min, Max, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateQuizDto {
  @ApiProperty() @IsString() title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ default: 70, minimum: 0, maximum: 100 })
  @IsOptional() @IsInt() @Min(0) @Max(100) passingScore?: number;
  @ApiPropertyOptional({ description: 'Time limit in minutes' })
  @IsOptional() @IsInt() @Min(1) timeLimit?: number;
}

export class UpdateQuizDto {
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) passingScore?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) timeLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublished?: boolean;
}

export class QuizOptionDto {
  @ApiProperty() @IsString() id!: string;
  @ApiProperty() @IsString() text!: string;
}

export class CreateQuestionDto {
  @ApiProperty() @IsString() questionText!: string;
  @ApiProperty({ enum: ['multiple_choice', 'true_false', 'short_answer'] })
  @IsIn(['multiple_choice', 'true_false', 'short_answer']) questionType!: string;
  @ApiPropertyOptional({ type: [QuizOptionDto] })
  @IsOptional() @IsArray() options?: QuizOptionDto[];
  @ApiProperty({ description: 'Correct answer (option id for MC, "true"/"false", or text)' })
  @IsString() correctAnswer!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() explanation?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) points?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class SubmitAnswerDto {
  @ApiProperty() @IsString() questionId!: string;
  @ApiProperty() @IsString() answer!: string;
}

export class SubmitQuizDto {
  @ApiProperty({ type: [SubmitAnswerDto] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => SubmitAnswerDto)
  answers!: SubmitAnswerDto[];
  @ApiPropertyOptional({ description: 'Time spent in seconds' })
  @IsOptional() @IsInt() @Min(0) timeSpent?: number;
}

@Injectable()
export class QuizzesService {
  private readonly logger = new Logger(QuizzesService.name);
  private get db() { return this.prisma as any; }

  constructor(private readonly prisma: PrismaService) {}

  // ── Instructor: create a quiz for a lesson ────────────────────────────────

  async createQuiz(instructorId: string, lessonId: string, dto: CreateQuizDto) {
    await this.assertInstructorOwnsLesson(instructorId, lessonId);

    const existing = await this.db.quiz.findUnique({ where: { lessonId } });
    if (existing) throw new BadRequestException('This lesson already has a quiz');

    return this.db.quiz.create({
      data: {
        lessonId,
        title:       dto.title,
        description: dto.description,
        passingScore: dto.passingScore ?? 70,
        timeLimit:   dto.timeLimit,
      },
      include: { questions: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  async updateQuiz(instructorId: string, quizId: string, dto: UpdateQuizDto) {
    await this.assertInstructorOwnsQuiz(instructorId, quizId);
    return this.db.quiz.update({
      where: { id: quizId },
      data: {
        ...(dto.title        !== undefined && { title: dto.title }),
        ...(dto.description  !== undefined && { description: dto.description }),
        ...(dto.passingScore !== undefined && { passingScore: dto.passingScore }),
        ...(dto.timeLimit    !== undefined && { timeLimit: dto.timeLimit }),
        ...(dto.isPublished  !== undefined && { isPublished: dto.isPublished }),
      },
      include: { questions: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  async deleteQuiz(instructorId: string, quizId: string) {
    await this.assertInstructorOwnsQuiz(instructorId, quizId);
    await this.db.quiz.delete({ where: { id: quizId } });
    return { message: 'Quiz deleted' };
  }

  // ── Instructor: manage questions ──────────────────────────────────────────

  async addQuestion(instructorId: string, quizId: string, dto: CreateQuestionDto) {
    await this.assertInstructorOwnsQuiz(instructorId, quizId);
    this.validateQuestion(dto);

    return this.db.quizQuestion.create({
      data: {
        quizId,
        questionText:  dto.questionText,
        questionType:  dto.questionType,
        options:       dto.options ?? null,
        correctAnswer: dto.correctAnswer,
        explanation:   dto.explanation,
        points:        dto.points ?? 1,
        sortOrder:     dto.sortOrder ?? 0,
      },
    });
  }

  async updateQuestion(instructorId: string, questionId: string, dto: Partial<CreateQuestionDto>) {
    const question = await this.db.quizQuestion.findUnique({
      where: { id: questionId },
      include: { quiz: { include: { lesson: { include: { section: { include: { course: true } } } } } } },
    });
    if (!question) throw new NotFoundException('Question not found');
    if (question.quiz.lesson.section.course.instructorId !== instructorId) {
      throw new ForbiddenException('Not your quiz');
    }

    return this.db.quizQuestion.update({
      where: { id: questionId },
      data: {
        ...(dto.questionText  !== undefined && { questionText: dto.questionText }),
        ...(dto.questionType  !== undefined && { questionType: dto.questionType }),
        ...(dto.options       !== undefined && { options: dto.options }),
        ...(dto.correctAnswer !== undefined && { correctAnswer: dto.correctAnswer }),
        ...(dto.explanation   !== undefined && { explanation: dto.explanation }),
        ...(dto.points        !== undefined && { points: dto.points }),
        ...(dto.sortOrder     !== undefined && { sortOrder: dto.sortOrder }),
      },
    });
  }

  async deleteQuestion(instructorId: string, questionId: string) {
    const question = await this.db.quizQuestion.findUnique({
      where: { id: questionId },
      include: { quiz: { include: { lesson: { include: { section: { include: { course: true } } } } } } },
    });
    if (!question) throw new NotFoundException('Question not found');
    if (question.quiz.lesson.section.course.instructorId !== instructorId) {
      throw new ForbiddenException('Not your quiz');
    }
    await this.db.quizQuestion.delete({ where: { id: questionId } });
    return { message: 'Question deleted' };
  }

  // ── Student / Public: get quiz for a lesson ───────────────────────────────

  async getQuizByLesson(lessonId: string, userId: string) {
    // Resolve instructor ownership via the typed Prisma client — same pattern
    // used by assertInstructorOwnsLesson, so we know this path works.
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { section: { include: { course: { select: { instructorId: true } } } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');

    const isInstructor = lesson.section.course.instructorId === userId;

    const quiz = await this.db.quiz.findUnique({
      where: { lessonId },
      include: {
        questions: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { attempts: true } },
      },
    });

    if (!quiz) throw new NotFoundException('No quiz found for this lesson');

    if (!quiz.isPublished && !isInstructor) {
      throw new BadRequestException('Quiz is not yet published');
    }

    // Students never see correct answers or explanations before submitting
    const questions = isInstructor
      ? quiz.questions
      : quiz.questions.map(({ correctAnswer, explanation, ...q }: any) => q);

    const best = isInstructor ? null : await this.db.quizAttempt.findFirst({
      where:   { quizId: quiz.id, userId, isPassed: true },
      orderBy: { score: 'desc' },
    });

    return { quiz: { ...quiz, questions }, isInstructor, bestPassing: best ?? null };
  }

  // ── Student: start attempt ────────────────────────────────────────────────

  async startAttempt(quizId: string, userId: string, enrollmentId?: string) {
    const quiz = await this.db.quiz.findUnique({ where: { id: quizId } });
    if (!quiz || !quiz.isPublished) throw new NotFoundException('Quiz not found');

    // Allow unlimited retries
    const attempt = await this.db.quizAttempt.create({
      data: { quizId, userId, enrollmentId: enrollmentId ?? null },
    });

    const questions = await this.db.quizQuestion.findMany({
      where:   { quizId },
      orderBy: { sortOrder: 'asc' },
      select:  { id: true, questionText: true, questionType: true, options: true, points: true },
    });

    return { attempt: { id: attempt.id, startedAt: attempt.startedAt }, questions, quiz };
  }

  // ── Student: submit attempt ───────────────────────────────────────────────

  async submitAttempt(attemptId: string, userId: string, dto: SubmitQuizDto) {
    const attempt = await this.db.quizAttempt.findUnique({
      where: { id: attemptId },
      include: { quiz: { include: { questions: true } } },
    });

    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.userId !== userId) throw new ForbiddenException('Not your attempt');
    if (attempt.completedAt) throw new BadRequestException('Attempt already submitted');

    const questions: any[] = attempt.quiz.questions;
    let totalPoints = 0;
    let earnedPoints = 0;
    const answerData: any[] = [];

    for (const question of questions) {
      totalPoints += question.points;
      const submitted = dto.answers.find(a => a.questionId === question.id);
      const userAnswer = submitted?.answer ?? '';
      const isCorrect  = this.checkAnswer(question, userAnswer);
      const pts        = isCorrect ? question.points : 0;
      earnedPoints    += pts;
      answerData.push({
        attemptId,
        questionId:   question.id,
        answer:       userAnswer,
        isCorrect,
        pointsEarned: pts,
      });
    }

    const score    = totalPoints > 0 ? (earnedPoints / totalPoints) * 100 : 0;
    const isPassed = score >= attempt.quiz.passingScore;

    await this.db.$transaction([
      this.db.quizAnswer.createMany({ data: answerData }),
      this.db.quizAttempt.update({
        where: { id: attemptId },
        data: {
          score:       score,
          isPassed,
          timeSpent:   dto.timeSpent,
          completedAt: new Date(),
        },
      }),
    ]);

    const fullAnswers = await this.db.quizAnswer.findMany({
      where: { attemptId },
      include: {
        question: {
          select: { questionText: true, correctAnswer: true, explanation: true },
        },
      },
    });

    return {
      score:       Math.round(score * 10) / 10,
      isPassed,
      earnedPoints,
      totalPoints,
      passingScore: attempt.quiz.passingScore,
      answers:     fullAnswers,
    };
  }

  // ── Student: get attempt history ──────────────────────────────────────────

  async getMyAttempts(quizId: string, userId: string) {
    const attempts = await this.db.quizAttempt.findMany({
      where:   { quizId, userId },
      orderBy: { startedAt: 'desc' },
      select:  { id: true, score: true, isPassed: true, startedAt: true, completedAt: true, timeSpent: true },
    });
    return { attempts, total: attempts.length };
  }

  // ── Instructor: get quiz results ──────────────────────────────────────────

  async getQuizResults(instructorId: string, quizId: string, pagination: PaginationDto) {
    await this.assertInstructorOwnsQuiz(instructorId, quizId);
    const { page = 1, limit = 20, skip = 0 } = pagination;

    const [attempts, total] = await Promise.all([
      this.db.quizAttempt.findMany({
        where:   { quizId, completedAt: { not: null } },
        skip,
        take:    limit,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
        orderBy: { completedAt: 'desc' },
      }),
      this.db.quizAttempt.count({ where: { quizId, completedAt: { not: null } } }),
    ]);

    const stats = await this.db.quizAttempt.aggregate({
      where:  { quizId, completedAt: { not: null } },
      _avg:   { score: true },
      _count: { id: true },
    });

    const passCount = await this.db.quizAttempt.count({ where: { quizId, isPassed: true } });

    return {
      attempts,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      stats: {
        averageScore:  Math.round((Number(stats._avg.score) || 0) * 10) / 10,
        totalAttempts: stats._count.id,
        passRate:      stats._count.id > 0 ? Math.round((passCount / stats._count.id) * 100) : 0,
      },
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private checkAnswer(question: any, userAnswer: string): boolean {
    const correct = question.correctAnswer.trim().toLowerCase();
    const user    = userAnswer.trim().toLowerCase();
    if (question.questionType === 'short_answer') {
      return user.includes(correct) || correct.includes(user);
    }
    return correct === user;
  }

  private validateQuestion(dto: CreateQuestionDto) {
    if (dto.questionType === 'multiple_choice' && (!dto.options || dto.options.length < 2)) {
      throw new BadRequestException('Multiple choice questions need at least 2 options');
    }
    if (dto.questionType === 'true_false' && !['true', 'false'].includes(dto.correctAnswer.toLowerCase())) {
      throw new BadRequestException('True/false correct answer must be "true" or "false"');
    }
  }

  private async assertInstructorOwnsLesson(instructorId: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { section: { include: { course: { select: { instructorId: true } } } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.section.course.instructorId !== instructorId) {
      throw new ForbiddenException('You do not own this lesson');
    }
  }

  private async assertInstructorOwnsQuiz(instructorId: string, quizId: string) {
    const quiz = await this.db.quiz.findUnique({
      where: { id: quizId },
      include: { lesson: { include: { section: { include: { course: { select: { instructorId: true } } } } } } },
    });
    if (!quiz) throw new NotFoundException('Quiz not found');
    if (quiz.lesson.section.course.instructorId !== instructorId) {
      throw new ForbiddenException('You do not own this quiz');
    }
    return quiz;
  }
}
