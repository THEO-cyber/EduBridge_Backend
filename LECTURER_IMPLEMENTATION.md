# Lecturer / Instructor Backend Implementation Guide

This document summarizes how the current backend supports instructor (lecturer) behavior and what frontend implementation is required.

> Base API prefix: `api/v1`

---

## 1. Role mapping and auth

### Role support

- Backend `Role` enum supports: `STUDENT`, `INSTRUCTOR`, `ADMIN`, `SUPER_ADMIN`
- Frontend may send `role: "LECTURER"` and the backend will normalize it to `Role.INSTRUCTOR`
- If `role` is omitted, registration defaults to `STUDENT`

### Registration endpoint

- `POST /api/v1/auth/register`
- Allowed fields for instructor-style registration:
  - `email` (string, email)
  - `password` (string, min 8)
  - `name` → mapped to backend `username`
  - `first_name` → mapped to backend `firstName`
  - `last_name` → mapped to backend `lastName`
  - `role` (optional) - accept `INSTRUCTOR`, `LECTURER`, `STUDENT`
  - `bio` (optional)

### Why this shape matters

- Backend uses NestJS `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true`
- Only allowed DTO fields are accepted
- The current backend DTO explicitly maps snake_case fields for Flutter payloads

### Example instructor registration payload

```json
{
  "email": "lecturer@example.com",
  "name": "lecturer123",
  "first_name": "Jane",
  "last_name": "Doe",
  "password": "Password123!",
  "role": "LECTURER",
  "bio": "I teach advanced Flutter and backend integration."
}
```

### Successful response shape

- `accessToken`
- `refreshToken`
- `expiresIn`
- `user` object with:
  - `id`
  - `email`
  - `username`
  - `firstName`
  - `lastName`
  - `role`
  - `isEmailVerified`
  - `avatar`
  - `bio`
  - `instructorProfile`
  - `studentProfile`

---

## 2. Instructor profile management

### Update profile endpoint

- `PUT /api/v1/users/profile/instructor`
- Requires authenticated instructor JWT
- Requires role guard: `Role.INSTRUCTOR`

### Allowed body fields

- `title` (string)
- `expertise` (string[])
- `experience` (string)
- `education` (string)
- `certifications` (string[])
- `website` (string URL)

### What backend does

- Checks user exists and role is `INSTRUCTOR`
- Upserts `instructorProfile` for the user

---

## 3. Courses and instructor content

### Create course

- `POST /api/v1/courses`
- Requires authenticated instructor JWT
- Requires role guard: `Role.INSTRUCTOR`

### Expected payload

- `title`
- `description`
- `categoryId`
- `price`
- `level`
- `tags`? (depending on DTO)
- additional fields from `CreateCourseDto`

### Instructor-only course actions

- `GET /api/v1/courses/instructor/my-courses`
- `PATCH /api/v1/courses/:id`
- `POST /api/v1/courses/:id/publish`
- `DELETE /api/v1/courses/:id`

### Course permissions

- Instructor can only update/delete their own course
- Publishing sets course status to `UNDER_REVIEW`
- Publishing requires at least one section and one lesson

---

## 4. Video processing for lesson videos

### Upload lesson video

- `POST /api/v1/video-processing/upload/:lessonId`
- Requires authenticated instructor JWT
- Requires role guard: `Role.INSTRUCTOR`
- Request type: `multipart/form-data`
- File field: `video`

### Initiate processing

- `POST /api/v1/video-processing/process`
- Requires authenticated instructor JWT
- Body fields:
  - `videoId`
  - optional `qualities` (e.g. `["360p","720p"]`)
  - optional `format` (`mp4` or `hls`)
  - optional `generateThumbnail`

### Status and streaming

- `GET /api/v1/video-processing/status/:videoId`
- `GET /api/v1/video-processing/stream/:videoId?quality=720p`

### Delete video

- `DELETE /api/v1/video-processing/:videoId`
- Requires authenticated instructor JWT

### Notes

- File upload is restricted to video MIME types and max size 2GB
- Video processing uses S3 and Bull queue
- The current implementation includes a placeholder LiveKit token generator and simulated transcoding

---

## 5. Live sessions

### Instructor session actions

- `POST /api/v1/live-sessions/requests/:id/confirm`
  - Confirm a requested live session
- `GET /api/v1/live-sessions/requests?status=...`
  - List session requests for the instructor

### General live session endpoints

- `POST /api/v1/live-sessions/request` (student requests a session)
- `POST /api/v1/live-sessions/:id/join` (join session)
- `PATCH /api/v1/live-sessions/:id/end` (end session)
- `GET /api/v1/live-sessions/my-sessions?role=instructor`

### Important backend behavior

- Only `INSTRUCTOR` users can confirm requests and view requests list
- Requests are validated against instructor availability
- Instructor sessions are scheduled against their `instructorProfile.hourlyRate`

---

## 6. Analytics relevant to instructors

### Instructor dashboard analytics

- `GET /api/v1/analytics/instructor/dashboard`
  - Role-protected for `Role.INSTRUCTOR`

### Specific instructor analytics

- `GET /api/v1/analytics/instructor/:instructorId/dashboard`
  - Allowed for `ADMIN`
  - Allowed for `INSTRUCTOR` only for their own `instructorId`

### Course analytics

- `GET /api/v1/analytics/course/:courseId`
  - Instructors may retrieve analytics for their own course

### What the analytics includes

- total courses
- total enrollments
- completed enrollments
- completion rate
- total revenue
- average rating
- top courses
- course analytics include enrollment trends and review statistics

---

## 7. Instructor discovery and listing

### Get all instructors

- `GET /api/v1/users/instructors`
- Public endpoint
- Returns active instructor list with selected instructor profile metadata

---

## 8. Frontend integration guidance

### Authentication

- Register as lecturer/instructor by sending `role: "LECTURER"` or `role: "INSTRUCTOR"`
- Store `accessToken` and `refreshToken`
- Use `Authorization: Bearer <accessToken>` for all protected instructor routes

### Recommended request behavior

- Use snake_case fields for registration to match the backend DTO support:
  - `name`, `first_name`, `last_name`
- Use `role: "LECTURER"` if the frontend labels the user as a lecturer
- If the frontend already uses camelCase, `username`, `firstName`, `lastName` are also accepted

### Protected instructor flows

- After register/login, instructor should be able to:
  - update instructor profile
  - create courses
  - manage their own course content
  - publish courses for review
  - upload, process, and delete lesson videos
  - confirm live session requests
  - view their own analytics

---

## 9. Notes and gotchas

- The backend currently uses strict validation, so unexpected extra properties will cause `400 Bad Request`
- Use only the documented request fields for each route
- `LECTURER` is not a separate backend role type; it is normalized to `INSTRUCTOR`
- Instructor profile update is separate from general user profile update
- Course publishing does not immediately make the course live; it sends it for review and sets status to `UNDER_REVIEW`

---

## 10. File references in backend

- `src/modules/auth/dto/register.dto.ts`
- `src/modules/auth/auth.service.ts`
- `src/modules/users/users.controller.ts`
- `src/modules/users/users.service.ts`
- `src/modules/users/dto/update-profile.dto.ts`
- `src/modules/courses/courses.controller.ts`
- `src/modules/courses/courses.service.ts`
- `src/modules/video-processing/video-processing.controller.ts`
- `src/modules/video-processing/video-processing.service.ts`
- `src/modules/live-sessions/live-sessions.controller.ts`
- `src/modules/live-sessions/live-sessions.service.ts`
- `src/modules/analytics/analytics.controller.ts`
- `src/modules/analytics/analytics.service.ts`

---

## 11. Quick checklist for frontend implementation

- [ ] Register lecturer with `role: "LECTURER"` / `role: "INSTRUCTOR"`
- [ ] Store auth tokens after registration/login
- [ ] Use `Authorization` header for instructor routes
- [ ] Update instructor profile via `/users/profile/instructor`
- [ ] Create and manage courses via `/courses`
- [ ] Upload videos with multipart form uploads to `/video-processing/upload/:lessonId`
- [ ] Initiate video processing via `/video-processing/process`
- [ ] Confirm live session requests via `/live-sessions/requests/:id/confirm`
- [ ] Fetch analytics from `/analytics/instructor/dashboard`
- [ ] Fetch instructor listings from `/users/instructors`
