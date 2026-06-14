import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { CertificatesService } from './certificates.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { User } from '@prisma/client';

@ApiTags('Certificates')
@Controller('certificates')
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Get()
  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List all my certificates' })
  getMyCertificates(@CurrentUser() user: User) {
    return this.certificatesService.getUserCertificates(user.id);
  }

  @Get(':id')
  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get a specific certificate with course info' })
  getCertificate(@Param('id') id: string, @CurrentUser() user: User) {
    return this.certificatesService.getCertificate(id, user.id);
  }

  @Get(':id/download')
  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get a signed PDF download URL' })
  async download(@Param('id') id: string, @CurrentUser() user: User) {
    const url = await this.certificatesService.getDownloadUrl(id, user.id);
    return { url };
  }

  @Public()
  @Get('verify/:certNumber')
  @ApiOperation({ summary: 'Publicly verify a certificate by its number' })
  verify(@Param('certNumber') certNumber: string) {
    return this.certificatesService.getCertificateByNumber(certNumber);
  }
}
