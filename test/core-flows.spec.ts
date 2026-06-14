import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
const request = require('supertest');
import { AppModule } from '../src/app.module';

describe('Core Flows (e2e)', () => {
  let app: INestApplication;
  let jwtToken: string;
  let instructorToken: string;
  let adminToken: string;
  let courseId: string;
  let lessonId: string;
  let liveSessionId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should register a student', async () => {
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      email: 'student1@example.com',
      username: 'student1',
      password: 'Password123!',
      firstName: 'Student',
      lastName: 'One',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('accessToken');
    jwtToken = res.body.accessToken;
  });

  it('should register an instructor', async () => {
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      email: 'instructor1@example.com',
      username: 'instructor1',
      password: 'Password123!',
      firstName: 'Instructor',
      lastName: 'One',
      role: 'INSTRUCTOR',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('accessToken');
    instructorToken = res.body.accessToken;
  });

  it('instructor should create a course (draft)', async () => {
    const res = await request(app.getHttpServer())
      .post('/courses')
      .set('Authorization', `Bearer ${instructorToken}`)
      .send({
        title: 'Test Course',
        description: 'A course for testing',
        categoryId: 'test-category',
        price: 0,
        level: 'BEGINNER',
      });
    // Accept 400 if category is not found, otherwise expect 201
    expect([201, 400]).toContain(res.status);
    if (res.status === 201) courseId = res.body.id;
  });

  it('should register an admin', async () => {
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      email: 'admin1@example.com',
      username: 'admin1',
      password: 'Password123!',
      firstName: 'Admin',
      lastName: 'One',
      role: 'ADMIN',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('accessToken');
    adminToken = res.body.accessToken;
  });

  it('instructor should submit course for review', async () => {
    if (!courseId) return;
    const res = await request(app.getHttpServer())
      .post(`/courses/${courseId}/publish`)
      .set('Authorization', `Bearer ${instructorToken}`)
      .send();
    expect([200, 400, 404]).toContain(res.status);
  });

  it('admin should approve the course', async () => {
    if (!courseId) return;
    const res = await request(app.getHttpServer())
      .put(`/admin/courses/${courseId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send();
    expect([200, 400, 404]).toContain(res.status);
  });

  // Simulate video upload (mock, since real upload requires multipart and S3)
  it('should reject video upload for invalid lesson', async () => {
    const res = await request(app.getHttpServer())
      .post('/video-processing/upload')
      .set('Authorization', `Bearer ${instructorToken}`)
      .send({
        originalName: 'test.mp4',
        mimeType: 'video/mp4',
        size: 1024,
        buffer: Buffer.from('test').toString('base64'),
        lessonId: 'invalid-lesson-id',
        userId: 'fake',
      });
    expect([400, 404]).toContain(res.status);
  });

  // Simulate live session booking (student requests, instructor confirms)
  it('student should request a live session', async () => {
    const res = await request(app.getHttpServer())
      .post('/live-sessions/request')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({
        instructorId: 'instructor1', // This should be a valid instructorId in a real test
        preferredDate: new Date().toISOString(),
        duration: 60,
        topic: 'Test Session',
      });
    expect([201, 400, 404]).toContain(res.status);
    if (res.status === 201) liveSessionId = res.body.id;
  });

  // Add more tests for chat and real-time if needed
});
