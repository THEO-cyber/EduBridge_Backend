import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { CreateSystemSettingDto, UpdateSystemSettingDto } from './dto/system-settings.dto';

const CACHE_TTL = 60; // 60 seconds

@Injectable()
export class SystemSettingsService {
  private readonly logger = new Logger(SystemSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async listAll() {
    return this.prisma.systemSettings.findMany({
      orderBy: { key: 'asc' },
    });
  }

  async listPublic() {
    const cacheKey = 'system:settings:public';
    const cached = await this.cache.get<any>(cacheKey);
    if (cached) return cached;

    const settings = await this.prisma.systemSettings.findMany({
      where: { isPublic: true },
      select: { key: true, value: true },
      orderBy: { key: 'asc' },
    });

    const result = { settings };
    await this.cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }

  async getByKey(key: string) {
    const setting = await this.prisma.systemSettings.findUnique({ where: { key } });
    if (!setting) throw new NotFoundException(`Setting "${key}" not found`);
    return setting;
  }

  async getValue(key: string, defaultValue?: string): Promise<string | undefined> {
    const cacheKey = `system:setting:${key}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached !== null && cached !== undefined) return cached;

    const setting = await this.prisma.systemSettings.findUnique({ where: { key } });
    const value = setting?.value ?? defaultValue;
    if (value !== undefined) await this.cache.set(cacheKey, value, CACHE_TTL);
    return value;
  }

  async create(dto: CreateSystemSettingDto) {
    const existing = await this.prisma.systemSettings.findUnique({ where: { key: dto.key } });
    if (existing) throw new ConflictException(`Setting "${dto.key}" already exists`);

    const setting = await this.prisma.systemSettings.create({
      data: {
        key:         dto.key,
        value:       dto.value,
        description: dto.description,
        isPublic:    dto.isPublic ?? false,
      },
    });

    await this.invalidateCache(dto.key);
    this.logger.log(`System setting created: ${dto.key}`);
    return setting;
  }

  async update(key: string, dto: UpdateSystemSettingDto) {
    const existing = await this.prisma.systemSettings.findUnique({ where: { key } });
    if (!existing) throw new NotFoundException(`Setting "${key}" not found`);

    const updated = await this.prisma.systemSettings.update({
      where: { key },
      data: {
        value:       dto.value,
        description: dto.description ?? existing.description,
        isPublic:    dto.isPublic    ?? existing.isPublic,
      },
    });

    await this.invalidateCache(key);
    this.logger.log(`System setting updated: ${key} = ${dto.value}`);
    return updated;
  }

  async delete(key: string) {
    const existing = await this.prisma.systemSettings.findUnique({ where: { key } });
    if (!existing) throw new NotFoundException(`Setting "${key}" not found`);

    await this.prisma.systemSettings.delete({ where: { key } });
    await this.invalidateCache(key);
    this.logger.log(`System setting deleted: ${key}`);
    return { message: `Setting "${key}" deleted` };
  }

  async bulkUpsert(settings: Array<{ key: string; value: string }>) {
    await Promise.all(
      settings.map(({ key, value }) =>
        this.prisma.systemSettings.upsert({
          where:  { key },
          update: { value },
          create: { key, value },
        }),
      ),
    );
    await Promise.all(settings.map(({ key }) => this.invalidateCache(key)));
    return { updated: settings.length };
  }

  private async invalidateCache(key: string) {
    await Promise.all([
      this.cache.del(`system:setting:${key}`),
      this.cache.del('system:settings:public'),
    ]);
  }
}
