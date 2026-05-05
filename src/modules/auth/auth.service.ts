import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Role } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(registerDto: RegisterDto) {
    // Check if user already exists
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: registerDto.email }, { username: registerDto.username }],
      },
    });

    if (existingUser) {
      throw new ConflictException(
        existingUser.email === registerDto.email
          ? 'Email already registered'
          : 'Username already taken',
      );
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(registerDto.password, 12);

    // Create user with auth record
    const user = await this.prisma.user.create({
      data: {
        email: registerDto.email,
        username: registerDto.username,
        firstName: registerDto.firstName,
        lastName: registerDto.lastName,
        bio: registerDto.bio,
        role: registerDto.role || Role.STUDENT,
        userAuth: {
          create: {
            passwordHash: hashedPassword,
          },
        },
        // Create profile based on role
        ...(registerDto.role === Role.INSTRUCTOR
          ? {
              instructorProfile: {
                create: {},
              },
            }
          : {
              studentProfile: {
                create: {},
              },
            }),
      },
      include: {
        instructorProfile: true,
        studentProfile: true,
      },
    });

    // Generate tokens
    const tokens = await this.generateTokens(user.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        avatar: user.avatar,
        bio: user.bio,
        instructorProfile: user.instructorProfile,
        studentProfile: user.studentProfile,
      },
      ...tokens,
    };
  }

  async login(loginDto: LoginDto) {
    // Find user with auth record
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
      include: {
        userAuth: true,
        instructorProfile: true,
        studentProfile: true,
      },
    });

    if (!user || !user.userAuth?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if user is active
    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(
      loginDto.password,
      user.userAuth.passwordHash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate tokens
    const tokens = await this.generateTokens(user.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        avatar: user.avatar,
        bio: user.bio,
        instructorProfile: user.instructorProfile,
        studentProfile: user.studentProfile,
      },
      ...tokens,
    };
  }

  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });

      // Check if user exists and is active
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: { userAuth: true },
      });

      if (
        !user ||
        !user.isActive ||
        user.userAuth?.refreshToken !== refreshToken
      ) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Generate new tokens
      return this.generateTokens(user.id);
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string) {
    await this.prisma.userAuth.update({
      where: { userId },
      data: { refreshToken: null },
    });

    return { message: 'Successfully logged out' };
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        instructorProfile: true,
        studentProfile: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

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
      instructorProfile: user.instructorProfile,
      studentProfile: user.studentProfile,
    };
  }

  private async generateTokens(userId: string) {
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

    // Store refresh token
    await this.prisma.userAuth.update({
      where: { userId },
      data: { refreshToken },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.configService.get<string>('jwt.expiresIn'),
    };
  }
}
