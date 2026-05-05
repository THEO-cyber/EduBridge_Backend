# EduBridge Backend

A comprehensive educational platform backend built with NestJS, featuring live video sessions, course management, payment processing, and real-time collaboration.

## 🚀 Features

- **📚 Course Management**: Create, publish, and manage courses with video content
- **👥 User System**: Students, instructors, and admin roles with profiles
- **💳 Payments**: Stripe integration for course purchases and instructor payouts
- **🎥 Live Sessions**: WebRTC-powered live video sessions with booking system
- **💬 Real-time Chat**: Socket.IO-powered messaging and notifications
- **📊 Analytics**: Comprehensive analytics and reporting
- **🔐 Security**: JWT authentication, rate limiting, input validation

## 🛠️ Tech Stack

- **Framework**: NestJS (TypeScript)
- **Database**: PostgreSQL with Prisma ORM
- **Cache**: Redis for sessions and caching
- **Real-time**: Socket.IO for chat and notifications
- **Video**: LiveKit integration for live sessions
- **Payments**: Stripe Connect for course sales and payouts
- **Storage**: AWS S3 for file and video storage
- **Queue**: BullMQ for background job processing

## 📦 Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd edubridge-backend
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Environment setup**

   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Database setup**

   ```bash
   # Generate Prisma client
   npx prisma generate

   # Run migrations
   npx prisma migrate dev

   # Seed database
   npm run db:seed
   ```

## 🔧 Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/edubridge"
DIRECT_URL="postgresql://username:password@localhost:5432/edubridge"

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT
JWT_SECRET=your-super-secret-jwt-key
JWT_EXPIRES_IN=7d

# AWS S3
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_S3_BUCKET=edubridge-files

# Stripe
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret

# LiveKit
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
LIVEKIT_WS_URL=wss://your-livekit-server.com
```

## 🏃‍♂️ Running the Application

```bash
# Development
npm run start:dev

# Production build
npm run build
npm run start:prod

# Watch mode
npm run start:debug
```

The API will be available at:

- **API**: http://localhost:3000/api/v1
- **Documentation**: http://localhost:3000/api/docs
- **Health Check**: http://localhost:3000/api/v1/health

## 🗄️ Database

This project uses PostgreSQL with Prisma ORM. The database schema includes:

- **Users & Authentication**: User management with role-based access
- **Courses & Content**: Course creation with sections, lessons, and attachments
- **Enrollment & Progress**: Student enrollment and progress tracking
- **Live Sessions**: Booking and management of live video sessions
- **Payments**: Transaction processing and instructor payouts
- **Reviews & Analytics**: Course reviews and platform analytics

### Database Commands

```bash
# Generate Prisma client
npm run db:generate

# Create and apply migration
npm run db:migrate

# Reset database
npx prisma migrate reset

# Open Prisma Studio
npm run db:studio

# Seed database
npm run db:seed
```

## 📚 API Documentation

The API is fully documented with Swagger/OpenAPI. After starting the server, visit:
http://localhost:3000/api/docs

### Authentication

Most endpoints require authentication. Include the JWT token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

### Test Accounts

After running the seed script, you can use these test accounts:

- **Admin**: admin@edubridge.com / password123
- **Instructor**: instructor@edubridge.com / password123
- **Student**: student@edubridge.com / password123

## 🧪 Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov

# Watch mode
npm run test:watch
```

## 🐳 Docker Support

```bash
# Build image
docker build -t edubridge-backend .

# Run with docker-compose
docker-compose up -d
```

## 📁 Project Structure

```
src/
├── common/           # Shared utilities, guards, interceptors
│   ├── prisma/      # Database service
│   └── health/      # Health check endpoints
├── config/          # Configuration files
├── modules/         # Feature modules
│   ├── auth/        # Authentication & authorization
│   ├── users/       # User management
│   ├── courses/     # Course management
│   ├── payments/    # Payment processing
│   ├── live-sessions/ # Live video sessions
│   └── ...
├── app.module.ts    # Main application module
└── main.ts          # Application entry point

prisma/
├── schema.prisma    # Database schema
└── seed.ts         # Database seeding
```

## 🚀 Deployment

### Production Checklist

1. **Environment Variables**: Configure all production environment variables
2. **Database**: Set up PostgreSQL and Redis instances
3. **File Storage**: Configure AWS S3 bucket and CloudFront CDN
4. **LiveKit**: Deploy LiveKit server for video sessions
5. **Monitoring**: Set up logging and monitoring (optional)

### Docker Deployment

```bash
# Build for production
docker build --target production -t edubridge-backend:latest .

# Deploy with docker-compose
docker-compose -f docker-compose.prod.yml up -d
```

## 📋 API Endpoints

### Authentication

- `POST /auth/register` - User registration
- `POST /auth/login` - User login
- `POST /auth/refresh` - Refresh JWT token

### Courses

- `GET /courses` - List courses
- `POST /courses` - Create course
- `GET /courses/:id` - Get course details
- `PUT /courses/:id` - Update course
- `DELETE /courses/:id` - Delete course

### Live Sessions

- `POST /live-sessions/request` - Request session
- `GET /live-sessions` - List sessions
- `POST /live-sessions/:id/join` - Join session

### Payments

- `POST /payments/purchase` - Purchase course
- `POST /payments/webhook` - Stripe webhook
- `GET /payments/history` - Payment history

_For complete API documentation, visit /api/docs_

## 🤝 Contributing

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ✨ Acknowledgments

- [NestJS](https://nestjs.com/) - Progressive Node.js framework
- [Prisma](https://prisma.io/) - Next-generation ORM
- [LiveKit](https://livekit.io/) - Open-source WebRTC infrastructure
- [Stripe](https://stripe.com/) - Payment processing
