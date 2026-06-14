import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Role } from '@prisma/client';
import { generateTotpSecret, verifyTotp, buildOtpAuthUri } from '../../common/utils/totp';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  // ── Register ──────────────────────────────────────────────────────────────

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { username: dto.username }] },
    });
    if (existing) {
      throw new ConflictException(
        existing.email === dto.email ? 'Email already registered' : 'Username already taken',
      );
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    // Generate raw token, store only the hash
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        username: dto.username,
        firstName: dto.firstName,
        lastName: dto.lastName,
        bio: dto.bio,
        role: dto.role ?? Role.STUDENT,
        userAuth: {
          create: {
            passwordHash: hashedPassword,
            // new field — available after `prisma migrate dev`
            emailVerificationTokenHash: tokenHash,
          } as any,
        },
        ...(dto.role === Role.INSTRUCTOR
          ? { instructorProfile: { create: {} } }
          : { studentProfile: { create: {} } }),
      },
      include: { instructorProfile: true, studentProfile: true },
    });

    const frontendUrl = this.configService.get<string>('frontendUrl') ?? '';
    this.emailService
      .sendEmailVerification(user.email, `${user.firstName} ${user.lastName}`, rawToken, frontendUrl)
      .catch((e) => this.logger.warn(`Welcome email failed: ${e.message}`));

    const tokens = await this.generateTokens(user.id);
    return { user: this.sanitize(user), ...tokens };
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(dto: LoginDto) {
    console.log('---------- [LOGIN] Attempt for email:', dto.email);

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { userAuth: true, instructorProfile: true, studentProfile: true },
    });

    console.log('---------- [LOGIN] User found in DB:', user ? `YES (id=${user.id}, role=${user.role})` : 'NO');

    if (!user?.userAuth?.passwordHash) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account is deactivated');

    const ua = user.userAuth as any;

    // Account lockout check
    if (ua.lockedUntil && ua.lockedUntil > new Date()) {
      const remaining = Math.ceil((new Date(ua.lockedUntil).getTime() - Date.now()) / 60_000);
      throw new UnauthorizedException(
        `Account locked due to too many failed attempts. Try again in ${remaining} minute(s).`,
      );
    }

    const valid = await bcrypt.compare(dto.password, user.userAuth.passwordHash!);

    if (!valid) {
      const attempts = ((ua.loginAttempts as number) ?? 0) + 1;
      const locked = attempts >= MAX_LOGIN_ATTEMPTS;
      await this.prisma.userAuth.update({
        where: { userId: user.id },
        data: {
          loginAttempts: attempts,
          lockedUntil: locked ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
        } as any,
      });
      throw new UnauthorizedException(
        locked
          ? `Too many failed attempts. Account locked for 15 minutes.`
          : `Invalid credentials. ${MAX_LOGIN_ATTEMPTS - attempts} attempt(s) remaining.`,
      );
    }

    // Reset lockout on successful login
    await this.prisma.userAuth.update({
      where: { userId: user.id },
      data: { loginAttempts: 0, lockedUntil: null } as any,
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    // If 2FA is enabled, return a short-lived temp token instead of full access
    if (ua.twoFactorEnabled) {
      console.log('---------- [LOGIN] 2FA required for user:', user.id);
      const tempToken = await this.jwtService.signAsync(
        { sub: user.id, type: '2fa_pending' },
        { secret: this.configService.get<string>('jwt.secret'), expiresIn: '5m' },
      );
      return { requires2FA: true, tempToken };
    }

    const tokens = await this.generateTokens(user.id);
    console.log('---------- [LOGIN] Success — tokens generated for user:', user.id);
    console.log('---------- [LOGIN] Response keys:', Object.keys({ user: this.sanitize(user), ...tokens }));
    console.log('---------- [LOGIN] accessToken (first 20 chars):', tokens.accessToken?.slice(0, 20) + '...');
    return { user: this.sanitize(user), ...tokens };
  }

  // ── Email verification ────────────────────────────────────────────────────

  async verifyEmail(token: string) {
    const tokenHash = sha256(token);
    const userAuth = await this.prisma.userAuth.findFirst({
      where: { emailVerificationTokenHash: tokenHash } as any,
      include: { user: true },
    });

    if (!userAuth) throw new BadRequestException('Invalid or expired verification link');

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userAuth.userId },
        data: { isEmailVerified: true },
      }),
      this.prisma.userAuth.update({
        where: { userId: userAuth.userId },
        data: { emailVerificationTokenHash: null } as any,
      }),
    ]);

    return { message: 'Email verified successfully' };
  }

  async resendVerificationEmail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { userAuth: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.isEmailVerified) throw new BadRequestException('Email already verified');

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    await this.prisma.userAuth.update({
      where: { userId },
      data: { emailVerificationTokenHash: tokenHash } as any,
    });

    const frontendUrl = this.configService.get<string>('frontendUrl') ?? '';
    await this.emailService.sendEmailVerification(
      user.email,
      `${user.firstName} ${user.lastName}`,
      rawToken,
      frontendUrl,
    );

    return { message: 'Verification email sent' };
  }

  // ── Password reset ────────────────────────────────────────────────────────

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { userAuth: true },
    });

    // Always return success to prevent email enumeration
    if (!user?.userAuth) return { message: 'If that email exists, a 6-digit code was sent' };

    const ua = user.userAuth as any;
    const now = Date.now();
    const windowMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    const MAX_RESETS = 3;

    // Determine current window count
    const windowStart: Date | null = ua.passwordResetWindowStart;
    const inWindow = windowStart && now - new Date(windowStart).getTime() < windowMs;
    const currentCount: number = inWindow ? (ua.passwordResetCount ?? 0) : 0;

    if (currentCount >= MAX_RESETS) {
      const resetAt = new Date(new Date(windowStart!).getTime() + windowMs);
      throw new BadRequestException(
        `Password reset limit reached (${MAX_RESETS} per 30 days). Try again after ${resetAt.toDateString()}.`,
      );
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
    const codeHash = sha256(code);
    const expires = new Date(now + 30 * 1000); // 30 seconds

    await this.prisma.userAuth.update({
      where: { userId: user.id },
      data: {
        passwordResetTokenHash: codeHash,
        passwordResetToken: null,
        passwordResetExpires: expires,
        // Start a new window if the previous one expired or never started
        passwordResetWindowStart: inWindow ? windowStart : new Date(now),
        passwordResetCount: currentCount, // incremented only on successful reset (step 3)
      } as any,
    });

    await this.emailService
      .sendPasswordResetCode(user.email, `${user.firstName} ${user.lastName}`, code)
      .catch((e) => this.logger.warn(`Reset email failed: ${e.message}`));

    if (process.env.NODE_ENV !== 'production') {
      this.logger.warn(`[DEV] Password reset code for ${email}: ${code}`);
    }

    return { message: 'If that email exists, a 6-digit code was sent' };
  }

  async verifyResetOtp(email: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { userAuth: true },
    });

    if (!user?.userAuth) throw new BadRequestException('Invalid or expired code');

    const codeHash = sha256(code);
    const ua = user.userAuth as any;

    const isValid =
      ua.passwordResetTokenHash === codeHash &&
      ua.passwordResetExpires &&
      new Date(ua.passwordResetExpires) > new Date();

    if (!isValid) throw new BadRequestException('Invalid or expired code');

    // OTP verified — exchange for a short-lived reset token (15 min)
    const rawResetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = sha256(rawResetToken);
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    await this.prisma.userAuth.update({
      where: { userId: user.id },
      data: {
        passwordResetTokenHash: resetTokenHash,
        passwordResetExpires: expires,
      } as any,
    });

    return {
      resetToken: rawResetToken,
      message: 'OTP verified. Use the resetToken to set your new password.',
    };
  }

  async resetPassword(email: string, resetToken: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { userAuth: true },
    });

    if (!user?.userAuth) throw new BadRequestException('Invalid or expired reset token');

    const tokenHash = sha256(resetToken);
    const ua = user.userAuth as any;

    const isValid =
      ua.passwordResetTokenHash === tokenHash &&
      ua.passwordResetExpires &&
      new Date(ua.passwordResetExpires) > new Date();

    if (!isValid) throw new BadRequestException('Invalid or expired reset token');

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    const ua2 = user.userAuth as any;
    const windowMs = 30 * 24 * 60 * 60 * 1000;
    const windowStart: Date | null = ua2.passwordResetWindowStart;
    const inWindow = windowStart && Date.now() - new Date(windowStart).getTime() < windowMs;
    const newCount = (inWindow ? (ua2.passwordResetCount ?? 0) : 0) + 1;

    await this.prisma.userAuth.update({
      where: { userId: user.id },
      data: {
        passwordHash: hashedPassword,
        passwordResetToken: null,
        passwordResetTokenHash: null,
        passwordResetExpires: null,
        refreshToken: null,
        refreshTokenHash: null,
        loginAttempts: 0,
        lockedUntil: null,
        passwordResetCount: newCount,
        passwordResetWindowStart: inWindow ? windowStart : new Date(),
      } as any,
    });

    return { message: 'Password reset successfully. Please log in.' };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const userAuth = await this.prisma.userAuth.findUnique({ where: { userId } });
    if (!userAuth?.passwordHash) throw new BadRequestException('No password set');

    const valid = await bcrypt.compare(currentPassword, userAuth.passwordHash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.userAuth.update({
      where: { userId },
      data: { passwordHash: hashed, refreshToken: null, refreshTokenHash: null } as any,
    });

    return { message: 'Password changed successfully. Please log in again.' };
  }

  // ── Google OAuth ──────────────────────────────────────────────────────────

  async googleLogin(googleUser: {
    googleId: string;
    email: string;
    firstName: string;
    lastName: string;
    avatar?: string;
  }) {
    let user = await this.prisma.user.findFirst({
      where: { userAuth: { googleId: googleUser.googleId } },
      include: { userAuth: true, instructorProfile: true, studentProfile: true },
    });

    if (!user) {
      const existingByEmail = await this.prisma.user.findUnique({
        where: { email: googleUser.email },
        include: { userAuth: true, instructorProfile: true, studentProfile: true },
      });

      if (existingByEmail) {
        await this.prisma.userAuth.update({
          where: { userId: existingByEmail.id },
          data: { googleId: googleUser.googleId },
        });
        user = existingByEmail;
      } else {
        const username = await this.generateUniqueUsername(
          `${googleUser.firstName}${googleUser.lastName}`.toLowerCase().replace(/\s+/g, ''),
        );

        user = await this.prisma.user.create({
          data: {
            email: googleUser.email,
            username,
            firstName: googleUser.firstName,
            lastName: googleUser.lastName,
            avatar: googleUser.avatar,
            isEmailVerified: true,
            role: Role.STUDENT,
            userAuth: { create: { googleId: googleUser.googleId } },
            studentProfile: { create: {} },
          },
          include: { userAuth: true, instructorProfile: true, studentProfile: true },
        });
      }
    }

    if (!user.isActive) throw new UnauthorizedException('Account is deactivated');

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const tokens = await this.generateTokens(user.id);
    return { user: this.sanitize(user), ...tokens };
  }

  // ── Token management ──────────────────────────────────────────────────────

  async refreshToken(refreshToken: string) {
    let payload: { sub: string };
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { userAuth: true },
    });

    if (!user?.isActive || !user.userAuth) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const ua2 = user.userAuth as any;
    const tokenHash2 = sha256(refreshToken);
    const legacyMatch = ua2.refreshToken === refreshToken;
    const hashMatch   = ua2.refreshTokenHash === tokenHash2;

    if (!hashMatch && !legacyMatch) {
      await this.prisma.userAuth.update({
        where: { userId: user.id },
        data: { refreshToken: null, refreshTokenHash: null } as any,
      });
      throw new UnauthorizedException('Refresh token reuse detected. Please log in again.');
    }

    return this.generateTokens(user.id);
  }

  async logout(userId: string) {
    await this.prisma.userAuth.update({
      where: { userId },
      data: { refreshToken: null, refreshTokenHash: null } as any,
    });
    return { message: 'Logged out successfully' };
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { instructorProfile: true, studentProfile: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    return this.sanitize(user);
  }

  // ── Two-Factor Authentication (TOTP) ─────────────────────────────────────

  async enable2FA(userId: string) {
    const userAuth = await this.prisma.userAuth.findUnique({ where: { userId } });
    if (!userAuth) throw new UnauthorizedException('User not found');
    if (userAuth.twoFactorEnabled) throw new BadRequestException('2FA is already enabled');

    const secret = generateTotpSecret();
    const user   = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });

    await this.prisma.userAuth.update({
      where: { userId },
      data: { twoFactorSecret: secret },
    });

    return {
      secret,
      otpAuthUri: buildOtpAuthUri(secret, user!.email),
      message:    'Scan the QR code with your authenticator app, then call /auth/2fa/confirm',
    };
  }

  async confirm2FA(userId: string, totpCode: string) {
    const userAuth = await this.prisma.userAuth.findUnique({ where: { userId } });
    if (!userAuth?.twoFactorSecret) throw new BadRequestException('2FA setup not started');
    if (userAuth.twoFactorEnabled)  throw new BadRequestException('2FA already enabled');

    if (!verifyTotp(userAuth.twoFactorSecret, totpCode)) {
      throw new BadRequestException('Invalid TOTP code');
    }

    await this.prisma.userAuth.update({
      where: { userId },
      data: { twoFactorEnabled: true },
    });

    return { message: '2FA enabled successfully' };
  }

  async disable2FA(userId: string, totpCode: string) {
    const userAuth = await this.prisma.userAuth.findUnique({ where: { userId } });
    if (!userAuth?.twoFactorEnabled || !userAuth.twoFactorSecret) {
      throw new BadRequestException('2FA is not enabled');
    }

    if (!verifyTotp(userAuth.twoFactorSecret, totpCode)) {
      throw new BadRequestException('Invalid TOTP code');
    }

    await this.prisma.userAuth.update({
      where: { userId },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });

    return { message: '2FA disabled successfully' };
  }

  async verifyTwoFactor(tempToken: string, totpCode: string) {
    let payload: { sub: string; type: string };
    try {
      payload = this.jwtService.verify(tempToken, {
        secret: this.configService.get<string>('jwt.secret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired 2FA token');
    }

    if (payload.type !== '2fa_pending') {
      throw new UnauthorizedException('Invalid token type');
    }

    const userAuth = await this.prisma.userAuth.findUnique({ where: { userId: payload.sub } });
    if (!userAuth?.twoFactorSecret) throw new UnauthorizedException('2FA not configured');

    if (!verifyTotp(userAuth.twoFactorSecret, totpCode)) {
      throw new UnauthorizedException('Invalid TOTP code');
    }

    return this.generateTokens(payload.sub);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async generateTokens(userId: string) {
    console.log('---------- [TOKENS] Generating tokens for userId:', userId);
    const payload = { sub: userId };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('jwt.secret'),
        expiresIn: this.configService.get<string>('jwt.expiresIn'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
        expiresIn: this.configService.get<string>('jwt.refreshExpiresIn'),
      }),
    ]);

    // Store only the hash; old token is immediately invalidated
    await this.prisma.userAuth.update({
      where: { userId },
      data: {
        refreshToken: null,
        refreshTokenHash: sha256(refreshToken),
      } as any,
    });

    const expiresIn = this.configService.get<string>('jwt.expiresIn');
    console.log('---------- [TOKENS] Done — accessToken length:', accessToken?.length, '| expiresIn:', expiresIn);
    return {
      accessToken,
      refreshToken,
      expiresIn,
    };
  }

  private sanitize(user: any) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      avatar: user.avatar,
      bio: user.bio,
      timezone: user.timezone,
      language: user.language,
      instructorProfile: user.instructorProfile,
      studentProfile: user.studentProfile,
    };
  }

  private async generateUniqueUsername(base: string): Promise<string> {
    let username = base.slice(0, 20);
    let attempts = 0;
    while (await this.prisma.user.findUnique({ where: { username } })) {
      username = `${base.slice(0, 16)}${Math.floor(Math.random() * 9999)}`;
      if (++attempts > 10) username = `user${crypto.randomBytes(4).toString('hex')}`;
    }
    return username;
  }
}
