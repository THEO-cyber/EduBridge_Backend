# Instructor API Guide — EduBridge

Base URL: `http://localhost:3000/api/v1`  
All protected endpoints require: `Authorization: Bearer <accessToken>`

---

## 1. Register as Instructor

**POST** `/auth/register`

```json
{
  "email": "instructor@example.com",
  "username": "john_instructor",
  "firstName": "John",
  "lastName": "Doe",
  "password": "Test@1234",
  "role": "INSTRUCTOR",
  "bio": "Experienced software engineer teaching web development"
}
```

**Password rules:** min 8 chars, at least one uppercase, one lowercase, one number, one special character (`Test@1234` works).

**Success response `201`:**
```json
{
  "user": {
    "id": "clxyz...",
    "email": "instructor@example.com",
    "username": "john_instructor",
    "firstName": "John",
    "lastName": "Doe",
    "role": "INSTRUCTOR",
    "isEmailVerified": false,
    "avatar": null,
    "bio": "Experienced software engineer teaching web development",
    "instructorProfile": { "id": "...", "headline": null, "totalStudents": 0 }
  },
  "accessToken": "eyJhbGci...",
  "refreshToken": "eyJhbGci...",
  "expiresIn": "7d"
}
```

> Save the `accessToken` and `refreshToken` — you need them for all other requests.

---

## 2. Login as Instructor

**POST** `/auth/login`

```json
{
  "email": "instructor@example.com",
  "password": "Test@1234"
}
```

**Success response `200`:**
```json
{
  "user": {
    "id": "clxyz...",
    "email": "instructor@example.com",
    "role": "INSTRUCTOR",
    "isEmailVerified": false,
    "instructorProfile": { ... }
  },
  "accessToken": "eyJhbGci...",
  "refreshToken": "eyJhbGci...",
  "expiresIn": "7d"
}
```

**If 2FA is enabled**, login returns:
```json
{
  "requires2FA": true,
  "tempToken": "eyJhbGci..."
}
```
Then call `/auth/2fa/verify` with `tempToken` + `totpCode`.

---

## 3. Get My Profile

**GET** `/auth/me`  
Header: `Authorization: Bearer <accessToken>`

Returns full profile including instructor details.

---

## 4. Refresh Access Token

**POST** `/auth/refresh`

```json
{
  "refreshToken": "eyJhbGci..."
}
```

Returns a new `accessToken` and `refreshToken`. Old refresh token is immediately invalidated.

---

## 5. Logout

**POST** `/auth/logout`  
Header: `Authorization: Bearer <accessToken>`

Invalidates the refresh token on the server.

---

## 6. Instructor Workflows

### Update Instructor Profile
**PUT** `/users/profile/instructor`  
Header: `Authorization: Bearer <accessToken>`

```json
{
  "headline": "Senior Web Developer | 10 Years Experience",
  "website": "https://johndoe.dev",
  "socialLinks": {
    "twitter": "https://twitter.com/johndoe",
    "linkedin": "https://linkedin.com/in/johndoe"
  }
}
```

---

### Create a Course
**POST** `/courses`  
Header: `Authorization: Bearer <accessToken>`

```json
{
  "title": "Complete NestJS Masterclass",
  "description": "Learn NestJS from scratch to advanced level with real-world projects.",
  "shortDescription": "NestJS full course for beginners to advanced.",
  "price": 49.99,
  "currency": "USD",
  "level": "INTERMEDIATE",
  "language": "en",
  "categoryId": "<category-id>",
  "tags": ["nestjs", "nodejs", "backend"]
}
```

---

### Publish a Course (after adding lessons)
**PATCH** `/courses/:courseId/publish`  
Header: `Authorization: Bearer <accessToken>`

No body needed. Course goes to `PENDING_REVIEW` — admin must approve it.

---

### Create a Section
**POST** `/lessons/courses/:courseId/sections`  
Header: `Authorization: Bearer <accessToken>`

```json
{
  "title": "Getting Started",
  "description": "Introduction and setup"
}
```

---

### Create a Lesson
**POST** `/lessons/sections/:sectionId/lessons`  
Header: `Authorization: Bearer <accessToken>`

```json
{
  "title": "What is NestJS?",
  "description": "Overview of the NestJS framework",
  "duration": 600,
  "isFree": true
}
```

---

### Broadcast Announcement to Enrolled Students
**POST** `/announcements/courses/:courseId`  
Header: `Authorization: Bearer <accessToken>`

```json
{
  "title": "New section added!",
  "content": "I just uploaded 5 new lessons covering advanced decorators. Check them out!"
}
```

---

### Create a Quiz for a Lesson
**POST** `/quizzes/lessons/:lessonId`  
Header: `Authorization: Bearer <accessToken>`

```json
{
  "title": "NestJS Basics Quiz",
  "description": "Test your understanding of NestJS fundamentals",
  "passingScore": 70,
  "timeLimit": 15,
  "questions": [
    {
      "question": "What is NestJS built on top of?",
      "type": "MULTIPLE_CHOICE",
      "options": ["Express", "Fastify", "Koa", "Express or Fastify"],
      "correctAnswer": "Express or Fastify",
      "points": 10
    },
    {
      "question": "NestJS uses TypeScript by default.",
      "type": "TRUE_FALSE",
      "correctAnswer": "true",
      "points": 5
    }
  ]
}
```

---

### Upload a Lecture Video (Full Flow)

Video upload is a **3-step process**: upload → transcode → stream.

---

#### Step 1 — Upload the video file

**POST** `/video-processing/upload/:lessonId`  
Header: `Authorization: Bearer <accessToken>`  
Content-Type: `multipart/form-data`

| Field | Type | Value |
|-------|------|-------|
| `video` | File | Your `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`, `.wmv` file |

**Postman setup:**
1. Method: `POST`
2. URL: `http://localhost:3000/api/v1/video-processing/upload/<lessonId>`
3. Body → `form-data`
4. Add key `video`, change type to **File**, select your video file

**Max size:** 2 GB

**Success response:**
```json
{
  "id": "video-id-here",
  "lessonId": "lesson-id",
  "status": "UPLOADED",
  "originalName": "lecture1.mp4",
  "size": 104857600,
  "mimeType": "video/mp4"
}
```

> Copy the `id` (videoId) — you need it for Step 2.

---

#### Step 2 — Start transcoding

**POST** `/video-processing/process`  
Header: `Authorization: Bearer <accessToken>`  
Body: `application/json`

```json
{
  "videoId": "<video-id-from-step-1>",
  "qualities": ["360p", "480p", "720p"],
  "format": "mp4",
  "generateThumbnail": true
}
```

- `qualities`: choose any of `360p`, `480p`, `720p`, `1080p` (default: 360p + 480p + 720p)
- `format`: `mp4` or `hls` (default: `mp4`)
- `generateThumbnail`: generates a preview image from the 720p variant

**Success response:**
```json
{
  "message": "Video processing started",
  "videoId": "<video-id>",
  "jobIds": ["job-1", "job-2", "job-3"]
}
```

> Transcoding runs in the background. Check status with Step 3.

---

#### Step 3 — Check processing status

**GET** `/video-processing/status/:videoId`  
Header: `Authorization: Bearer <accessToken>`

```
GET http://localhost:3000/api/v1/video-processing/status/<videoId>
```

**Response:**
```json
{
  "id": "<videoId>",
  "status": "PROCESSING",
  "variants": [
    { "quality": "360p", "status": "READY", "url": "https://cdn..." },
    { "quality": "720p", "status": "PROCESSING" }
  ]
}
```

Statuses: `UPLOADED` → `PROCESSING` → `READY` (or `FAILED`)

> Poll this endpoint every 5–10 seconds until all variants show `READY`.

---

#### Step 4 — Get streaming URL (for playback)

**GET** `/video-processing/stream/:videoId?quality=720p`

```
GET http://localhost:3000/api/v1/video-processing/stream/<videoId>?quality=720p
```

Returns a **signed CDN URL** valid for a limited time. Feed this URL into your video player.

---

#### Delete a video

**DELETE** `/video-processing/:videoId`  
Header: `Authorization: Bearer <accessToken>`

Removes the video from S3 and all transcoded variants.

---

> **Note:** Video transcoding requires Redis (BullMQ queue) + AWS S3 + FFmpeg.  
> Without Redis running, videos stay in `UPLOADED` status.  
> Without AWS credentials, upload will fail — set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` in `.env`.

---

### Set Availability Slots (for Live Sessions)
**POST** `/live-sessions/availability`  
Header: `Authorization: Bearer <accessToken>`

```json
{
  "dayOfWeek": 1,
  "startTime": "09:00",
  "endTime": "10:00",
  "timezone": "Africa/Accra",
  "isRecurring": true
}
```

`dayOfWeek`: 0=Sunday, 1=Monday, ... 6=Saturday

---

### View My Earnings
**GET** `/payouts/my-earnings`  
Header: `Authorization: Bearer <accessToken>`

---

### View Course Analytics
**GET** `/analytics/instructor/courses`  
Header: `Authorization: Bearer <accessToken>`

---

## 7. Common Errors

| Error | Reason | Fix |
|-------|--------|-----|
| `401 Unauthorized` | Missing or expired token | Re-login to get a new token |
| `403 Forbidden` | Not an instructor or not your resource | Check your role |
| `400 Validation failed` | Missing/invalid field | Check the required fields |
| `409 Email already registered` | Email in use | Use a different email |
| `409 Username already taken` | Username in use | Use a different username |

---

## 8. Postman Setup

1. Create a **collection** called `EduBridge`
2. Set a **collection variable** `baseUrl = http://localhost:3000/api/v1`
3. After login, copy `accessToken` and set it as collection variable `token`
4. Set all protected requests to use: `Authorization: Bearer {{token}}`

---

## 9. Account Lockout

After **5 failed login attempts**, the account is locked for **15 minutes**.  
The error message will show how many attempts remain and when the lock expires.
