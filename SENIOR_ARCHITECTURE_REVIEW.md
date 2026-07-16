# EduBridge Backend — Senior Architecture & Production-Readiness Review

**Scope reviewed:** `EduBridge_Backend` — NestJS 10 + Prisma 5 + PostgreSQL + Redis/BullMQ + Socket.IO + Stripe + LiveKit. ~30 feature modules, 971-line Prisma schema, Docker/nginx deployment stack.

**Note on scope:** this workspace contains only the backend. There is no frontend project here to review — everything below is backend/API/infra only. If a frontend exists elsewhere, it needs its own pass before a full "Coursera-grade" verdict can be given.

**Method:** six focused audits run in parallel across auth/security, payments, core LMS domain logic, realtime/video/notifications, deployment/infra, and test coverage — each grounded in actual file:line reads, not a surface skim.

**Bottom line:** the architecture is genuinely well-conceived — modular NestJS boundaries, correct use of `$transaction` for the payment/enrollment critical path, real anti-abuse logic (lockouts, refresh-token rotation with reuse detection), deep health checks, and a search implementation that actually queries the database instead of scanning in memory. This is not a toy project. But it is **not deployable to production today**: there is a live payment-amount tampering bug, a public-registration privilege-escalation bug, a chat eavesdropping bug, and an infra footgun that runs `prisma db push --accept-data-loss` on every container start. Those four alone are launch-blocking. Below is the full list, ranked.

---

## P0 — Ship-blocking. Fix before any production deployment.

| # | Issue | Location | Failure scenario |
|---|---|---|---|
| 1 | **Client controls the charge amount** | `payments.service.ts:54-108` | `finalAmount` is derived from client-supplied `dto.amount`, never validated against `course.price` server-side. A user can POST `amount: 0.50` for a $199 course and Stripe will charge exactly that. This is a direct, trivially-exploitable revenue-loss bug. |
| 2 | **Public registration grants SUPER_ADMIN** | `auth/dto/register.dto.ts:52-61`, `auth.service.ts:63` | `RegisterDto.role` is validated only with `@IsEnum(Role)`, which includes `ADMIN`/`SUPER_ADMIN`, and is passed straight into `user.create()`. Anyone can `POST /auth/register` with `role: "SUPER_ADMIN"` and get full platform control. |
| 3 | **JWT secret has a hardcoded fallback + no env validation at boot** | `config/configuration.ts:20,22` | If `JWT_SECRET`/`JWT_REFRESH_SECRET` are unset, the app boots "successfully" signing tokens with `'fallback-secret-change-this'` — a publicly known string. No Joi/Zod schema on `ConfigModule.forRoot` catches this at startup. |
| 4 | **Chat room eavesdropping — no membership check on socket join** | `chat/chat.gateway.ts:116-149` | `handleJoinRoom` lets any authenticated socket join *any* `chat:<roomId>` with zero DB check that the caller is a `ChatParticipant`. Any logged-in user can read any other user's or course's private messages by guessing/enumerating room IDs. |
| 5 | **Instructor analytics leak platform-wide revenue** | `analytics.service.ts:339-345` | `getInstructorAnalytics` never filters the revenue aggregate by `instructorId` — every instructor's dashboard shows the *entire platform's* revenue. Direct data-leak / trust violation between tenants. |
| 6 | **Every container start runs an unsafe destructive schema sync** | `docker/entrypoint.sh:5` | `npx prisma db push --skip-generate --accept-data-loss` runs on both `api` and `worker` on every restart, with only a single baseline migration in `prisma/migrations/`. Any schema drift can silently drop a column in production, and concurrent replica starts race to alter the same table. There is no real migration discipline in the deployment path (CI correctly uses `prisma migrate deploy`; the shipped container does not). |

**None of these require an architectural rewrite.** #1, #2, #5 are each a one-function fix (compute/derive server-side, restrict the enum, add a `where` clause). #3 is a Joi schema addition. #4 is reusing a membership check that already exists elsewhere in the same file. #6 is deleting one line from the entrypoint and running migrations from CI instead. Fixing all six is realistically a 1–2 day sprint — but the app should not go live before they land.

---

## P1 — High priority. Fix before scaling past a single instance / within the first post-launch sprint.

**Concurrency & correctness**
- **Coupon over-redemption race** (`coupons.service.ts`, `payments.service.ts:338-344`) — `usedCount` increment isn't atomic against `usageLimit`; concurrent checkouts can blow past a coupon's cap. Fix with a conditional `updateMany` (`WHERE usedCount < usageLimit`) inside the existing transaction.
- **Payout double-spend + non-atomic Stripe transfer** (`payouts.service.ts:134-185`) — balance check is read-then-write with no lock; two concurrent payout requests can both succeed off the same balance. Worse, the Stripe transfer fires *before* the DB row is written — if the DB write fails after Stripe succeeds, money moves with no ledger record.
- **Quiz-taking bypasses the paywall** (`quizzes.service.ts:169-225`) — unlike `lessons.service.ts`, nothing checks enrollment before serving/grading a quiz. Unpaid users can take and pass graded quizzes.
- **Quiz submission double-scoring race** (`quizzes.service.ts:229-274`) — check-then-write with no transaction; concurrent submits can both grade and insert answers before either marks the attempt complete.
- **Live-session double-booking** (`live-sessions.service.ts:763-788, 219-224, 306-312`) — capacity/conflict checks are check-then-write with no lock; concurrent bookings can exceed `maxStudents` or double-book an instructor.
- **Course slug race** (`courses.service.ts:42-48`) — check-then-create for unique slugs isn't atomic; concurrent identical titles 500 instead of retrying.

**Authorization gaps**
- **Notifications gateway room permission is a stub** (`notifications.gateway.ts:208-221`) — `canJoinRoom` unconditionally returns `true` for course/chat/session rooms; the comment literally says "Placeholder."
- **Discussion "mark answered" has no ownership check** (`discussions.service.ts:213-232`) — any instructor account can mark answers in *any other instructor's* course, despite a comment claiming the check exists.
- **Chat controller passes the wrong value as user ID** (`chat.controller.ts:121-131`) — `getOrCreateCourseChat` is called without `@CurrentUser()`, so a query-string `courseName` gets used where a `userId` is expected, silently corrupting `ChatParticipant` rows or throwing FK errors.

**Scalability blockers (will break the moment you run >1 replica)**
- **No Socket.IO Redis adapter** — three gateways (`chat`, `classroom`, `notifications`) keep connection/room state in in-process `Map`s. With more than one API pod, events silently stop reaching users connected to a different pod.
- **Cron jobs fire once per replica, not once per cluster** (`scheduler.service.ts`) — session reminders, cleanup jobs, etc. all use plain `@Cron` with no distributed lock. Scaling `worker` (which `docker-compose.yml` explicitly documents doing) multiplies every scheduled email/notification by the replica count.
- **Analytics aggregation doesn't scale past a demo dataset** (`analytics.service.ts`) — `getCategoryAnalytics`, `getTopInstructors`, `getInstructorAnalytics`, `getCourseAnalytics`, `getStudentProgress` all pull entire object graphs into Node memory and reduce/sort in JS. The schema already has `CourseAnalytics`/`UserAnalytics` aggregate tables for exactly this purpose — nothing writes to them. At real scale this times out or OOMs.
- **Rate limiting is per-pod** (`app.module.ts:63-66`) — `ThrottlerModule` uses the default in-memory store, so N replicas silently multiply the intended rate limit by N.

**Infra**
- **Weak/default DB credentials, Redis with no auth, exposed to host** (`docker-compose.yml:41,102-103,127-128`).
- **No TLS termination in the shipped nginx config** (`nginx.conf:33-34`) — only `listen 80`. If nginx is meant to be the real edge, JWTs and Stripe webhook payloads travel in plaintext.

---

## P2 — Medium. Fix before major scale-up or as fast-follow.

- **Money math done in floating-point JS numbers** instead of `Decimal.js` (`payments.service.ts:404-412`, `coupons.service.ts:144-154`, `payouts.service.ts`) — rounding error accumulates across a real transaction volume.
- **Hardcoded, duplicated 70/30 revenue split** with no per-transaction ledger of what the instructor was actually paid (`payments.service.ts:203,329`) — a future split change will make refund clawbacks wrong retroactively.
- **Self-service refunds with no window or consumption check** (`payments.service.ts:161-217`) — "buy, finish course, refund" is currently free.
- **Non-constant-time token/OTP comparisons** (`auth.service.ts:456-460,261-266,298-303`) — timing attack surface on refresh tokens and reset OTPs.
- **OTP has no per-account attempt lockout** (`auth.service.ts:250-266`), unlike the login path.
- **Verbose 500 error messages returned to clients** (`http-exception.filter.ts:60-61`) — leaks internal error text for anything that isn't `HttpException`/Prisma.
- **`console.log` of token subject/expiry on every request** (`jwt.strategy.ts:21,31,34`) — bypasses structured logging, leaks session identifiers into raw stdout.
- **Google OAuth mobile login uses the deprecated `tokeninfo` endpoint** and never checks `email_verified` (`auth.service.ts:352-360`).
- **Discussions are built on top of the Chat table via a substring `contains` scan** (`discussions.service.ts:106-146`), explicitly flagged as a stopgap in its own comment — no index, won't scale, deserves a real model.
- **Soft-delete (`deletedAt`) filtering is ad hoc** — only `courses.service.ts` filters it; `search`, `wishlist`, `discussions`, `announcements`, `admin` don't. Currently masked by other flags but fragile.
- **Video transcode retries aren't idempotent** (`video-processing.service.ts:294-328,651-675`) — re-queuing after partial failure can create duplicate `VideoVariant` rows.
- **Orphaned S3 uploads on failure** — no lifecycle policy or compensating cleanup when a DB insert fails after a successful S3 `PutObject`.
- **`AvailabilitySlot`/timezone feature is decorative** — nothing at booking time actually checks a request against an instructor's declared slots, and `moment-timezone` is a dependency that's never imported in `src`.
- **Log files written to the container filesystem in production** (`winston.logger.ts:25-29`) — lost on every restart of a stateless pod.
- **Dockerfile isn't self-contained** — requires `npm run build` on the host first; CI's docker job never does this, so the CI Docker build step is effectively untested.
- **`lint` script runs `eslint --fix` in CI** — autofixes mask violations instead of failing the build on them.
- **No CD stage** — CI builds an image but nothing pushes or deploys it.

---

## P3 — Low / polish

- Inconsistent exception types for similar auth failures (`BadRequestException` vs `ForbiddenException` for "not your payment").
- `enrollFree` check-then-create isn't wrapped in a transaction; concurrent double-clicks surface a raw Prisma `P2002` instead of a friendly 400.
- Redis client errors are swallowed silently (`cache.service.ts:32`) — a prod Redis outage becomes invisible until symptoms show up elsewhere.
- Helmet CSP falls back to defaults in prod rather than an explicit policy tailored to Swagger/Stripe/CDN needs.
- Duplicate/overlapping test files (see below) add maintenance cost with no coverage gain.
- BullMQ failed jobs have no true dead-letter queue or alerting once retries are exhausted.

---

## Test coverage: the quality gate isn't there yet

Of the ~30 feature modules, **only about 4 have real unit tests** (auth, enrollments, and a partial payments suite) — roughly 13% coverage by module. The tests that do exist are genuinely good (real edge cases: lockout bypass, refresh-token reuse detection, certificate idempotency, progress never reverting) — this isn't a case of shallow instantiation tests, whoever wrote `auth.service.spec.ts` and `enrollments.service.spec.ts` knew what they were doing.

But the gaps are exactly where the money and the risk are:
- **Zero tests** on the actual Stripe money-movement logic (`createPaymentIntent`, `handleStripeWebhook`, `refundPayment`) — only the side-effect-free read paths are covered.
- **Zero tests** on payouts, coupons, quizzes, certificates, live-sessions, video-processing, chat.
- **Three separate, overlapping e2e spec files** (`src/modules/__tests__/core-flows.e2e-spec.ts`, `test/core-flows.e2e-spec.ts`, `test/core-flows.spec.ts`) duplicate the same register/login/404 checks — looks like abandoned iterations left in-tree rather than one curated suite. One of them (`test/core-flows.spec.ts`) uses hardcoded emails and will fail on re-run against a persisted database.
- No load/performance testing exists anywhere.

**Before launch**, prioritize tests in this order: Stripe payment intent + webhook + refund → payout calculation → coupon redemption boundaries → quiz submission race → live-session booking conflicts. Then delete the duplicate spec files.

---

## Architecture: what's actually done well

Credit where due — a lot of this reflects real production experience, not tutorial-level code:

- **Payment transaction integrity**: payment + enrollment + course stats + instructor earnings + coupon + analytics are correctly bundled in one Prisma `$transaction`, with notifications deliberately kept outside it as a non-critical side effect. Webhook idempotency is enforced by real DB unique constraints, not just application logic.
- **Auth hardening**: bcrypt cost factor 12, account lockout after 5 attempts, password-reset rate windowing, and — genuinely rare to see done right — refresh-token-reuse detection that force-invalidates the session family on detected reuse.
- **Search**: actual parameterized raw SQL using `pg_trgm` similarity, not an in-memory filter over `findMany()`.
- **Self-healing aggregates**: course ratings and enrollment progress are always fully recomputed from source rows rather than incrementally patched, so they can't drift under race conditions the way the payout/coupon counters do.
- **Health/observability foundation**: `/health/ready` and `/health/live` genuinely check DB and Redis connectivity rather than returning a bare 200; correlation IDs flow through Sentry; Prometheus metrics are bearer-token gated; graceful shutdown hooks are wired in `main.ts`.
- **Live-session membership enforcement** (the gateway that got this right, unlike chat): `classroom.gateway.ts` does check DB-backed membership before allowing a join.
- **Scheduler efficiency**: batched `$queryRaw` aggregation instead of N+1 queries.
- **Module boundaries**: clean NestJS module-per-domain structure, consistent DTO + `class-validator` usage, global `ValidationPipe` correctly configured with `whitelist`/`forbidNonWhitelisted`/`transform`.

The instinct behind this codebase is sound. The gaps are concentrated in exactly the two places every real system gets wrong first — **concurrency at the money/booking boundary**, and **infra assumptions that only break once you run more than one instance**. Neither is a sign of a weak architecture; both are the standard second-pass items every platform hits on the way from "works in a demo" to "survives production traffic."

---

## What "Coursera-scale" actually requires beyond this list

Fixing every item above gets this to a **solid, secure, correctly-behaving single-region deployment**. Getting to genuine Coursera-scale requires deliberate follow-on investment, not bug fixes:

1. **Stateless-by-default realtime layer** — Redis adapter for Socket.IO plus moving all gateway presence/session state out of process (P1 above) is the prerequisite for horizontal scaling at all.
2. **Read replicas + connection pooling (PgBouncer)** for Postgres once traffic exceeds a single primary's write+read capacity — nothing in the current setup prepares for this.
3. **CDN in front of video delivery** — the transcoding pipeline into `VideoVariant`s (multi-bitrate) is the right foundation; it needs CloudFront/Fastly in front of S3, not direct S3 URLs, for global latency.
4. **A real search index (OpenSearch/Elasticsearch)** once course catalog size outgrows what `pg_trgm` can serve with acceptable latency — today's implementation is legitimately good for the current scale, just not the eventual one.
5. **Precomputed/streamed analytics** (Kafka/event-sourced or at minimum a nightly batch job populating the already-modeled `CourseAnalytics`/`UserAnalytics` tables) instead of computing aggregates from raw tables per-request.
6. **Multi-region / disaster recovery story** — not present or implied anywhere in the current infra; fine for launch, necessary before claiming Coursera-tier availability.
7. **Distributed locking primitives** (Redis-based) as a shared utility, since the same "check-then-write race" pattern shows up independently in payments, payouts, quizzes, coupons, and live-sessions — this should become one reusable pattern, not five separate fixes.

---

## Recommended sequencing

1. **This week:** fix all six P0 items. Each is small and isolated — do not deploy until they land.
2. **Before public launch:** clear the P1 list, with the concurrency/race-condition fixes and the Socket.IO Redis adapter as the two highest-leverage items (they're both "one shared fix pattern, five call sites" problems).
3. **First month post-launch:** P2 items, starting with Decimal-based money math and the refund-abuse window, then test coverage on the payment/payout/coupon paths.
4. **Ongoing:** treat the "Coursera-scale" list as a roadmap, not a blocker — none of it needs to exist before a correct, secure first deployment, but all of it needs to exist before claiming parity with an actual Coursera-scale platform.
