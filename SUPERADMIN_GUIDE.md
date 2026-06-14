# EduBridge Super Admin & Admin Guide

This guide covers every admin and super-admin endpoint, what they do, what the admin dashboard UI should show, and what a SUPER_ADMIN can do that a regular ADMIN cannot.

---

## Role Hierarchy

```
SUPER_ADMIN  ← can do everything ADMIN can + system settings + role changes
    ADMIN    ← can do everything below + platform management
 INSTRUCTOR  ← course creator, earns revenue
   STUDENT   ← learner
```

---

## Admin vs Super Admin — Difference Table

| Capability | ADMIN | SUPER_ADMIN |
|---|---|---|
| View / manage users | ✅ | ✅ |
| Approve / reject courses | ✅ | ✅ |
| Manage categories | ✅ | ✅ |
| View analytics | ✅ | ✅ |
| View/resolve content reports | ✅ | ✅ |
| Review instructor applications | ✅ | ✅ |
| View all payouts | ✅ | ✅ |
| View/retry video processing | ✅ | ✅ |
| **Change user roles** | ❌ | ✅ |
| **Manage system settings** | ❌ | ✅ |
| **Promote users to ADMIN** | ❌ | ✅ |
| **Bulk settings upsert** | ❌ | ✅ |

---

## How to Get Admin Tokens

```http
POST /api/v1/auth/login
Body: { "email": "admin@edubridge.com", "password": "..." }
```

Include the returned `accessToken` in `Authorization: Bearer <token>` on all requests.

> To create the first SUPER_ADMIN, seed the database: `npm run db:seed` (see `prisma/seed.ts`) or manually UPDATE the `users` table to set `role = 'SUPER_ADMIN'`.

---

## 1. Platform Dashboard

### System Statistics

```http
GET /admin/dashboard/stats
Authorization: Bearer <adminToken>

Response:
{
  "users": { "total": 1200, "student": 1100, "instructor": 85, "admin": 15 },
  "courses": 340,
  "enrollments": 8500,
  "totalRevenue": "142500.00"
}
```

### Recent Activity Feed

```http
GET /admin/dashboard/activity?limit=50

Response: [
  { "type": "user_registered", "description": "John Doe registered as student", "timestamp": "..." },
  { "type": "course_created", "description": "Jane created 'Python Basics'", "timestamp": "..." },
  { "type": "user_enrolled", "description": "Bob enrolled in 'React 101'", "timestamp": "..." }
]
```

### Platform Analytics

```http
GET /analytics/platform/overview              → revenue, users, enrollments totals
GET /analytics/platform/enrollment-trends     → enrollments over time (chart data)
GET /analytics/platform/categories            → per-category stats
GET /analytics/platform/top-instructors       → ranked instructors by revenue
```

---

## 2. User Management

### List & Search Users

```http
GET /admin/users?page=1&limit=20&role=STUDENT&isActive=true&search=john

Query params:
  role        STUDENT | INSTRUCTOR | ADMIN | SUPER_ADMIN
  isActive    true | false
  search      name, email, or username substring
  createdAfter / createdBefore  ISO date strings
```

### Get Single User

```http
GET /admin/users/:id
```

### Create User

```http
POST /admin/users
Body: {
  "email": "new@example.com",
  "username": "newuser",
  "firstName": "New",
  "lastName": "User",
  "role": "ADMIN",
  "password": "TempPass@123"
}
```

### Update User

```http
PUT /admin/users/:id
Body: { "isActive": false, "firstName": "Updated" }
```

### Deactivate / Activate User

```http
PUT /admin/users/:id/deactivate   → sets isActive = false
PUT /admin/users/:id/activate     → sets isActive = true
```

### Delete User (permanent)

```http
DELETE /admin/users/:id
```

### Change User Role (SUPER_ADMIN only)

```http
PUT /admin/users/:id/role
Body: { "role": "ADMIN" }    // STUDENT | INSTRUCTOR | ADMIN | SUPER_ADMIN
```

> This is how you promote a trusted user to ADMIN or demote a misbehaving INSTRUCTOR back to STUDENT.

---

## 3. Course Moderation

### List All Courses

```http
GET /admin/courses?status=UNDER_REVIEW&page=1

Query params:
  status       DRAFT | UNDER_REVIEW | PUBLISHED | REJECTED | SUSPENDED | ARCHIVED
  instructorId  filter by instructor
  categoryId    filter by category
  search        title/description substring
```

### Approve Course

```http
PUT /admin/courses/:id/approve
```

Sets status → PUBLISHED, `isPublished = true`, `publishedAt = now`.
Notifies instructor by email and in-app notification.

### Reject Course

```http
PUT /admin/courses/:id/reject
Body: { "reason": "Missing learning objectives in description" }
```

Sets status → REJECTED. Notifies instructor with the rejection reason.

### Suspend Course

```http
PUT /admin/courses/:id/suspend
Body: { "reason": "Copyright violation reported" }
```

Sets status → ARCHIVED (unpublishes immediately).

---

## 4. Category Management

### List All Categories (admin view, includes inactive)

```http
GET /admin/categories
```

### Create Category

```http
POST /admin/categories
Body: { "name": "Data Science", "description": "...", "parentId": null }
```

A `slug` is auto-generated from the name.

### Update Category

```http
PUT /admin/categories/:id
Body: { "name": "AI & Machine Learning", "description": "..." }
```

### Delete Category

```http
DELETE /admin/categories/:id
```

Only succeeds if the category has no courses.

---

## 5. Instructor Application Review

```http
GET /applications/instructor?status=pending&page=1

GET /applications/instructor/stats
Response: { "pending": 12, "approved": 45, "rejected": 8, "total": 65 }

PATCH /applications/instructor/:id/review
Body: {
  "decision": "approved",       // or "rejected"
  "rejectionReason": "..."      // required if decision = rejected
}
```

When approved:
- User's role is automatically set to `INSTRUCTOR`
- An `InstructorProfile` is auto-created
- An in-app notification is sent to the user

---

## 6. Content Reports

### List Reports

```http
GET /reports?status=pending&targetType=course&page=1

Query params:
  status      pending | reviewed | dismissed | actioned
  targetType  course | review | chat_message | user | discussion

GET /reports/stats
Response: { "pending": 5, "reviewed": 20, "actioned": 3, "total": 28 }
```

### Review a Report

```http
PATCH /reports/:id/review
Body: {
  "status": "actioned",               // reviewed | dismissed | actioned
  "resolution": "Course suspended due to copyright violation"
}
```

After reviewing a report, manually take the appropriate action (suspend course, delete review, etc.) using the relevant endpoints.

---

## 7. System Settings (SUPER_ADMIN only)

These key-value settings control platform behaviour globally.

### List All Settings

```http
GET /admin/settings
```

### Get Single Setting

```http
GET /admin/settings/:key
```

### Create Setting

```http
POST /admin/settings
Body: {
  "key": "platform.maintenance_mode",
  "value": "false",
  "description": "Set to 'true' to show maintenance page to all users",
  "isPublic": false
}
```

### Update Setting

```http
PUT /admin/settings/:key
Body: { "value": "true" }
```

### Delete Setting

```http
DELETE /admin/settings/:key
```

### Bulk Upsert (mass update)

```http
PATCH /admin/settings/bulk
Body: [
  { "key": "platform.name", "value": "EduBridge" },
  { "key": "platform.currency", "value": "USD" },
  { "key": "platform.instructor_revenue_share", "value": "0.70" }
]
```

### Public Settings (no auth — readable by frontend)

```http
GET /settings/public
```

Returns only settings where `isPublic = true`. Use this for:
- Feature flags the frontend reads on load
- Maintenance mode message
- Platform name / branding

---

### Recommended System Settings to Seed

| Key | Value | Description |
|---|---|---|
| `platform.name` | `EduBridge` | Platform display name |
| `platform.currency` | `USD` | Default currency |
| `platform.instructor_revenue_share` | `0.70` | 70% to instructor |
| `platform.max_course_price` | `999` | Max course price in USD |
| `platform.maintenance_mode` | `false` | Set true during deployments |
| `platform.free_enrollment_enabled` | `true` | Allow free courses |
| `platform.review_period_days` | `30` | Days students can review after enrollment |
| `platform.cert_expiry_years` | `0` | 0 = no expiry |

---

## 8. Instructor Payouts (Admin View)

```http
GET /payouts/admin/all?page=1
```

Returns all payouts across all instructors with instructor details.

---

## 9. Video Processing (Admin View)

```http
GET  /video-processing/admin/stats
Response: { "pending": 2, "processing": 1, "ready": 450, "failed": 3 }

POST /video-processing/admin/retry/:videoId
```

---

## 10. Admin UI — Recommended Screens

### Sidebar Navigation

```
Dashboard
  ├── Overview Stats
  ├── Recent Activity
  └── Platform Analytics

Users
  ├── All Users (searchable/filterable)
  ├── Instructor Applications (with pending badge)
  └── Create User

Courses
  ├── All Courses (filterable by status)
  ├── Pending Review (badge count)
  └── Categories

Moderation
  ├── Content Reports (with pending badge)
  └── Video Processing

Finance
  ├── All Payouts
  └── Revenue Analytics

Settings (SUPER_ADMIN only)
  ├── System Settings
  └── Role Management
```

### Key Dashboard Widgets

1. **KPI Cards** — Total Users, Active Courses, Revenue This Month, Pending Reviews
2. **Enrollment Trend Chart** — 30-day line chart (from `/analytics/platform/enrollment-trends`)
3. **Category Distribution** — pie/donut chart (from `/analytics/platform/categories`)
4. **Top Instructors Table** — ranked by revenue
5. **Pending Actions** — instructor applications waiting, content reports pending, courses under review
6. **Recent Activity Feed** — live feed of last 50 events

---

## 11. Seeding the First Super Admin

Run after your first `prisma migrate dev`:

```bash
npm run db:seed
```

Or insert directly via SQL:
```sql
-- After creating the user normally via register, promote them:
UPDATE "users" SET role = 'SUPER_ADMIN' WHERE email = 'youremail@example.com';
```

---

## 12. Security Notes for Admin Panel

- Admin panel should be on a **separate subdomain** (e.g., `admin.edubridge.com`) — never share the same origin as the student app.
- All admin routes are protected by `JwtAuthGuard + RolesGuard(ADMIN)` on the backend.
- SUPER_ADMIN routes additionally check for `SUPER_ADMIN` role.
- The backend enforces this — the frontend cannot bypass it.
- Rate limiting is active on all routes (10/s burst, 200/min per IP).
- Rotate admin passwords every 90 days and enforce 2FA for all admin accounts.
- Log all admin actions via the `/admin/dashboard/activity` endpoint (actions are implicit in the DB changes).

---

## 13. Typical Admin Workflow

### New course waiting for review:
1. `GET /admin/courses?status=UNDER_REVIEW` → see pending courses
2. Click course → `GET /courses/:id` → review title, description, sections
3. `PUT /admin/courses/:id/approve` **or** `PUT /admin/courses/:id/reject` with reason

### Instructor application:
1. `GET /applications/instructor?status=pending` → list pending
2. Read motivation, expertise, sample content
3. `PATCH /applications/instructor/:id/review` with `{ "decision": "approved" }`
4. User is automatically promoted to INSTRUCTOR

### Content report:
1. `GET /reports?status=pending` → see unreviewed reports
2. Navigate to the reported content
3. Take action (suspend course, delete message, warn user)
4. `PATCH /reports/:id/review` with `{ "status": "actioned", "resolution": "..." }`
