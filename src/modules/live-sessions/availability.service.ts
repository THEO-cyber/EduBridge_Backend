import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateAvailabilitySlotDto, UpdateAvailabilitySlotDto } from './dto/availability.dto';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Instructor: create a weekly availability slot ─────────────────────────

  async createSlot(instructorUserId: string, dto: CreateAvailabilitySlotDto) {
    const profile = await this.getProfile(instructorUserId);
    this.validateTimeRange(dto.startTime, dto.endTime);

    const slot = await this.prisma.availabilitySlot.create({
      data: {
        instructorId:    profile.id,
        dayOfWeek:       dto.dayOfWeek,
        startTime:       dto.startTime,
        endTime:         dto.endTime,
        timezone:        dto.timezone,
        sessionDuration: dto.sessionDuration,
        maxStudents:     dto.maxStudents ?? 1,
        isActive:        dto.isActive   ?? true,
      },
    });

    this.logger.log(`Slot created for instructor ${instructorUserId}: ${DAY_NAMES[dto.dayOfWeek]} ${dto.startTime}-${dto.endTime}`);
    return slot;
  }

  // ── Instructor: get own slots ─────────────────────────────────────────────

  async getMySlots(instructorUserId: string) {
    const profile = await this.getProfile(instructorUserId);

    const slots = await this.prisma.availabilitySlot.findMany({
      where: { instructorId: profile.id },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    return { slots, total: slots.length };
  }

  // ── Public/Student: get instructor's active slots ─────────────────────────

  async getInstructorSlots(instructorUserId: string) {
    const profile = await this.prisma.instructorProfile.findUnique({
      where: { userId: instructorUserId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    });

    if (!profile) throw new NotFoundException('Instructor not found');

    const slots = await this.prisma.availabilitySlot.findMany({
      where: { instructorId: profile.id, isActive: true },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    // Group by day for convenient frontend rendering
    const byDay: Record<string, typeof slots> = {};
    for (const slot of slots) {
      const day = DAY_NAMES[slot.dayOfWeek];
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(slot);
    }

    return {
      instructor: {
        id:        profile.user.id,
        firstName: profile.user.firstName,
        lastName:  profile.user.lastName,
        avatar:    profile.user.avatar,
        hourlyRate:            Number(profile.hourlyRate ?? 0),
        isAvailableForSessions: profile.isAvailableForSessions,
      },
      availability: byDay,
      slots,
    };
  }

  // ── Instructor: update a slot ─────────────────────────────────────────────

  async updateSlot(instructorUserId: string, slotId: string, dto: UpdateAvailabilitySlotDto) {
    const slot = await this.assertOwner(instructorUserId, slotId);

    if (dto.startTime && dto.endTime) this.validateTimeRange(dto.startTime, dto.endTime);
    else if (dto.startTime) this.validateTimeRange(dto.startTime, slot.endTime);
    else if (dto.endTime)   this.validateTimeRange(slot.startTime, dto.endTime);

    return this.prisma.availabilitySlot.update({
      where: { id: slotId },
      data: {
        ...(dto.startTime       !== undefined && { startTime: dto.startTime }),
        ...(dto.endTime         !== undefined && { endTime: dto.endTime }),
        ...(dto.timezone        !== undefined && { timezone: dto.timezone }),
        ...(dto.sessionDuration !== undefined && { sessionDuration: dto.sessionDuration }),
        ...(dto.maxStudents     !== undefined && { maxStudents: dto.maxStudents }),
        ...(dto.isActive        !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  // ── Instructor: delete a slot ─────────────────────────────────────────────

  async deleteSlot(instructorUserId: string, slotId: string) {
    await this.assertOwner(instructorUserId, slotId);
    await this.prisma.availabilitySlot.delete({ where: { id: slotId } });
    return { message: 'Availability slot deleted' };
  }

  // ── Instructor: bulk replace all slots for a day ──────────────────────────

  async replaceDaySlots(instructorUserId: string, dayOfWeek: number, slots: CreateAvailabilitySlotDto[]) {
    const profile = await this.getProfile(instructorUserId);

    for (const s of slots) this.validateTimeRange(s.startTime, s.endTime);

    await this.prisma.$transaction([
      this.prisma.availabilitySlot.deleteMany({
        where: { instructorId: profile.id, dayOfWeek },
      }),
      this.prisma.availabilitySlot.createMany({
        data: slots.map(s => ({
          instructorId:    profile.id,
          dayOfWeek,
          startTime:       s.startTime,
          endTime:         s.endTime,
          timezone:        s.timezone,
          sessionDuration: s.sessionDuration,
          maxStudents:     s.maxStudents ?? 1,
          isActive:        s.isActive    ?? true,
        })),
      }),
    ]);

    return this.prisma.availabilitySlot.findMany({
      where: { instructorId: profile.id, dayOfWeek },
      orderBy: { startTime: 'asc' },
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async getProfile(instructorUserId: string) {
    const profile = await this.prisma.instructorProfile.findUnique({
      where: { userId: instructorUserId },
    });
    if (!profile) throw new NotFoundException('Instructor profile not found');
    return profile;
  }

  private async assertOwner(instructorUserId: string, slotId: string) {
    const profile = await this.getProfile(instructorUserId);
    const slot = await this.prisma.availabilitySlot.findUnique({ where: { id: slotId } });
    if (!slot) throw new NotFoundException('Availability slot not found');
    if (slot.instructorId !== profile.id) throw new ForbiddenException('Not your slot');
    return slot;
  }

  private validateTimeRange(start: string, end: string) {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    if (sh * 60 + sm >= eh * 60 + em) {
      throw new BadRequestException('startTime must be earlier than endTime');
    }
  }
}
