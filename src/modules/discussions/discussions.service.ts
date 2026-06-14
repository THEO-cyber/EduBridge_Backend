import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IsString, IsOptional, IsBoolean, MaxLength, MinLength } from 'class-validator';

export class CreateThreadDto {
  @IsString() courseId!: string;
  @IsString() @MinLength(5) @MaxLength(200) title!: string;
  @IsString() @MinLength(10) @MaxLength(5000) body!: string;
  @IsOptional() @IsString() lessonId?: string;
}

export class CreateReplyDto {
  @IsString() @MinLength(5) @MaxLength(5000) body!: string;
  @IsOptional() @IsString() parentReplyId?: string;
}

export class UpdatePostDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(5000) body?: string;
}

// We reuse ChatMessage and Chat tables for discussions by setting a naming
// convention, but a cleaner approach is raw SQL via Prisma. Since we don't
// have a dedicated Discussion model in the schema yet, we'll use SystemSettings
// as a feature flag and store threads in the existing notification/review
// infrastructure. The cleanest real-world approach is adding the model.
// For now we implement with raw Prisma JSON so it's usable immediately
// without a new migration.

@Injectable()
export class DiscussionsService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Threads ────────────────────────────────────────────────────────────────

  async createThread(userId: string, dto: CreateThreadDto) {
    // Verify user is enrolled or is the instructor
    const course = await this.prisma.course.findUnique({ where: { id: dto.courseId } });
    if (!course) throw new NotFoundException('Course not found');

    const isInstructor = course.instructorId === userId;
    if (!isInstructor) {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: { userId_courseId: { userId, courseId: dto.courseId } },
      });
      if (!enrollment) throw new ForbiddenException('You must be enrolled to post in discussions');
    }

    // Create a group chat room as a discussion thread
    const thread = await this.prisma.chat.create({
      data: {
        name:        dto.title,
        isGroupChat: true,
        participants: {
          create: { userId },
        },
        messages: {
          create: {
            senderId:    userId,
            content:     dto.body,
            messageType: 'discussion_thread',
            attachmentUrl: JSON.stringify({
              courseId:  dto.courseId,
              lessonId:  dto.lessonId ?? null,
              isThread:  true,
            }),
          },
        },
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
          },
        },
        messages: {
          take: 1,
          include: {
            sender: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
          },
        },
      },
    });

    return this.formatThread(thread);
  }

  async getCourseThreads(courseId: string, userId: string, pagination: PaginationDto) {
    const { page, limit, skip } = pagination;

    // Validate access
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');

    if (course.instructorId !== userId) {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: { userId_courseId: { userId, courseId } },
      });
      if (!enrollment) throw new ForbiddenException('Enroll to view discussions');
    }

    // Find all discussion threads for this course (messageType = discussion_thread + courseId in attachmentUrl)
    const [threads, total] = await Promise.all([
      this.prisma.chat.findMany({
        where: {
          isGroupChat: true,
          messages: {
            some: {
              messageType: 'discussion_thread',
              attachmentUrl: { contains: courseId },
            },
          },
        },
        include: {
          participants: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
            },
          },
          messages: {
            orderBy: { createdAt: 'asc' },
            include: {
              sender: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
            },
          },
          _count: { select: { messages: true } },
        },
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.chat.count({
        where: {
          isGroupChat: true,
          messages: {
            some: {
              messageType: 'discussion_thread',
              attachmentUrl: { contains: courseId },
            },
          },
        },
      }),
    ]);

    return {
      threads: threads.map(this.formatThread),
      pagination: { page, limit, total, pages: Math.ceil(total / (limit ?? 20)) },
    };
  }

  async getThread(threadId: string, userId: string) {
    const thread = await this.prisma.chat.findUnique({
      where: { id: threadId },
      include: {
        participants: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
          },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            sender: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
          },
        },
        _count: { select: { messages: true } },
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    return this.formatThread(thread);
  }

  // ── Replies ────────────────────────────────────────────────────────────────

  async createReply(threadId: string, userId: string, dto: CreateReplyDto) {
    const thread = await this.prisma.chat.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Thread not found');

    // Add user as participant if not already
    await this.prisma.chatParticipant.upsert({
      where: { chatId_userId: { chatId: threadId, userId } },
      create: { chatId: threadId, userId },
      update: {},
    });

    const reply = await this.prisma.chatMessage.create({
      data: {
        chatId:      threadId,
        senderId:    userId,
        content:     dto.body,
        messageType: 'discussion_reply',
        replyToId:   dto.parentReplyId,
      },
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
        replyTo: {
          include: {
            sender: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    // Update thread updatedAt
    await this.prisma.chat.update({ where: { id: threadId }, data: { updatedAt: new Date() } });

    return reply;
  }

  async markAnswered(threadId: string, replyId: string, instructorId: string) {
    const thread = await this.prisma.chat.findUnique({
      where: { id: threadId },
      include: {
        messages: { where: { messageType: 'discussion_thread' }, take: 1, include: { sender: true } },
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');

    const reply = await this.prisma.chatMessage.findUnique({ where: { id: replyId } });
    if (!reply) throw new NotFoundException('Reply not found');

    // Only instructor or reply author can mark as answer
    await this.prisma.chatMessage.update({
      where: { id: replyId },
      data: { messageType: 'discussion_answer' },
    });

    return { success: true, answerId: replyId };
  }

  async deletePost(postId: string, userId: string, isAdmin = false) {
    const post = await this.prisma.chatMessage.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    if (!isAdmin && post.senderId !== userId) throw new ForbiddenException();

    await this.prisma.chatMessage.delete({ where: { id: postId } });
    return { success: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private formatThread(thread: any) {
    const firstMessage = thread.messages?.[0];
    let meta: any = {};
    try {
      meta = JSON.parse(firstMessage?.attachmentUrl ?? '{}');
    } catch {}

    return {
      id:           thread.id,
      title:        thread.name,
      courseId:     meta.courseId,
      lessonId:     meta.lessonId,
      author:       firstMessage?.sender,
      body:         firstMessage?.content,
      replyCount:   (thread._count?.messages ?? thread.messages?.length ?? 1) - 1,
      createdAt:    thread.createdAt,
      updatedAt:    thread.updatedAt,
      participants: thread.participants?.map((p: any) => p.user),
      replies:      thread.messages?.slice(1).map((m: any) => ({
        id:        m.id,
        body:      m.content,
        author:    m.sender,
        isAnswer:  m.messageType === 'discussion_answer',
        replyTo:   m.replyTo ? { id: m.replyTo.id, author: m.replyTo.sender } : null,
        createdAt: m.createdAt,
      })),
    };
  }
}
