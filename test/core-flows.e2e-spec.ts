/**
 * EduBridge End-to-End Tests
 *
 * Run against a real database:  npm run test:e2e
 * Requires .env (or environment variables) with valid DB/Redis credentials.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

describe('EduBridge (e2e)', () => {
  let app: INestApplication;

  let studentToken: string;
  let instructorToken: string;

  const studentEmail = `student-${Date.now()}@e2e.test`;
  const instructorEmail = `instructor-${Date.now()}@e2e.test`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  // ── Health ─────────────────────────────────────────────────────────────────

  describe('Health', () => {
    it('/api/v1/health (GET) → 200', () =>
      request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200)
        .expect((r) => expect(r.body.status).toBe('ok')));

    it('/api/v1/health/live (GET) → alive', () =>
      request(app.getHttpServer())
        .get('/api/v1/health/live')
        .expect(200)
        .expect((r) => expect(r.body.status).toBe('alive')));
  });

  // ── Auth ───────────────────────────────────────────────────────────────────

  describe('Auth — register & login', () => {
    it('registers a student', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: studentEmail,
          username: `stu${Date.now()}`,
          password: 'Password123!',
          firstName: 'Alice',
          lastName: 'Student',
        })
        .expect(201);
      expect(res.body.accessToken).toBeDefined();
      studentToken = res.body.accessToken;
    });

    it('registers an instructor', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: instructorEmail,
          username: `ins${Date.now()}`,
          password: 'Password123!',
          firstName: 'Bob',
          lastName: 'Instructor',
          role: 'INSTRUCTOR',
        })
        .expect(201);
      expect(res.body.accessToken).toBeDefined();
      instructorToken = res.body.accessToken;
    });

    it('rejects duplicate email', () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: studentEmail,
          username: `dup${Date.now()}`,
          password: 'Password123!',
          firstName: 'X',
          lastName: 'X',
        })
        .expect(409));

    it('logs in successfully', () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: studentEmail, password: 'Password123!' })
        .expect(200)
        .expect((r) => expect(r.body.accessToken).toBeDefined()));

    it('rejects wrong password', () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: studentEmail, password: 'WrongPass!' })
        .expect(401));

    it('GET /auth/me returns own user', () =>
      request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200)
        .expect((r) => expect(r.body.email).toBe(studentEmail)));

    it('GET /auth/me returns 401 without token', () =>
      request(app.getHttpServer()).get('/api/v1/auth/me').expect(401));
  });

  // ── Input validation ───────────────────────────────────────────────────────

  describe('Validation — rejects bad input', () => {
    it('rejects short password', () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'x@x.com', username: 'x', password: 'abc' })
        .expect(400));

    it('rejects invalid email', () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'not-email', username: 'x', password: 'Password123!' })
        .expect(400));

    it('rejects extra (non-whitelisted) fields', () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: `e${Date.now()}@test.com`,
          username: `u${Date.now()}`,
          password: 'Password123!',
          firstName: 'T',
          lastName: 'T',
          hackerField: 'DROP TABLE users;',
        })
        .expect(400));
  });

  // ── Users ──────────────────────────────────────────────────────────────────

  describe('Users', () => {
    it('updates instructor profile', () =>
      request(app.getHttpServer())
        .put('/api/v1/users/profile/instructor')
        .set('Authorization', `Bearer ${instructorToken}`)
        .send({ title: 'Senior Educator', expertise: ['NestJS', 'React'] })
        .expect((r) => expect([200, 201]).toContain(r.status)));

    it('GET /users/instructors is public', () =>
      request(app.getHttpServer())
        .get('/api/v1/users/instructors')
        .expect(200)
        .expect((r) => expect(r.body).toHaveProperty('instructors')));

    it('student cannot call instructor-only profile route', () =>
      request(app.getHttpServer())
        .put('/api/v1/users/profile/instructor')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ title: 'Hacker' })
        .expect(403));
  });

  // ── Courses ────────────────────────────────────────────────────────────────

  describe('Courses', () => {
    it('student cannot create a course', () =>
      request(app.getHttpServer())
        .post('/api/v1/courses')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ title: 'X', description: 'X', categoryId: 'x', price: 0, level: 'BEGINNER' })
        .expect(403));

    it('GET /courses is public', () =>
      request(app.getHttpServer())
        .get('/api/v1/courses')
        .expect(200)
        .expect((r) => expect(r.body).toHaveProperty('courses')));

    it('instructor sees own courses', () =>
      request(app.getHttpServer())
        .get('/api/v1/courses/instructor/my-courses')
        .set('Authorization', `Bearer ${instructorToken}`)
        .expect(200));
  });

  // ── Video processing ───────────────────────────────────────────────────────

  describe('Video Processing', () => {
    it('ADMIN-only stats route returns 403 for instructor', () =>
      request(app.getHttpServer())
        .get('/api/v1/video-processing/admin/stats')
        .set('Authorization', `Bearer ${instructorToken}`)
        .expect(403));

    it('unknown video returns 404', () =>
      request(app.getHttpServer())
        .get('/api/v1/video-processing/status/unknown-video-id-xyz')
        .set('Authorization', `Bearer ${instructorToken}`)
        .expect(404));
  });

  // ── Live sessions ──────────────────────────────────────────────────────────

  describe('Live Sessions', () => {
    it('student lists own sessions', () =>
      request(app.getHttpServer())
        .get('/api/v1/live-sessions/my-sessions')
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200)
        .expect((r) => expect(r.body).toHaveProperty('sessions')));

    it('request to non-existent instructor returns 404', () =>
      request(app.getHttpServer())
        .post('/api/v1/live-sessions/request')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          instructorId: 'nonexistent-id',
          title: 'Session',
          preferredDate: new Date(Date.now() + 86_400_000).toISOString(),
          duration: 60,
        })
        .expect((r) => expect([400, 404]).toContain(r.status)));
  });

  // ── Notifications ──────────────────────────────────────────────────────────

  describe('Notifications', () => {
    it('GET /notifications requires auth', () =>
      request(app.getHttpServer()).get('/api/v1/notifications').expect(401));

    it('returns notification list for student', () =>
      request(app.getHttpServer())
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200)
        .expect((r) => expect(r.body).toHaveProperty('notifications')));
  });

  // ── Chat ───────────────────────────────────────────────────────────────────

  describe('Chat', () => {
    it('GET /chat/rooms returns list', () =>
      request(app.getHttpServer())
        .get('/api/v1/chat/rooms')
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(200));
  });
});
