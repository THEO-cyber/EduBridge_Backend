import { Type } from 'class-transformer';
import { IsOptional, IsPositive, Max } from 'class-validator';

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsPositive()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsPositive()
  @Max(100)
  limit?: number = 20;

  get skip(): number {
    const pageValue = this.page || 1;
    const limitValue = this.limit || 20;
    return (pageValue - 1) * limitValue;
  }
}
