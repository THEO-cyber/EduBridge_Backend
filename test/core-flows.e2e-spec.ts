import request from 'supertest';

/**
 * EduBridge end-to-end suite — 18 checks against the LIVE production API.
 *
 * Unlike an in-process boot, this exercises the actual deployed system (the
 * same thing a learner hits), which is where configuration defects surface.
 * Override the target with E2E_BASE_URL if needed.
 *
 *   npm run test:e2e
 *
 * Seed admin account (from prisma/seed.ts): admin@edubridge.com / Password123!
 */
const BASE =
  process.env.E2E_BASE_URL ||
  'https://edubridge-proxy.michaelrodri091.workers.dev/api/v1';

const api = () => request(BASE);
const PASSWORD = 'Password123!';
const stamp = Date.now();

// Shared state threaded through the ordered checks.
const studentEmail = `e2e-student-${stamp}@example.com`;
const applicantEmail = `e2e-teacher-${stamp}@example.com`;

let studentToken = '';
let studentId = '';
let adminToken = '';
let applicationId = '';
let instructorToken = '';
let freeCourseId = '';
let paidCourseId = '';

// unwrap the { success, data } envelope
const data = (res: request.Response) => res.body?.data ?? res.body;

describe('EduBridge E2E (18 checks, live production API)', () => {
  jest.setTimeout(60_000);

  // 1
  it('01 · health check is up', async () => {
    const res = await api().get('/health');
    expect(res.status).toBe(200);
    expect(data(res).status).toBe('ok');
  });

  // 2
  it('02 · a learner can register', async () => {
    const res = await api().post('/auth/register').send({
      email: studentEmail,
      password: PASSWORD,
      username: `e2estud${stamp}`,
      firstName: 'E2E',
      lastName: 'Student',
    });
    expect(res.status).toBe(201);
    const d = data(res);
    studentToken = d.accessToken;
    studentId = d.user?.id ?? d.id;
    expect(studentToken).toBeTruthy();
    expect(d.user?.role ?? d.role).toBe('STUDENT');
  });

  // 3
  it('03 · a learner can log in', async () => {
    const res = await api().post('/auth/login').send({ email: studentEmail, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(data(res).accessToken).toBeTruthy();
  });

  // 4
  it('04 · the authenticated profile is returned', async () => {
    const res = await api().get('/auth/me').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(data(res).email).toBe(studentEmail);
  });

  // 5
  it('05 · the public course catalogue lists courses', async () => {
    const res = await api().get('/courses?limit=24');
    expect(res.status).toBe(200);
    const d = data(res);
    const list: any[] = Array.isArray(d) ? d : d.courses ?? d.items ?? [];
    expect(list.length).toBeGreaterThan(0);
    freeCourseId = list.find((c) => Number(c.price) === 0)?.id ?? '';
    paidCourseId = list.find((c) => Number(c.price) > 0)?.id ?? '';
    expect(freeCourseId).toBeTruthy();
    expect(paidCourseId).toBeTruthy();
  });

  // 6
  it('06 · a course detail includes its price', async () => {
    const res = await api().get(`/courses/${paidCourseId}`);
    expect(res.status).toBe(200);
    expect(Number(data(res).price)).toBeGreaterThan(0);
  });

  // 7
  it('07 · a learner can enrol in a free course', async () => {
    const res = await api()
      .post(`/payments/enroll-free/${freeCourseId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect([200, 201]).toContain(res.status);
  });

  // 8
  it('08 · a paid course cannot be free-enrolled (requires payment)', async () => {
    const res = await api()
      .post(`/payments/enroll-free/${paidCourseId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(400);
  });

  // 9
  it('09 · a learner can update their profile', async () => {
    const res = await api()
      .put('/users/profile')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ firstName: 'E2E', lastName: 'Learner', bio: 'Automated check.' });
    expect(res.status).toBe(200);
  });

  // 10
  it('10 · course categories are available', async () => {
    const res = await api().get('/search/categories');
    expect(res.status).toBe(200);
    const d = data(res);
    expect(Array.isArray(d) ? d : d.categories ?? d.items).toBeDefined();
  });

  // 11
  it('11 · anyone can apply to teach without an account (no account created)', async () => {
    const res = await api().post('/applications/instructor/apply').send({
      email: applicantEmail,
      firstName: 'E2E',
      lastName: 'Teacher',
      password: PASSWORD,
      motivation: 'Automated end-to-end verification of the apply-first flow.',
      subjectExpertise: ['Testing', 'Quality Assurance'],
      teachingExperience: 'Several years.',
    });
    expect(res.status).toBe(201);
    expect(data(res).status).toBe('pending');
  });

  // 12
  it('12 · an applicant has no account until approval (login rejected)', async () => {
    const res = await api().post('/auth/login').send({ email: applicantEmail, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  // 13
  it('13 · an admin can log in', async () => {
    const res = await api().post('/auth/login').send({ email: 'admin@edubridge.com', password: PASSWORD });
    expect(res.status).toBe(200);
    adminToken = data(res).accessToken;
    expect(adminToken).toBeTruthy();
  });

  // 14
  it('14 · an admin can list pending applications (status filter)', async () => {
    const res = await api()
      .get('/applications/instructor?status=pending&limit=50')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const d = data(res);
    const apps: any[] = d.applications ?? d.items ?? (Array.isArray(d) ? d : []);
    const mine = apps.find((a) => a.email === applicantEmail);
    expect(mine).toBeTruthy();
    applicationId = mine.id;
  });

  // 15
  it('15 · approval provisions the instructor account', async () => {
    const res = await api()
      .patch(`/applications/instructor/${applicationId}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'approved' });
    expect(res.status).toBe(200);
  });

  // 16
  it('16 · the approved instructor can now log in as INSTRUCTOR', async () => {
    const res = await api().post('/auth/login').send({ email: applicantEmail, password: PASSWORD });
    expect(res.status).toBe(200);
    const d = data(res);
    instructorToken = d.accessToken;
    expect(d.user?.role ?? d.role).toBe('INSTRUCTOR');
  });

  // 17
  it('17 · the instructor can reach instructor-only tools', async () => {
    const res = await api()
      .get('/courses/instructor/my-courses')
      .set('Authorization', `Bearer ${instructorToken}`);
    expect(res.status).toBe(200);
  });

  // 18
  it('18 · an admin can delete a user who has an enrolment', async () => {
    const res = await api()
      .delete(`/admin/users/${studentId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    // and the deleted user no longer appears in the admin list
    const list = await api()
      .get(`/admin/users?search=${encodeURIComponent(studentEmail)}&limit=5`)
      .set('Authorization', `Bearer ${adminToken}`);
    const d = data(list);
    const rows: any[] = d.users ?? d.items ?? (Array.isArray(d) ? d : []);
    expect(rows.find((u) => u.email === studentEmail)).toBeFalsy();
  });

  // Clean up the instructor account we provisioned (best-effort).
  afterAll(async () => {
    if (adminToken && instructorToken) {
      const me = await api().get('/auth/me').set('Authorization', `Bearer ${instructorToken}`);
      const id = data(me)?.id;
      if (id) {
        await api().delete(`/admin/users/${id}`).set('Authorization', `Bearer ${adminToken}`).catch(() => {});
      }
    }
  });
});
