# EduBridge Frontend Implementation Guide

This guide tells you exactly what API endpoints exist, what they return, and how to build every screen of the EduBridge frontend — whether you're using React, Next.js, Vue, or React Native.

---

## Base URL & Auth Header

```
Base URL:  http://localhost:3000/api/v1
Swagger:   http://localhost:3000/api/docs

All protected routes:
  Authorization: Bearer <accessToken>
```

---

## 1. Authentication Flow

### 1.1 Register

```http
POST /auth/register
Body: {
  "email": "user@example.com",
  "username": "johndoe",
  "firstName": "John",
  "lastName": "Doe",
  "password": "SecurePass@1",
  "role": "STUDENT"          // or "INSTRUCTOR" — triggers application flow
}
Response: { user, accessToken, refreshToken, expiresIn }
```

- If `role = INSTRUCTOR`, the user registers as STUDENT first, then submits an application via `POST /applications/instructor`.
- Send email verification after register → `POST /auth/resend-verification`.

### 1.2 Login (standard)

```http
POST /auth/login
Body: { "email": "...", "password": "..." }
Response:
  // Normal: { user, accessToken, refreshToken, expiresIn }
  // 2FA enabled: { requires2FA: true, tempToken: "..." }
```

If `requires2FA: true`, redirect to 2FA screen → call `POST /auth/2fa/verify`.

### 1.3 2FA Login Step 2

```http
POST /auth/2fa/verify
Body: { "tempToken": "...", "totpCode": "123456" }
Response: { accessToken, refreshToken, expiresIn }
```

### 1.4 Token Refresh

```http
POST /auth/refresh
Body: { "refreshToken": "..." }
Response: { accessToken, refreshToken, expiresIn }
```

Call this automatically when any request returns 401. Store `refreshToken` in an HttpOnly cookie or secure storage. **Never store in localStorage.**

### 1.5 Google OAuth

```
GET /auth/google  → redirects to Google
GET /auth/google/callback  → redirects to:
  {FRONTEND_URL}/auth/google/success?accessToken=...&refreshToken=...
```

### 1.6 Password Reset Flow

```http
POST /auth/forgot-password    Body: { "email": "..." }
POST /auth/reset-password     Body: { "token": "...", "newPassword": "..." }
POST /auth/change-password    Body: { "currentPassword": "...", "newPassword": "..." }
```

### 1.7 Email Verification

```
GET /auth/verify-email?token=<token>    (link from email)
POST /auth/resend-verification          (authenticated)
```

### 1.8 2FA Setup

```http
POST /auth/2fa/enable    → { secret, otpAuthUri }
// Show otpAuthUri as a QR code (use qrcode library on frontend)
POST /auth/2fa/confirm   Body: { "totpCode": "123456" }
POST /auth/2fa/disable   Body: { "totpCode": "123456" }
```

---

## 2. User Profiles

### Current user

```http
GET  /auth/me                          → full user object with profiles
PUT  /users/profile                    → update base profile
PUT  /users/profile/student            → update student-specific fields
PUT  /users/profile/instructor         → update instructor bio, expertise, hourlyRate
DELETE /users/account                  → delete own account
```

### Browse instructors (public)

```http
GET /users/instructors?page=1&limit=20
```

---

## 3. Courses

### Public browsing (no auth needed)

```http
GET  /courses                              → paginated list of published courses
GET  /courses/:id                          → course detail with sections
GET  /courses/slug/:slug                   → course by slug (for SEO URLs)
GET  /search?q=python&category=...&page=1  → full-text search
GET  /search/suggestions?q=pyt            → autocomplete
GET  /search/categories                    → popular categories with counts
GET  /search/featured                      → featured courses
```

### Student actions (auth required)

```http
GET  /enrollments                          → my enrollments
GET  /enrollments/:id                      → enrollment details
POST /enrollments/lessons/:lessonId/progress  Body: { "isCompleted": true, "watchTime": 120 }
GET  /enrollments/courses/:courseId/progress  → progress % + completed lessons

GET  /wishlist                             → wishlist
POST /wishlist/:courseId                   → add to wishlist
DELETE /wishlist/:courseId                 → remove from wishlist
GET  /wishlist/:courseId/check             → { isInWishlist: bool }
```

### Instructor course management

```http
GET  /courses/instructor/my-courses        → my courses (all statuses)
POST /courses                              → create course (returns draft)
PATCH /courses/:id                         → update course fields
POST /courses/:id/publish                  → submit for admin review
DELETE /courses/:id                        → delete (only DRAFT)

POST /lessons/sections     Body: { courseId, title, sortOrder }
PATCH /lessons/sections/:id
DELETE /lessons/sections/:id
PATCH /lessons/sections/reorder/:courseId  Body: { ids: [...] }

POST /lessons              Body: { sectionId, title, sortOrder, releaseAt? }
PATCH /lessons/:id
DELETE /lessons/:id
PATCH /lessons/reorder/:sectionId
```

### Content drip

When creating/updating a lesson, pass `releaseAt` as an ISO date string:
```json
{ "releaseAt": "2026-07-01T00:00:00.000Z" }
```
Students will get 403 if they try to access the lesson before that date.

---

## 4. Video

```http
POST /video-processing/upload/:lessonId    multipart/form-data, field: "video"
GET  /video-processing/status/:videoId     → { status: "READY"|"PROCESSING"|"FAILED" }
GET  /video-processing/stream/:videoId     → streaming URL
GET  /video-processing/hls/:videoId/manifest  → HLS manifest for adaptive streaming
DELETE /video-processing/:videoId
```

Poll `/status/:videoId` every 5 seconds until `status === "READY"`.

---

## 5. Quizzes (NEW)

### Instructor

```http
POST  /quizzes/lessons/:lessonId    Body: { title, passingScore, timeLimit }
PATCH /quizzes/:quizId
DELETE /quizzes/:quizId
POST  /quizzes/:quizId/questions    Body: { questionText, questionType, options, correctAnswer, explanation, points }
PATCH /quizzes/questions/:questionId
DELETE /quizzes/questions/:questionId
GET   /quizzes/:quizId/results      → attempt results + stats
```

`questionType` is `"multiple_choice"` | `"true_false"` | `"short_answer"`.
`options` is an array of `{ id, text }` for multiple choice.

### Student

```http
GET  /quizzes/lesson/:lessonId      → quiz with questions (no answers shown)
POST /quizzes/:quizId/start         → returns attemptId + questions
POST /quizzes/attempts/:attemptId/submit  Body: { answers: [{ questionId, answer }], timeSpent }
GET  /quizzes/:quizId/my-attempts   → history with scores
```

---

## 6. Payments

### Purchase flow

```http
POST /payments/create-intent
Body: { "courseId": "...", "couponCode": "SAVE10" }
Response: { clientSecret, amount, currency }
```

Use Stripe.js on the frontend with `clientSecret` to collect card details. After payment intent succeeds, Stripe fires the webhook → enrollment is automatic.

```http
POST /payments/enroll-free/:courseId    → free courses, no Stripe needed
GET  /payments/history                  → payment list
GET  /payments/:id/invoice              → structured receipt
POST /payments/:id/refund               Body: { "reason": "..." }
```

### Coupons

```http
GET  /coupons/active                    → active coupons students can discover
POST /coupons/validate  Body: { "code": "SAVE10", "courseId": "...", "amount": 49.99 }
Response: { valid, discount, finalAmount, savings }
```

---

## 7. Reviews

```http
POST   /reviews              Body: { courseId, rating, title, content }
GET    /reviews/course/:id   → paginated course reviews
GET    /reviews/my/:courseId → my review for a course
PATCH  /reviews/:id
DELETE /reviews/:id
```

---

## 8. Live Sessions

### Student booking flow

```http
GET  /live-sessions/availability/:instructorId  → instructor weekly schedule by day
POST /live-sessions/request   Body: { instructorId, title, preferredDate, duration, message }
GET  /live-sessions/my-sessions?role=student
POST /live-sessions/:id/join  → returns { roomId, accessToken, livekitUrl }
PATCH /live-sessions/:id/end  Body: { "meetingNotes": "..." }
PATCH /live-sessions/requests/:id/cancel
```

### Instructor

```http
GET  /live-sessions/requests?status=SCHEDULED
POST /live-sessions/requests/:id/confirm

POST  /live-sessions/availability              Body: CreateAvailabilitySlotDto
GET   /live-sessions/availability/my-slots
PATCH /live-sessions/availability/:id
DELETE /live-sessions/availability/:id
PUT   /live-sessions/availability/day/:dayOfWeek   Body: [CreateAvailabilitySlotDto]
```

Use `livekit-client` SDK on frontend with the `accessToken` and `livekitUrl` to join rooms.

---

## 9. Instructor Payouts

```http
GET  /payouts/dashboard              → earnings, available balance, pending payouts
POST /payouts/connect                → creates Stripe Connect onboarding link
GET  /payouts/history
POST /payouts/request   Body: { amount, currency }
```

Redirect the instructor to the Stripe Connect onboarding URL returned by `/payouts/connect`.

---

## 10. Notifications

```http
GET    /notifications?page=1
PATCH  /notifications/:id/read
POST   /notifications/mark-all-read
DELETE /notifications/:id
POST   /notifications/device-token   Body: { token, platform }
DELETE /notifications/device-token   Body: { token }
```

Use WebSocket (Socket.io) for real-time notification badges. Connect to the server and listen for `notification` events.

---

## 11. Chat

```http
POST /chat/rooms                         Body: { participantIds, name? }
GET  /chat/rooms                         → my conversations
GET  /chat/rooms/:roomId/messages
POST /chat/rooms/:roomId/messages        Body: { content, messageType?, replyToId? }
POST /chat/rooms/:roomId/read
GET  /chat/rooms/course/:courseId        → course group chat
```

Use Socket.io for real-time messages. Emit `sendMessage` event, listen for `newMessage`.

---

## 12. Course Announcements (NEW)

```http
POST   /announcements/courses/:courseId   Body: { title, content }   (Instructor)
GET    /announcements/courses/:courseId   → announcements for enrolled students
PATCH  /announcements/:id                 (Instructor)
DELETE /announcements/:id                 (Instructor)
```

---

## 13. Student Notes (NEW)

```http
POST   /notes/lessons/:lessonId   Body: { content, timestamp? }
GET    /notes/lessons/:lessonId   → notes with video timestamps
GET    /notes                     → all notes across all courses
PATCH  /notes/:id
DELETE /notes/:id
```

Show notes as a sidebar panel during video playback. `timestamp` is in seconds.

---

## 14. Certificates

```http
GET /certificates              → my certificates
GET /certificates/:id          → certificate detail
GET /certificates/:id/download → download PDF
GET /certificates/verify/:certificateNumber   (public, no auth)
```

---

## 15. Discussions (Q&A)

```http
POST  /discussions/threads               Body: { courseId, title, content }
GET   /discussions/threads/:courseId     → course Q&A list
GET   /discussions/thread/:id            → thread with replies
POST  /discussions/thread/:id/reply      Body: { content, replyToId? }
DELETE /discussions/post/:id
POST  /discussions/thread/:threadId/answer/:replyId   (Instructor: mark as answered)
```

---

## 16. Analytics

```http
GET /analytics/student/progress             → enrolled courses, watch time, streaks
GET /analytics/instructor/dashboard         → revenue, enrollments, top courses
GET /analytics/course/:courseId             → course-specific metrics
GET /analytics/platform/overview            (Admin)
GET /analytics/platform/enrollment-trends  (Admin)
GET /analytics/platform/categories         (Admin)
GET /analytics/platform/top-instructors    (Admin)
```

---

## 17. Instructor Applications (NEW)

```http
POST /applications/instructor     Body: { motivation, subjectExpertise, sampleContentUrl }
GET  /applications/instructor/mine  → check application status
```

Show this flow to STUDENT users who want to become instructors. After approval, the user's role changes to INSTRUCTOR automatically.

---

## 18. Reports / Content Moderation (NEW)

```http
POST /reports   Body: { targetType, targetId, reason, details? }
GET  /reports/my  → my submitted reports
```

`targetType`: `"course"` | `"review"` | `"chat_message"` | `"user"` | `"discussion"`.

Show a "Report" button on courses, reviews, and chat messages.

---

## 19. Email Preferences (NEW)

```http
GET   /email-preferences
PATCH /email-preferences   Body: { marketingEmails, courseUpdates, sessionReminders, ... }
GET   /email-preferences/unsubscribe/:token   (public, from email footer link)
```

---

## 20. Public Platform Settings

```http
GET /settings/public   → { settings: [{ key, value }] }
```

Use for feature flags, maintenance banners, platform-wide announcements.

---

## 21. Health Check

```http
GET /health   → { status: "ok", info: { database, redis } }
```

---

## State Management Recommendations

| State | Where to store |
|---|---|
| `accessToken` | Memory (React state / Zustand) |
| `refreshToken` | HttpOnly cookie (set by backend) or secure storage (mobile) |
| `user` | Global store, hydrate on app mount via `GET /auth/me` |
| Cart / course being purchased | Local state |
| Notifications unread count | Real-time via Socket.io |

---

## Screen-to-Endpoint Map

| Screen | Key endpoints |
|---|---|
| Home / Landing | `GET /search/featured`, `GET /search/categories` |
| Course catalog | `GET /search` with filters |
| Course detail page | `GET /courses/slug/:slug`, `GET /reviews/course/:id` |
| Lesson player | `GET /lessons/:id`, `GET /video-processing/stream/:videoId` |
| Quiz in lesson | `GET /quizzes/lesson/:lessonId`, `/quizzes/:id/start`, `/submit` |
| Student dashboard | `GET /enrollments`, `GET /analytics/student/progress` |
| My notes | `GET /notes` |
| Notifications | `GET /notifications` + Socket.io |
| Live session booking | `GET /live-sessions/availability/:instructorId`, `POST /live-sessions/request` |
| Instructor dashboard | `GET /analytics/instructor/dashboard`, `GET /courses/instructor/my-courses` |
| Course builder | Full lessons CRUD + video upload |
| Announcements | `POST /announcements/courses/:id`, `GET /announcements/courses/:id` |
| Settings page | `GET /auth/me`, `PATCH /users/profile`, `GET /email-preferences` |
| 2FA setup | `POST /auth/2fa/enable` → QR code → `POST /auth/2fa/confirm` |
| Apply as instructor | `POST /applications/instructor` |
| Payouts | `GET /payouts/dashboard`, `POST /payouts/connect` |
| Admin panel | See SUPERADMIN_GUIDE.md |

---

## Error Response Format

All errors follow this shape:
```json
{
  "statusCode": 400,
  "message": "Email already registered",
  "error": "Bad Request",
  "timestamp": "2026-06-05T12:00:00.000Z",
  "path": "/api/v1/auth/register",
  "correlationId": "abc-123"
}
```

Handle 401 by refreshing the token. Handle 403 by redirecting to the enrollment page. Handle 429 (rate limit) with a retry-after delay.
