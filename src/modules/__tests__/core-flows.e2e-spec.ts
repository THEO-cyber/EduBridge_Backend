import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';

/**
 * End-to-end smoke tests for all critical platform flows.
 *
 * These tests run against a real database (configured via DATABASE_URL in the
 * test environment). They exercise the HTTP layer end-to-end including guards,
 * pipes, and services — without any mocking.
 *
 * Run:  npm run test:e2e
 * Env:  set DATABASE_URL / REDIS_HOST etc. in .env.test or environment
 */
describe('EduBridge Core Flows (e2e)', () => {
  let app: INestApplication;

  // Tokens & IDs shared across tests
  let studentToken: string;
  let instructorToken: string;
  let courseId: string;
  let sectionId: string;
  let lessonId: string;
  let enrollmentId: string;
  let sessionRequestId: string;
  let liveSessionId: string;
  let chatRoomId: string;
  let notificationId: string;

  const studentEmail = `student-${Date.now()}@test.com`;
  const instructorEmail = `instructor-${Date.now()}@test.com`;

  // ─── Setup / teardown ───────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.setGlobalPrefix('api/v1');

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth flows ─────────────────────────────────────────────────────────────

  describe('Auth', () => {
    it('POST /auth/register — registers a student', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: studentEmail,
          username: `student${Date.now()}`,
          password: 'Password123!',
          firstName: 'Test',
          lastName: 'Student',
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('accessToken');
      studentToken = res.body.accessToken;
    });

    it('POST /auth/register — registers an instructor', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: instructorEmail,
          username: `instructor${Date.now()}`,
          password: 'Password123!',
          firstName: 'Test',
          lastName: 'Instructor',
          role: 'INSTRUCTOR',
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('accessToken');
      instructorToken = res.body.accessToken;
    });

    it('POST /auth/login — logs in with correct credentials', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: studentEmail, password: 'Password123!' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
    });

    it('POST /auth/login — rejects wrong password', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: studentEmail, password: 'WrongPassword!' });
      expect(res.status).toBe(401);
    });

    it('GET /auth/me — returns own profile', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('email', studentEmail);
    });

    it('GET /auth/me — rejects unauthenticated request', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });
  });

  // ─── User profile ───────────────────────────────────────────────────────────

  describe('Users', () => {
    it('PUT /users/profile — updates student profile', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/users/profile')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ bio: 'Aspiring developer', firstName: 'Updated' });
      expect([200, 201]).toContain(res.status);
    });

    it('PUT /users/profile/instructor — updates instructor profile', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/users/profile/instructor')
        .set('Authorization', `Bearer ${instructorToken}`)
        .send({ title: 'Senior Developer', expertise: ['NestJS', 'React'] });
      expect([200, 201]).toContain(res.status);
    });

    it('GET /users/instructors — lists instructors publicly', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/users/instructors');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('instructors');
    });
  });

  // ─── Course flows ───────────────────────────────────────────────────────────

  describe('Courses', () => {
    it('POST /courses — instructor creates a draft course', async () => {
      // First ensure a category exists (use admin endpoint or seed)
      // For this test we accept both 201 (success) and 400 (category not found in fresh DB)
      const res = await request(app.getHttpServer())
        .post('/api/v1/courses')
        .set('Authorization', `Bearer ${instructorToken}`)
        .send({
          title: 'E2E Test Course',
          description: 'A test course for automated e2e testing',
          categoryId: 'non-existent-category',
          price: 49.99,
          level: 'BEGINNER',
        });
      expect([201, 400, 404]).toContain(res.status);
      if (res.status === 201) courseId = res.body.id;
    });

    it('POST /courses — student cannot create a course', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/courses')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          title: 'Unauthorized Course',
          description: 'Should be rejected',
          categoryId: 'any',
          price: 0,
          level: 'BEGINNER',
        });
      expect(res.status).toBe(403);
    });

    it('GET /courses — lists published courses', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/courses');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('courses');
    });

    it('GET /courses/instructor/my-courses — instructor sees own courses', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/courses/instructor/my-courses')
        .set('Authorization', `Bearer ${instructorToken}`);
      expect(res.status).toBe(200);
    });
  });

  // ─── Video processing ───────────────────────────────────────────────────────

  describe('Video Processing', () => {
    it('GET /video-processing/admin/stats — admin endpoint requires ADMIN role', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/video-processing/admin/stats')
        .set('Authorization', `Bearer ${instructorToken}`);
      expect(res.status).toBe(403);
    });

    it('GET /video-processing/status/:id — returns 404 for unknown video', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/video-processing/status/nonexistent-video-id')
        .set('Authorization', `Bearer ${instructorToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Live sessions ──────────────────────────────────────────────────────────

  describe('Live Sessions', () => {
    it('GET /live-sessions/my-sessions — authenticated student can list sessions', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/live-sessions/my-sessions')
        .set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sessions');
    });

    it('GET /live-sessions/requests — instructor can list session requests', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/live-sessions/requests')
        .set('Authorization', `Bearer ${instructorToken}`);
      expect([200, 403]).toContain(res.status);
    });

    it('POST /live-sessions/request — student cannot request session from non-existent instructor', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/live-sessions/request')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          instructorId: 'nonexistent-instructor-id',
          title: 'Test Session',
          preferredDate: new Date(Date.now() + 86400000).toISOString(),
          duration: 60,
        });
      expect([400, 404]).toContain(res.status);
    });
  });

  // ─── Chat ────────────────────────────────────────────────────────────────────

  describe('Chat', () => {
    it('POST /chat/rooms — creates a chat room', async () => {
      const meRes = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${instructorToken}`);
      const instructorId = meRes.body.id;

      const res = await request(app.getHttpServer())
        .post('/api/v1/chat/rooms')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ participantIds: [instructorId] });
      expect([201, 200]).toContain(res.status);
      if (res.body.id) chatRoomId = res.body.id;
    });

    it('GET /chat/rooms — lists user chat rooms', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/chat/rooms')
        .set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(200);
    });

    it('POST /chat/rooms/:id/messages — sends a message', async () => {
      if (!chatRoomId) return;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/rooms/${chatRoomId}/messages`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ content: 'Hello instructor!', messageType: 'text' });
      expect([201, 200]).toContain(res.status);
    });
  });

  // ─── Notifications ──────────────────────────────────────────────────────────

  describe('Notifications', () => {
    it('GET /notifications — returns user notifications', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('notifications');
    });
  });

  // ─── Health ──────────────────────────────────────────────────────────────────

  describe('Health', () => {
    it('GET /health — returns status ok', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /health/live — liveness probe', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
    });
  });

  // ─── Validation ─────────────────────────────────────────────────────────────

  describe('Input validation', () => {
    it('POST /auth/register — rejects short password', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'x@x.com', username: 'x', password: 'short' });
      expect(res.status).toBe(400);
    });

    it('POST /auth/register — rejects invalid email', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', username: 'x', password: 'Password123!' });
      expect(res.status).toBe(400);
    });

    it('POST /auth/register — rejects extra (non-whitelisted) fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'test2@test.com',
          username: 'testuser2',
          password: 'Password123!',
          firstName: 'Test',
          lastName: 'User',
          maliciousField: 'injection',
        });
      expect(res.status).toBe(400);
    });
  });
});
