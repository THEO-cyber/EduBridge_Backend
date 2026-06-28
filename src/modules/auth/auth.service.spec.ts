import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import { Role } from '@prisma/client';

// Mock bcryptjs at module level — CJS properties are non-configurable
jest.mock('bcryptjs', () => ({
  hash:    jest.fn().mockResolvedValue('$2a$12$hashedpassword'),
  compare: jest.fn().mockResolvedValue(true),
  genSalt: jest.fn().mockResolvedValue('salt'),
}));

import * as bcrypt from 'bcryptjs';

// ── Prisma mock ────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findFirst:  jest.fn(),
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
  },
  userAuth: {
    findUnique: jest.fn(),
    findFirst:  jest.fn(),
    update:     jest.fn(),
  },
  $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
};

const mockJwt = {
  signAsync: jest.fn().mockResolvedValue('mock-token'),
  verify:    jest.fn().mockReturnValue({ sub: 'user-1', type: '2fa_pending' }),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, string> = {
      'jwt.secret':           'test-secret',
      'jwt.refreshSecret':    'test-refresh-secret',
      'jwt.expiresIn':        '15m',
      'jwt.refreshExpiresIn': '7d',
      frontendUrl:            'http://localhost:3000',
    };
    return cfg[key] ?? null;
  }),
};

const mockEmail = {
  sendEmailVerification:  jest.fn().mockResolvedValue(undefined),
  sendPasswordResetCode:  jest.fn().mockResolvedValue(undefined),
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildUserAuth(overrides: Record<string, any> = {}) {
  return {
    userId:                     'user-1',
    passwordHash:               '$2a$12$hashedpassword',
    loginAttempts:              0,
    lockedUntil:                null,
    twoFactorEnabled:           false,
    twoFactorSecret:            null,
    refreshToken:               null,
    refreshTokenHash:           null,
    emailVerificationTokenHash: null,
    passwordResetTokenHash:     null,
    passwordResetExpires:       null,
    passwordResetCount:         0,
    passwordResetWindowStart:   null,
    googleId:                   null,
    ...overrides,
  };
}

function buildUser(overrides: Record<string, any> = {}) {
  return {
    id:              'user-1',
    email:           'test@example.com',
    username:        'testuser',
    firstName:       'Test',
    lastName:        'User',
    role:            Role.STUDENT,
    isActive:        true,
    isEmailVerified: false,
    avatar:          null,
    bio:             null,
    timezone:        'UTC',
    language:        'en',
    lastLoginAt:     null,
    createdAt:       new Date(),
    updatedAt:       new Date(),
    instructorProfile: null,
    studentProfile:    { userId: 'user-1' },
    userAuth:          buildUserAuth(),
    ...overrides,
  };
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default bcrypt behavior
    (bcrypt.hash    as jest.Mock).mockResolvedValue('$2a$12$hashedpassword');
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService,  useValue: mockPrisma },
        { provide: JwtService,     useValue: mockJwt },
        { provide: ConfigService,  useValue: mockConfig },
        { provide: EmailService,   useValue: mockEmail },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ── register ───────────────────────────────────────────────────────────────

  describe('register', () => {
    it('throws ConflictException when email already exists', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(buildUser());
      await expect(
        service.register({
          email: 'test@example.com', username: 'other', firstName: 'A',
          lastName: 'B', password: 'Password1!',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException (username) when username exists but email is different', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(
        buildUser({ email: 'other@example.com', username: 'testuser' }),
      );
      await expect(
        service.register({
          email: 'new@example.com', username: 'testuser', firstName: 'A',
          lastName: 'B', password: 'Password1!',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('hashes password with bcrypt rounds=12 before storing', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(
        buildUser({ email: 'new@example.com', firstName: 'A', lastName: 'B' }),
      );
      mockPrisma.userAuth.update.mockResolvedValue({});

      await service.register({
        email: 'new@example.com', username: 'newuser', firstName: 'A',
        lastName: 'B', password: 'Password1!',
      });

      expect(bcrypt.hash).toHaveBeenCalledWith('Password1!', 12);
    });

    it('sends verification email after registration', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(
        buildUser({ email: 'new@example.com', firstName: 'New', lastName: 'User' }),
      );
      mockPrisma.userAuth.update.mockResolvedValue({});

      await service.register({
        email: 'new@example.com', username: 'newuser', firstName: 'New',
        lastName: 'User', password: 'Password1!',
      });

      await new Promise((r) => setImmediate(r));
      expect(mockEmail.sendEmailVerification).toHaveBeenCalledWith(
        'new@example.com', 'New User', expect.any(String), 'http://localhost:3000',
      );
    });
  });

  // ── login ──────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('throws UnauthorizedException for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.login({ email: 'ghost@example.com', password: 'pw' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException for deactivated account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser({ isActive: false }));
      await expect(
        service.login({ email: 'test@example.com', password: 'pw' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('increments loginAttempts on wrong password', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      mockPrisma.userAuth.update.mockResolvedValue({});

      await expect(
        service.login({ email: 'test@example.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrisma.userAuth.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ loginAttempts: 1 }),
        }),
      );
    });

    it('locks account and sets lockedUntil after 5 failed attempts', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
      mockPrisma.user.findUnique.mockResolvedValue(
        buildUser({ userAuth: buildUserAuth({ loginAttempts: 4 }) }),
      );
      mockPrisma.userAuth.update.mockResolvedValue({});

      const err = await service.login({ email: 'test@example.com', password: 'wrong' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toContain('locked');
      expect(mockPrisma.userAuth.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            loginAttempts: 5,
            lockedUntil:   expect.any(Date),
          }),
        }),
      );
    });

    it('rejects immediately when account is locked — never calls bcrypt', async () => {
      const lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
      mockPrisma.user.findUnique.mockResolvedValue(
        buildUser({ userAuth: buildUserAuth({ loginAttempts: 5, lockedUntil }) }),
      );

      await expect(
        service.login({ email: 'test@example.com', password: 'any' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('resets loginAttempts and returns tokens on correct password', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        buildUser({ userAuth: buildUserAuth({ loginAttempts: 2 }) }),
      );
      mockPrisma.userAuth.update.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});

      const result = await service.login({ email: 'test@example.com', password: 'correct' });

      expect(mockPrisma.userAuth.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ loginAttempts: 0, lockedUntil: null }),
        }),
      );
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });

    it('returns requires2FA flag when 2FA is enabled', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        buildUser({ userAuth: buildUserAuth({ twoFactorEnabled: true, twoFactorSecret: 'SECRET' }) }),
      );
      mockPrisma.userAuth.update.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});

      const result = await service.login({ email: 'test@example.com', password: 'correct' });

      expect(result).toEqual({ requires2FA: true, tempToken: 'mock-token' });
    });
  });

  // ── forgotPassword ─────────────────────────────────────────────────────────

  describe('forgotPassword', () => {
    it('returns generic success for non-existent email (prevents enumeration)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.forgotPassword('ghost@example.com');

      expect(result.message).toContain('If that email exists');
      expect(mockPrisma.userAuth.update).not.toHaveBeenCalled();
    });

    it('sets OTP with exactly a 2-minute expiry', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      mockPrisma.userAuth.update.mockResolvedValue({});

      const before = Date.now();
      await service.forgotPassword('test@example.com');
      const after  = Date.now();

      const updateCall = mockPrisma.userAuth.update.mock.calls[0][0];
      const expires: Date = updateCall.data.passwordResetExpires;
      const expiryMs = expires.getTime();

      // 2 minutes window with 2s buffer for test execution
      expect(expiryMs).toBeGreaterThan(before + 2 * 60 * 1000 - 2000);
      expect(expiryMs).toBeLessThanOrEqual(after  + 2 * 60 * 1000 + 2000);
    });

    it('throws BadRequestException after 3 resets in a 30-day window', async () => {
      const windowStart = new Date(Date.now() - 1000);
      mockPrisma.user.findUnique.mockResolvedValue(
        buildUser({
          userAuth: buildUserAuth({
            passwordResetCount:       3,
            passwordResetWindowStart: windowStart,
          }),
        }),
      );

      await expect(service.forgotPassword('test@example.com')).rejects.toThrow(BadRequestException);
    });
  });

  // ── verifyEmail ────────────────────────────────────────────────────────────

  describe('verifyEmail', () => {
    it('throws BadRequestException for an invalid or already-used token', async () => {
      mockPrisma.userAuth.findFirst.mockResolvedValue(null);
      await expect(service.verifyEmail('bad-token')).rejects.toThrow(BadRequestException);
    });

    it('marks user as verified and clears the token', async () => {
      mockPrisma.userAuth.findFirst.mockResolvedValue(
        { ...buildUserAuth(), user: buildUser() },
      );
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);

      const result = await service.verifyEmail('valid-raw-token');
      expect(result.message).toContain('verified');
    });
  });
});
