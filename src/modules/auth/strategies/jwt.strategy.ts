import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret'),
    });
  }

  async validate(payload: any) {
    console.log('---------- [JWT] Token received — sub:', payload?.sub, '| exp:', payload?.exp ? new Date(payload.exp * 1000).toISOString() : 'none');

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        instructorProfile: true,
        studentProfile: true,
      },
    });

    console.log('---------- [JWT] User lookup result:', user ? `FOUND (id=${user.id}, active=${user.isActive})` : 'NOT FOUND');

    if (!user || !user.isActive) {
      console.log('---------- [JWT] REJECTED — user not found or inactive');
      throw new UnauthorizedException('Invalid token');
    }

    return user;
  }
}
