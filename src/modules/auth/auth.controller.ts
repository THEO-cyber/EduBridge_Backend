import {
  Controller, Post, Get, Body, Query, UseGuards,
  UnauthorizedException, Req, Res, HttpCode, HttpStatus,
} from '@nestjs/common';
// Req kept for Google OAuth callback
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength, Length } from 'class-validator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '@prisma/client';

class GoogleAuthGuard extends AuthGuard('google') {
  getAuthenticateOptions() {
    return { session: false };
  }
}

class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

class VerifyResetOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

class ResetPasswordDto {
  @IsEmail()
  email!: string;

  @IsString()
  resetToken!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}

class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}

class TotpDto {
  @IsString()
  @Length(6, 6)
  totpCode!: string;
}

class Verify2FaDto {
  @IsString()
  tempToken!: string;

  @IsString()
  @Length(6, 6)
  totpCode!: string;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── Register / Login ──────────────────────────────────────────────────────

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a new user (student or instructor)' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Login with email + password' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // ── Token refresh / logout ────────────────────────────────────────────────

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange refresh token for new access token' })
  async refresh(@Body('refreshToken') refreshToken: string) {
    if (!refreshToken) throw new UnauthorizedException('Refresh token required');
    return this.authService.refreshToken(refreshToken);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout (invalidate refresh token)' })
  async logout(@CurrentUser() user: User) {
    return this.authService.logout(user.id);
  }

  // ── Current user ──────────────────────────────────────────────────────────

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiOperation({ summary: 'Get authenticated user profile' })
  async me(@CurrentUser() user: User) {
    return this.authService.getCurrentUser(user.id);
  }

  // ── Email verification ────────────────────────────────────────────────────

  @Public()
  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email address via token from email link' })
  @ApiQuery({ name: 'token', type: String })
  async verifyEmail(@Query('token') token: string) {
    return this.authService.verifyEmail(token);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resend email verification link' })
  async resendVerification(@CurrentUser() user: User) {
    return this.authService.resendVerificationEmail(user.id);
  }

  // ── Password reset ────────────────────────────────────────────────────────

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request password reset email' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Public()
  @Post('verify-reset-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify 6-digit OTP — returns a resetToken to use in /reset-password' })
  async verifyResetOtp(@Body() dto: VerifyResetOtpDto) {
    return this.authService.verifyResetOtp(dto.email, dto.code);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Reset password using the resetToken from /verify-reset-otp' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.email, dto.resetToken, dto.newPassword);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password (authenticated users)' })
  async changePassword(@CurrentUser() user: User, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  // ── Two-Factor Authentication ─────────────────────────────────────────────

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate 2FA secret + OTPAuth URI for QR code' })
  async enable2FA(@CurrentUser() user: User) {
    return this.authService.enable2FA(user.id);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Post('2fa/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm 2FA setup by verifying the first TOTP code' })
  async confirm2FA(@CurrentUser() user: User, @Body() dto: TotpDto) {
    return this.authService.confirm2FA(user.id, dto.totpCode);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable 2FA (requires current TOTP code)' })
  async disable2FA(@CurrentUser() user: User, @Body() dto: TotpDto) {
    return this.authService.disable2FA(user.id, dto.totpCode);
  }

  @Public()
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Complete login when 2FA is enabled (exchange tempToken + TOTP for real tokens)' })
  async verify2FA(@Body() dto: Verify2FaDto) {
    return this.authService.verifyTwoFactor(dto.tempToken, dto.totpCode);
  }

  // ── Google OAuth ──────────────────────────────────────────────────────────

  @Public()
  @Post('google/mobile')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Google Sign-In for mobile (exchange Google ID token for JWT)' })
  async googleMobileAuth(@Body('idToken') idToken: string) {
    if (!idToken) throw new UnauthorizedException('idToken is required');
    return this.authService.googleMobileLogin(idToken);
  }

  @Public()
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Redirect to Google OAuth login page' })
  googleAuth() {
    // Passport redirects — body never reached
  }

  @Public()
  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Google OAuth callback — returns JWT tokens' })
  async googleCallback(@Req() req: any, @Res() res: any) {
    const result = await this.authService.googleLogin(req.user);
    // For mobile/SPA apps, redirect with tokens in query params
    // In production, use a short-lived code instead of tokens in URL
    const frontendUrl = process.env.FRONTEND_URL?.split(',')[0] ?? 'http://localhost:3000';
    const params = new URLSearchParams({
      accessToken:  result.accessToken,
      refreshToken: result.refreshToken,
    });
    res.redirect(`${frontendUrl}/auth/google/success?${params.toString()}`);
  }
}
