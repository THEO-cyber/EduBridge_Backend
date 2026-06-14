import {
  PrismaClient, Role, CourseStatus, CourseLevel, NotificationType,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('\n🌱  EduBridge — seeding database…\n');

  // ── 1. Clean slate ─────────────────────────────────────────────────────────
  const tables = [
    'courseAnalytics', 'userAnalytics', 'certificate', 'lessonProgress',
    'enrollment', 'review', 'wishlist', 'chatMessage', 'chatParticipant',
    'chat', 'notification', 'attachment', 'videoVariant',
    'video', 'lesson', 'section', 'liveSession', 'sessionRequest',
    'availabilitySlot', 'payment', 'payout', 'coupon', 'course',
    'category', 'instructorProfile', 'studentProfile', 'userAuth',
    'systemSettings', 'user',
  ] as const;

  for (const t of tables) {
    await (prisma[t] as any).deleteMany();
  }
  console.log('🧹  Cleaned existing data');

  // ── 2. Passwords ────────────────────────────────────────────────────────────
  const pw = await bcrypt.hash('Password123!', 12);

  // ── 3. Users ────────────────────────────────────────────────────────────────

  // Super admin
  await prisma.user.create({
    data: {
      email: 'superadmin@edubridge.com',
      username: 'superadmin',
      firstName: 'Super',
      lastName: 'Admin',
      role: Role.SUPER_ADMIN,
      isEmailVerified: true,
      bio: 'EduBridge platform owner.',
      userAuth: { create: { passwordHash: pw } },
    },
  });

  // Admin
  await prisma.user.create({
    data: {
      email: 'admin@edubridge.com',
      username: 'admin',
      firstName: 'Admin',
      lastName: 'EduBridge',
      role: Role.ADMIN,
      isEmailVerified: true,
      userAuth: { create: { passwordHash: pw } },
    },
  });

  // Instructors
  const john = await prisma.user.create({
    data: {
      email: 'john@edubridge.com',
      username: 'johnsmith',
      firstName: 'John',
      lastName: 'Smith',
      role: Role.INSTRUCTOR,
      isEmailVerified: true,
      bio: 'Senior full-stack developer with 10+ years building scalable web applications. Passionate about teaching React, Node.js, and TypeScript.',
      avatar: 'https://api.dicebear.com/8.x/avataaars/svg?seed=john',
      userAuth: { create: { passwordHash: pw } },
      instructorProfile: {
        create: {
          title: 'Senior Full-Stack Developer',
          expertise: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'AWS'],
          experience: '10 years in software engineering at Google and startups',
          education: 'B.Sc. Computer Science — MIT',
          certifications: ['AWS Certified Solutions Architect', 'Google Cloud Professional Developer'],
          hourlyRate: 80,
          isVerified: true,
          isAvailableForSessions: true,
          rating: 4.8,
          totalReviews: 312,
          totalStudents: 4800,
          totalRevenue: 42000,
        },
      },
    },
  });

  const sarah = await prisma.user.create({
    data: {
      email: 'sarah@edubridge.com',
      username: 'sarahdata',
      firstName: 'Sarah',
      lastName: 'Johnson',
      role: Role.INSTRUCTOR,
      isEmailVerified: true,
      bio: 'Data scientist and AI researcher. PhD from Stanford. I make complex machine learning concepts easy to understand.',
      avatar: 'https://api.dicebear.com/8.x/avataaars/svg?seed=sarah',
      userAuth: { create: { passwordHash: pw } },
      instructorProfile: {
        create: {
          title: 'Data Scientist & AI Researcher',
          expertise: ['Python', 'Machine Learning', 'TensorFlow', 'Data Analysis', 'NLP'],
          experience: '8 years — Stanford Research Lab and Netflix Data team',
          education: 'PhD Statistics — Stanford University',
          certifications: ['TensorFlow Developer Certificate', 'IBM Data Science Professional'],
          hourlyRate: 95,
          isVerified: true,
          isAvailableForSessions: true,
          rating: 4.9,
          totalReviews: 189,
          totalStudents: 3100,
          totalRevenue: 29500,
        },
      },
    },
  });

  const maya = await prisma.user.create({
    data: {
      email: 'maya@edubridge.com',
      username: 'mayadesign',
      firstName: 'Maya',
      lastName: 'Patel',
      role: Role.INSTRUCTOR,
      isEmailVerified: true,
      bio: 'UX/UI designer with a decade of experience designing products for millions of users. Currently design lead at a Fortune 500 company.',
      avatar: 'https://api.dicebear.com/8.x/avataaars/svg?seed=maya',
      userAuth: { create: { passwordHash: pw } },
      instructorProfile: {
        create: {
          title: 'UX/UI Design Lead',
          expertise: ['Figma', 'UX Research', 'Design Systems', 'Prototyping', 'Mobile Design'],
          experience: '10 years product design — Airbnb, Microsoft',
          education: 'B.F.A. Graphic Design — Rhode Island School of Design',
          certifications: ['Google UX Design Certificate', 'Interaction Design Foundation'],
          hourlyRate: 70,
          isVerified: true,
          isAvailableForSessions: true,
          rating: 4.7,
          totalReviews: 95,
          totalStudents: 1900,
          totalRevenue: 13000,
        },
      },
    },
  });

  const carlos = await prisma.user.create({
    data: {
      email: 'carlos@edubridge.com',
      username: 'carlosflutter',
      firstName: 'Carlos',
      lastName: 'Rivera',
      role: Role.INSTRUCTOR,
      isEmailVerified: true,
      bio: 'Mobile developer specialized in Flutter & Dart. Built 20+ production apps with millions of downloads.',
      avatar: 'https://api.dicebear.com/8.x/avataaars/svg?seed=carlos',
      userAuth: { create: { passwordHash: pw } },
      instructorProfile: {
        create: {
          title: 'Flutter & Mobile Expert',
          expertise: ['Flutter', 'Dart', 'iOS', 'Android', 'Firebase'],
          experience: '7 years mobile development',
          education: 'B.Sc. Software Engineering — UC Berkeley',
          certifications: ['Google Associate Android Developer'],
          hourlyRate: 75,
          isVerified: true,
          isAvailableForSessions: true,
          rating: 4.8,
          totalReviews: 156,
          totalStudents: 2700,
          totalRevenue: 20000,
        },
      },
    },
  });

  // Students
  const alice = await prisma.user.create({
    data: {
      email: 'alice@edubridge.com',
      username: 'alice_learns',
      firstName: 'Alice',
      lastName: 'Wilson',
      role: Role.STUDENT,
      isEmailVerified: true,
      avatar: 'https://api.dicebear.com/8.x/avataaars/svg?seed=alice',
      userAuth: { create: { passwordHash: pw } },
      studentProfile: {
        create: {
          interests: ['Web Development', 'Mobile Apps', 'UI/UX'],
          learningGoals: 'Become a full-stack developer within 1 year',
        },
      },
      analytics: {
        create: {
          totalCoursesEnrolled: 3,
          totalCoursesCompleted: 1,
          totalWatchTime: 840,
          totalSpent: 219.97,
        },
      },
    },
  });

  const bob = await prisma.user.create({
    data: {
      email: 'bob@edubridge.com',
      username: 'bob_codes',
      firstName: 'Bob',
      lastName: 'Chen',
      role: Role.STUDENT,
      isEmailVerified: true,
      avatar: 'https://api.dicebear.com/8.x/avataaars/svg?seed=bob',
      userAuth: { create: { passwordHash: pw } },
      studentProfile: {
        create: {
          interests: ['Data Science', 'Machine Learning', 'Python'],
          learningGoals: 'Switch career from finance to data science',
        },
      },
    },
  });

  console.log('👥  Created 7 users (1 superadmin, 1 admin, 4 instructors, 2 students)');

  // ── 4. Categories ────────────────────────────────────────────────────────────

  const cats = await Promise.all([
    prisma.category.create({ data: { name: 'Web Development',     slug: 'web-development',     description: 'Build modern web apps',                 icon: '🌐', sortOrder: 1 } }),
    prisma.category.create({ data: { name: 'Data Science',        slug: 'data-science',        description: 'Data analysis and machine learning',    icon: '📊', sortOrder: 2 } }),
    prisma.category.create({ data: { name: 'Mobile Development',  slug: 'mobile-development',  description: 'iOS and Android app development',       icon: '📱', sortOrder: 3 } }),
    prisma.category.create({ data: { name: 'UI/UX Design',        slug: 'ui-ux-design',        description: 'User experience and interface design',  icon: '🎨', sortOrder: 4 } }),
    prisma.category.create({ data: { name: 'Business',            slug: 'business',            description: 'Entrepreneurship and management',       icon: '💼', sortOrder: 5 } }),
    prisma.category.create({ data: { name: 'Cloud & DevOps',      slug: 'cloud-devops',        description: 'AWS, Docker, Kubernetes and CI/CD',     icon: '☁️', sortOrder: 6 } }),
    prisma.category.create({ data: { name: 'Cybersecurity',       slug: 'cybersecurity',       description: 'Ethical hacking and security',          icon: '🔒', sortOrder: 7 } }),
    prisma.category.create({ data: { name: 'Photography',         slug: 'photography',         description: 'Camera, editing and creative photography', icon: '📸', sortOrder: 8 } }),
    prisma.category.create({ data: { name: 'Finance',             slug: 'finance',             description: 'Investing, trading and financial planning', icon: '💰', sortOrder: 9 } }),
    prisma.category.create({ data: { name: 'Language Learning',   slug: 'language-learning',   description: 'English, Spanish, French and more',    icon: '🗣️', sortOrder: 10 } }),
  ]);

  const [webDev, dataScience, mobileDev, design] = cats;

  // Sub-categories
  await Promise.all([
    prisma.category.create({ data: { name: 'React & Next.js',    slug: 'react-nextjs',    description: 'Modern React ecosystem', parentId: webDev.id,    sortOrder: 1 } }),
    prisma.category.create({ data: { name: 'Node.js & APIs',     slug: 'nodejs-apis',     description: 'Backend with Node.js',   parentId: webDev.id,    sortOrder: 2 } }),
    prisma.category.create({ data: { name: 'Flutter & Dart',     slug: 'flutter-dart',    description: 'Cross-platform mobile',  parentId: mobileDev.id, sortOrder: 1 } }),
    prisma.category.create({ data: { name: 'Machine Learning',   slug: 'machine-learning', description: 'ML & Deep Learning',    parentId: dataScience.id, sortOrder: 1 } }),
    prisma.category.create({ data: { name: 'Figma & Prototyping',slug: 'figma',            description: 'Design in Figma',       parentId: design.id,    sortOrder: 1 } }),
  ]);

  console.log('📂  Created 15 categories (10 top-level, 5 sub-categories)');

  // ── 5. Courses ───────────────────────────────────────────────────────────────

  // Course 1 — React (paid, published)
  const reactCourse = await prisma.course.create({
    data: {
      title: 'Complete React & TypeScript Developer 2024',
      slug: 'complete-react-typescript-developer-2024',
      description: 'Master React 18 and TypeScript by building 5 real-world projects including an e-commerce platform, social media app, and admin dashboard. Covers hooks, context, Redux Toolkit, React Query, testing, and deployment.',
      shortDescription: 'Build 5 real-world apps with React 18 + TypeScript — from zero to deployed.',
      instructorId: john.id,
      categoryId: webDev.id,
      price: 89.99,
      discountPrice: 14.99,
      currency: 'USD',
      level: CourseLevel.INTERMEDIATE,
      duration: 2880,
      language: 'en',
      requirements: ['Basic JavaScript (variables, functions, arrays)', 'HTML & CSS fundamentals'],
      objectives: [
        'Build production-ready React applications',
        'Write type-safe code with TypeScript',
        'Master React Hooks (useState, useEffect, useCallback, useMemo, useRef)',
        'Manage global state with Redux Toolkit and Zustand',
        'Fetch and cache data with React Query (TanStack Query)',
        'Write unit and integration tests with Vitest and Testing Library',
        'Deploy React apps to Vercel and AWS',
        'Implement authentication with JWT and OAuth',
      ],
      tags: ['react', 'typescript', 'javascript', 'frontend', 'web-development', 'redux'],
      status: CourseStatus.PUBLISHED,
      isPublished: true,
      publishedAt: new Date('2024-01-15'),
      totalEnrollments: 6420,
      totalRevenue: 57733.80,
      rating: 4.8,
      totalReviews: 892,
    },
  });

  // Course 2 — Python (paid, published)
  const pythonCourse = await prisma.course.create({
    data: {
      title: 'Python for Data Science & Machine Learning Bootcamp',
      slug: 'python-data-science-machine-learning-bootcamp',
      description: 'The most comprehensive Python data science course. Learn NumPy, Pandas, Matplotlib, Seaborn, Plotly, Scikit-Learn, TensorFlow, Keras, and more. Over 100 exercises and 12 real-world projects.',
      shortDescription: 'Go from zero Python to deploying ML models — 100 exercises, 12 projects.',
      instructorId: sarah.id,
      categoryId: dataScience.id,
      price: 129.99,
      discountPrice: 19.99,
      currency: 'USD',
      level: CourseLevel.BEGINNER,
      duration: 3600,
      language: 'en',
      requirements: ['No programming experience required — we start from absolute zero'],
      objectives: [
        'Master Python 3 from scratch',
        'Analyze data with Pandas and NumPy',
        'Create stunning visualizations with Matplotlib and Seaborn',
        'Build and evaluate machine learning models with Scikit-Learn',
        'Create deep learning models with TensorFlow and Keras',
        'Work with natural language processing (NLP)',
        'Use OpenCV for computer vision',
        'Deploy ML models as REST APIs',
      ],
      tags: ['python', 'data-science', 'machine-learning', 'ai', 'tensorflow', 'numpy', 'pandas'],
      status: CourseStatus.PUBLISHED,
      isPublished: true,
      publishedAt: new Date('2024-02-01'),
      totalEnrollments: 4850,
      totalRevenue: 62994.50,
      rating: 4.9,
      totalReviews: 643,
    },
  });

  // Course 3 — Flutter (paid, published)
  const flutterCourse = await prisma.course.create({
    data: {
      title: 'Flutter & Dart — Build Native iOS & Android Apps',
      slug: 'flutter-dart-build-native-ios-android-apps',
      description: 'Build beautiful, high-performance mobile apps for iOS and Android from a single codebase. Learn Dart, Flutter widgets, state management (Provider, Riverpod, Bloc), Firebase integration, REST APIs, animations, and publish to app stores.',
      shortDescription: 'One codebase, two platforms — master Flutter from zero to App Store.',
      instructorId: carlos.id,
      categoryId: mobileDev.id,
      price: 99.99,
      discountPrice: 16.99,
      currency: 'USD',
      level: CourseLevel.BEGINNER,
      duration: 3120,
      language: 'en',
      requirements: ['No mobile experience needed', 'Basic programming concepts helpful but not required'],
      objectives: [
        'Master Dart programming language',
        'Build cross-platform apps with Flutter',
        'Implement state management with Provider, Riverpod, and Bloc',
        'Integrate Firebase (Auth, Firestore, Storage, FCM)',
        'Consume REST APIs and handle JSON',
        'Add smooth animations and transitions',
        'Publish apps to Google Play Store and Apple App Store',
      ],
      tags: ['flutter', 'dart', 'ios', 'android', 'firebase', 'mobile', 'cross-platform'],
      status: CourseStatus.PUBLISHED,
      isPublished: true,
      publishedAt: new Date('2024-03-10'),
      totalEnrollments: 3200,
      totalRevenue: 32063.20,
      rating: 4.8,
      totalReviews: 418,
    },
  });

  // Course 4 — UI/UX Design (paid, published)
  const designCourse = await prisma.course.create({
    data: {
      title: 'UI/UX Design Masterclass — Figma to Prototype',
      slug: 'ui-ux-design-masterclass-figma-to-prototype',
      description: 'Learn UX research, wireframing, visual design, and prototyping using Figma. Design real apps from scratch, understand design systems, accessibility, and hand off designs to developers. Land a design job or go freelance.',
      shortDescription: 'Master UX research + Figma design — build a portfolio with 6 real projects.',
      instructorId: maya.id,
      categoryId: design.id,
      price: 79.99,
      discountPrice: 12.99,
      currency: 'USD',
      level: CourseLevel.BEGINNER,
      duration: 2160,
      language: 'en',
      requirements: ['No design experience needed', 'A computer with internet (Figma is browser-based and free)'],
      objectives: [
        'Master Figma from scratch',
        'Conduct UX research and user interviews',
        'Create wireframes and low-fidelity prototypes',
        'Build high-fidelity UI designs',
        'Design and document a complete design system',
        'Create micro-interactions and animations in Figma',
        'Prepare handoff files for developers',
        'Build a professional portfolio',
      ],
      tags: ['ux', 'ui', 'figma', 'design', 'prototype', 'wireframe', 'user-experience'],
      status: CourseStatus.PUBLISHED,
      isPublished: true,
      publishedAt: new Date('2024-02-20'),
      totalEnrollments: 2100,
      totalRevenue: 16797.90,
      rating: 4.7,
      totalReviews: 287,
    },
  });

  // Course 5 — Git & GitHub (FREE, published)
  const gitCourse = await prisma.course.create({
    data: {
      title: 'Git & GitHub: Complete Beginner to Advanced',
      slug: 'git-github-complete-beginner-to-advanced',
      description: 'Master version control with Git and GitHub. Learn branching, merging, rebasing, pull requests, GitHub Actions CI/CD, and collaborative workflows. Free course — no payment needed.',
      shortDescription: 'Learn Git and GitHub for free — from first commit to CI/CD pipelines.',
      instructorId: john.id,
      categoryId: webDev.id,
      price: 0,
      currency: 'USD',
      level: CourseLevel.BEGINNER,
      duration: 480,
      language: 'en',
      requirements: ['A computer with internet access', 'No programming experience needed'],
      objectives: [
        'Understand version control concepts',
        'Use Git for daily development workflows',
        'Work with remote repositories on GitHub',
        'Collaborate with pull requests and code reviews',
        'Automate workflows with GitHub Actions',
      ],
      tags: ['git', 'github', 'version-control', 'devops', 'free'],
      status: CourseStatus.PUBLISHED,
      isPublished: true,
      publishedAt: new Date('2024-01-20'),
      totalEnrollments: 12400,
      totalRevenue: 0,
      rating: 4.6,
      totalReviews: 1205,
    },
  });

  // Course 6 — NestJS (paid, published)
  const nestjsCourse = await prisma.course.create({
    data: {
      title: 'NestJS: Build Production-Ready APIs',
      slug: 'nestjs-build-production-ready-apis',
      description: 'Build enterprise-grade REST APIs with NestJS, TypeScript, PostgreSQL and Prisma. Covers authentication, authorization, validation, testing, Docker, and deployment to AWS. The most complete NestJS course available.',
      shortDescription: 'Build and deploy real APIs with NestJS + Prisma + PostgreSQL + Docker.',
      instructorId: john.id,
      categoryId: webDev.id,
      price: 94.99,
      discountPrice: 15.99,
      currency: 'USD',
      level: CourseLevel.INTERMEDIATE,
      duration: 2400,
      language: 'en',
      requirements: ['JavaScript / TypeScript basics', 'Basic knowledge of REST APIs'],
      objectives: [
        'Build scalable APIs with NestJS',
        'Model databases with Prisma ORM',
        'Implement JWT authentication and RBAC',
        'Write comprehensive unit and e2e tests',
        'Containerize with Docker and Docker Compose',
        'Deploy to AWS ECS / Railway / Render',
      ],
      tags: ['nestjs', 'nodejs', 'typescript', 'api', 'backend', 'postgresql', 'prisma'],
      status: CourseStatus.PUBLISHED,
      isPublished: true,
      publishedAt: new Date('2024-04-01'),
      totalEnrollments: 1850,
      totalRevenue: 17562.50,
      rating: 4.9,
      totalReviews: 234,
    },
  });

  console.log('📚  Created 6 courses (5 paid, 1 free)');

  // ── 6. Sections & Lessons ────────────────────────────────────────────────────

  // React course — 3 sections
  const r1 = await prisma.section.create({ data: { title: 'React Fundamentals',            courseId: reactCourse.id, sortOrder: 1, isPublished: true, description: 'Core React concepts every developer must know' } });
  const r2 = await prisma.section.create({ data: { title: 'Hooks Deep Dive',               courseId: reactCourse.id, sortOrder: 2, isPublished: true, description: 'Master all built-in hooks and build custom ones' } });
  const r3 = await prisma.section.create({ data: { title: 'State Management',              courseId: reactCourse.id, sortOrder: 3, isPublished: true, description: 'Redux Toolkit, Zustand, and React Query' } });

  const reactLessons = [
    { title: 'What is React and why use it?',         sectionId: r1.id, sortOrder: 1, videoDuration: 540,  isPreview: true  },
    { title: 'Setting up the development environment',sectionId: r1.id, sortOrder: 2, videoDuration: 720,  isPreview: false },
    { title: 'JSX and the Virtual DOM',               sectionId: r1.id, sortOrder: 3, videoDuration: 660,  isPreview: false },
    { title: 'Components and Props',                  sectionId: r1.id, sortOrder: 4, videoDuration: 900,  isPreview: false },
    { title: 'useState and event handling',           sectionId: r2.id, sortOrder: 1, videoDuration: 840,  isPreview: true  },
    { title: 'useEffect — side effects explained',    sectionId: r2.id, sortOrder: 2, videoDuration: 960,  isPreview: false },
    { title: 'useCallback, useMemo, useRef',          sectionId: r2.id, sortOrder: 3, videoDuration: 1020, isPreview: false },
    { title: 'Building custom hooks',                 sectionId: r2.id, sortOrder: 4, videoDuration: 780,  isPreview: false },
    { title: 'Redux Toolkit — setup and slices',      sectionId: r3.id, sortOrder: 1, videoDuration: 1080, isPreview: false },
    { title: 'React Query (TanStack) — data fetching',sectionId: r3.id, sortOrder: 2, videoDuration: 1140, isPreview: false },
  ];
  await Promise.all(reactLessons.map((l) => prisma.lesson.create({ data: { ...l, isPublished: true } })));

  // Python course — 3 sections
  const p1 = await prisma.section.create({ data: { title: 'Python Foundations',       courseId: pythonCourse.id, sortOrder: 1, isPublished: true, description: 'Variables, loops, functions and OOP' } });
  const p2 = await prisma.section.create({ data: { title: 'Data Analysis with Pandas',courseId: pythonCourse.id, sortOrder: 2, isPublished: true, description: 'Load, clean and analyse real datasets' } });
  const p3 = await prisma.section.create({ data: { title: 'Machine Learning',         courseId: pythonCourse.id, sortOrder: 3, isPublished: true, description: 'Supervised and unsupervised learning with Scikit-Learn' } });

  const pythonLessons = [
    { title: 'Why Python for Data Science?',          sectionId: p1.id, sortOrder: 1, videoDuration: 480,  isPreview: true  },
    { title: 'Variables, data types, and operators',  sectionId: p1.id, sortOrder: 2, videoDuration: 720,  isPreview: false },
    { title: 'Functions and modules',                 sectionId: p1.id, sortOrder: 3, videoDuration: 840,  isPreview: false },
    { title: 'Object-Oriented Python',                sectionId: p1.id, sortOrder: 4, videoDuration: 960,  isPreview: false },
    { title: 'Pandas Series and DataFrames',          sectionId: p2.id, sortOrder: 1, videoDuration: 1020, isPreview: true  },
    { title: 'Cleaning and transforming data',        sectionId: p2.id, sortOrder: 2, videoDuration: 1080, isPreview: false },
    { title: 'Groupby, merge, and pivot tables',      sectionId: p2.id, sortOrder: 3, videoDuration: 900,  isPreview: false },
    { title: 'What is Machine Learning?',             sectionId: p3.id, sortOrder: 1, videoDuration: 600,  isPreview: true  },
    { title: 'Linear and Logistic Regression',        sectionId: p3.id, sortOrder: 2, videoDuration: 1140, isPreview: false },
    { title: 'Decision Trees and Random Forests',     sectionId: p3.id, sortOrder: 3, videoDuration: 1200, isPreview: false },
  ];
  await Promise.all(pythonLessons.map((l) => prisma.lesson.create({ data: { ...l, isPublished: true } })));

  // Flutter course — 3 sections
  const f1 = await prisma.section.create({ data: { title: 'Dart Language Basics',     courseId: flutterCourse.id, sortOrder: 1, isPublished: true } });
  const f2 = await prisma.section.create({ data: { title: 'Flutter Widgets & Layout', courseId: flutterCourse.id, sortOrder: 2, isPublished: true } });
  const f3 = await prisma.section.create({ data: { title: 'State Management',         courseId: flutterCourse.id, sortOrder: 3, isPublished: true } });

  await Promise.all([
    prisma.lesson.create({ data: { title: 'Introduction to Dart',            sectionId: f1.id, sortOrder: 1, videoDuration: 540,  isPreview: true,  isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Dart classes and null safety',     sectionId: f1.id, sortOrder: 2, videoDuration: 720,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'async/await and Futures in Dart',  sectionId: f1.id, sortOrder: 3, videoDuration: 660,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Your first Flutter app',           sectionId: f2.id, sortOrder: 1, videoDuration: 780,  isPreview: true,  isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Stateless vs Stateful Widgets',    sectionId: f2.id, sortOrder: 2, videoDuration: 840,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Flexbox layout with Row & Column', sectionId: f2.id, sortOrder: 3, videoDuration: 900,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'State management with Provider',   sectionId: f3.id, sortOrder: 1, videoDuration: 960,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Riverpod — modern state management',sectionId: f3.id, sortOrder: 2, videoDuration: 1020, isPreview: false, isPublished: true } }),
  ]);

  // Design course — 2 sections
  const d1 = await prisma.section.create({ data: { title: 'UX Research & Wireframing', courseId: designCourse.id, sortOrder: 1, isPublished: true } });
  const d2 = await prisma.section.create({ data: { title: 'Figma Visual Design',       courseId: designCourse.id, sortOrder: 2, isPublished: true } });

  await Promise.all([
    prisma.lesson.create({ data: { title: 'What is UX Design?',               sectionId: d1.id, sortOrder: 1, videoDuration: 480,  isPreview: true,  isPublished: true } }),
    prisma.lesson.create({ data: { title: 'User research methods',             sectionId: d1.id, sortOrder: 2, videoDuration: 720,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Low-fidelity wireframing',          sectionId: d1.id, sortOrder: 3, videoDuration: 660,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Figma tour and setup',              sectionId: d2.id, sortOrder: 1, videoDuration: 540,  isPreview: true,  isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Typography and color systems',      sectionId: d2.id, sortOrder: 2, videoDuration: 840,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Building a design system',          sectionId: d2.id, sortOrder: 3, videoDuration: 960,  isPreview: false, isPublished: true } }),
  ]);

  // Git course — 2 sections
  const g1 = await prisma.section.create({ data: { title: 'Git Basics',       courseId: gitCourse.id, sortOrder: 1, isPublished: true } });
  const g2 = await prisma.section.create({ data: { title: 'GitHub & CI/CD',   courseId: gitCourse.id, sortOrder: 2, isPublished: true } });

  await Promise.all([
    prisma.lesson.create({ data: { title: 'Why version control?',          sectionId: g1.id, sortOrder: 1, videoDuration: 360,  isPreview: true,  isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Git init, add, commit',         sectionId: g1.id, sortOrder: 2, videoDuration: 540,  isPreview: true,  isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Branching and merging',         sectionId: g1.id, sortOrder: 3, videoDuration: 660,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Push, pull, and remotes',       sectionId: g2.id, sortOrder: 1, videoDuration: 480,  isPreview: true,  isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Pull requests and code review', sectionId: g2.id, sortOrder: 2, videoDuration: 600,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'GitHub Actions CI/CD',          sectionId: g2.id, sortOrder: 3, videoDuration: 720,  isPreview: false, isPublished: true } }),
  ]);

  // NestJS course — 2 sections
  const n1 = await prisma.section.create({ data: { title: 'NestJS Core Concepts',     courseId: nestjsCourse.id, sortOrder: 1, isPublished: true } });
  const n2 = await prisma.section.create({ data: { title: 'Auth, Testing & Deploy',   courseId: nestjsCourse.id, sortOrder: 2, isPublished: true } });

  await Promise.all([
    prisma.lesson.create({ data: { title: 'Why NestJS?',                    sectionId: n1.id, sortOrder: 1, videoDuration: 480,  isPreview: true,  isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Modules, Controllers, Services', sectionId: n1.id, sortOrder: 2, videoDuration: 720,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Prisma ORM setup',               sectionId: n1.id, sortOrder: 3, videoDuration: 840,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'JWT Auth & Guards',              sectionId: n2.id, sortOrder: 1, videoDuration: 960,  isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Unit & e2e testing with Jest',   sectionId: n2.id, sortOrder: 2, videoDuration: 1080, isPreview: false, isPublished: true } }),
    prisma.lesson.create({ data: { title: 'Docker & Railway deployment',    sectionId: n2.id, sortOrder: 3, videoDuration: 900,  isPreview: false, isPublished: true } }),
  ]);

  console.log('📝  Created sections and lessons for all 6 courses');

  // ── 7. Enrollments, Reviews, Wishlist, Certificates ─────────────────────────

  // Alice enrolled in React + Python + Git (free)
  const [, , enr3] = await Promise.all([
    prisma.enrollment.create({ data: { userId: alice.id, courseId: reactCourse.id,  price: 14.99, currency: 'USD', progressPercentage: 40 } }),
    prisma.enrollment.create({ data: { userId: alice.id, courseId: pythonCourse.id, price: 19.99, currency: 'USD', progressPercentage: 10 } }),
    prisma.enrollment.create({ data: { userId: alice.id, courseId: gitCourse.id,    price: 0,     currency: 'USD', progressPercentage: 100, completedAt: new Date('2024-05-01') } }),
  ]);

  // Bob enrolled in Python + Flutter
  await Promise.all([
    prisma.enrollment.create({ data: { userId: bob.id, courseId: pythonCourse.id,  price: 19.99, currency: 'USD', progressPercentage: 65 } }),
    prisma.enrollment.create({ data: { userId: bob.id, courseId: flutterCourse.id, price: 16.99, currency: 'USD', progressPercentage: 25 } }),
  ]);

  // Certificate for Alice completing Git course
  await prisma.certificate.create({
    data: {
      enrollmentId:      enr3.id,
      userId:            alice.id,
      courseId:          gitCourse.id,
      certificateNumber: `CERT-${Date.now()}-ALICE`,
      issuedAt:          new Date('2024-05-01'),
    },
  });

  // Reviews
  await Promise.all([
    prisma.review.create({ data: { userId: alice.id, courseId: reactCourse.id,   rating: 5, title: 'Best React course out there!',          content: 'John explains everything incredibly clearly. The TypeScript integration is exactly what I needed. Already got a job offer after taking this!', isVerifiedPurchase: true } }),
    prisma.review.create({ data: { userId: alice.id, courseId: gitCourse.id,     rating: 5, title: 'Perfect for beginners',                  content: 'I finally understand Git! The GitHub Actions section alone is worth it. And it\'s free — incredible value.', isVerifiedPurchase: true } }),
    prisma.review.create({ data: { userId: bob.id,   courseId: pythonCourse.id,  rating: 5, title: 'Sarah is an outstanding instructor',      content: 'Coming from a finance background with zero coding experience — this course changed my career. The ML projects are real and impressive.', isVerifiedPurchase: true } }),
    prisma.review.create({ data: { userId: bob.id,   courseId: flutterCourse.id, rating: 4, title: 'Great Flutter fundamentals',              content: 'Carlos teaches Dart and Flutter really well. Would love more content on Riverpod but overall excellent.', isVerifiedPurchase: true } }),
  ]);

  // Wishlists
  await Promise.all([
    prisma.wishlist.create({ data: { userId: alice.id, courseId: flutterCourse.id } }),
    prisma.wishlist.create({ data: { userId: alice.id, courseId: designCourse.id  } }),
    prisma.wishlist.create({ data: { userId: bob.id,   courseId: nestjsCourse.id  } }),
    prisma.wishlist.create({ data: { userId: bob.id,   courseId: reactCourse.id   } }),
  ]);

  console.log('⭐  Created enrollments, reviews, wishlists, and 1 certificate');

  // ── 8. Coupons ───────────────────────────────────────────────────────────────

  await Promise.all([
    prisma.coupon.create({
      data: {
        code: 'WELCOME50', name: 'Welcome — 50% Off',
        description: 'Half price on your first course',
        discountType: 'percentage', discountValue: 50,
        minimumAmount: 20, maximumDiscount: 50,
        usageLimit: 500, validFrom: new Date(),
        validUntil: new Date(Date.now() + 90 * 864e5),
        applicableCourses: [],
      },
    }),
    prisma.coupon.create({
      data: {
        code: 'STUDENT20', name: 'Student Discount',
        description: '20% off for students',
        discountType: 'percentage', discountValue: 20,
        usageLimit: 10000, validFrom: new Date(),
        validUntil: new Date(Date.now() + 365 * 864e5),
        applicableCourses: [],
      },
    }),
    prisma.coupon.create({
      data: {
        code: 'REACT10', name: '$10 Off React Course',
        description: 'Fixed $10 discount on the React course',
        discountType: 'fixed', discountValue: 10,
        minimumAmount: 15,
        usageLimit: 200, validFrom: new Date(),
        validUntil: new Date(Date.now() + 30 * 864e5),
        applicableCourses: [reactCourse.id],
      },
    }),
    prisma.coupon.create({
      data: {
        code: 'LAUNCH2024', name: 'Launch Special — 30% Off',
        description: '30% off any course — limited time',
        discountType: 'percentage', discountValue: 30,
        maximumDiscount: 30,
        usageLimit: 1000, validFrom: new Date(),
        validUntil: new Date(Date.now() + 14 * 864e5),
        applicableCourses: [],
      },
    }),
  ]);

  console.log('🎟️  Created 4 coupons (WELCOME50, STUDENT20, REACT10, LAUNCH2024)');

  // ── 9. Availability slots ────────────────────────────────────────────────────

  const [johnProfile, sarahProfile, mayaProfile, carlosProfile] = await Promise.all([
    prisma.instructorProfile.findFirst({ where: { userId: john.id   } }),
    prisma.instructorProfile.findFirst({ where: { userId: sarah.id  } }),
    prisma.instructorProfile.findFirst({ where: { userId: maya.id   } }),
    prisma.instructorProfile.findFirst({ where: { userId: carlos.id } }),
  ]);

  const slots = [
    { instructorId: johnProfile!.id,   dayOfWeek: 1, startTime: '09:00', endTime: '17:00', timezone: 'America/New_York',  sessionDuration: 60 },
    { instructorId: johnProfile!.id,   dayOfWeek: 3, startTime: '09:00', endTime: '17:00', timezone: 'America/New_York',  sessionDuration: 60 },
    { instructorId: sarahProfile!.id,  dayOfWeek: 2, startTime: '10:00', endTime: '16:00', timezone: 'America/Los_Angeles', sessionDuration: 90 },
    { instructorId: sarahProfile!.id,  dayOfWeek: 4, startTime: '10:00', endTime: '16:00', timezone: 'America/Los_Angeles', sessionDuration: 90 },
    { instructorId: mayaProfile!.id,   dayOfWeek: 5, startTime: '11:00', endTime: '15:00', timezone: 'Europe/London',     sessionDuration: 60 },
    { instructorId: carlosProfile!.id, dayOfWeek: 1, startTime: '14:00', endTime: '20:00', timezone: 'America/Chicago',   sessionDuration: 60 },
    { instructorId: carlosProfile!.id, dayOfWeek: 6, startTime: '10:00', endTime: '14:00', timezone: 'America/Chicago',   sessionDuration: 60 },
  ];
  await Promise.all(slots.map((s) => prisma.availabilitySlot.create({ data: s })));

  console.log('📅  Created 7 instructor availability slots');

  // ── 10. Course analytics ─────────────────────────────────────────────────────

  const courses = [reactCourse, pythonCourse, flutterCourse, designCourse, gitCourse, nestjsCourse];
  await Promise.all(
    courses.map((c) =>
      prisma.courseAnalytics.create({
        data: {
          courseId:        c.id,
          totalViews:      c.totalEnrollments * 4,
          totalEnrollments: c.totalEnrollments,
          totalRevenue:    Number(c.totalRevenue),
          completionRate:  Math.random() * 30 + 55,
          averageWatchTime: Math.floor(Math.random() * 60 + 40),
          averageRating:   Number(c.rating),
          totalReviews:    c.totalReviews,
          conversionRate:  Math.random() * 5 + 3,
        },
      }),
    ),
  );

  console.log('📈  Created course analytics');

  // ── 11. Notifications ────────────────────────────────────────────────────────

  await Promise.all([
    prisma.notification.create({ data: { userId: alice.id, type: NotificationType.ENROLLMENT,    title: 'Welcome to React & TypeScript!',    message: 'Your enrollment in "Complete React & TypeScript Developer 2024" is confirmed. Start learning now!', isRead: true } }),
    prisma.notification.create({ data: { userId: alice.id, type: NotificationType.PROGRESS,      title: 'Lesson Completed ✓',               message: 'You completed "What is React and why use it?" — keep going!', isRead: true } }),
    prisma.notification.create({ data: { userId: alice.id, type: NotificationType.PROGRESS,      title: 'Course Completed! 🎉',             message: 'Congratulations! You completed "Git & GitHub" and earned your certificate.', isRead: false } }),
    prisma.notification.create({ data: { userId: bob.id,   type: NotificationType.NEW_ENROLLMENT, title: 'New student enrolled',             message: 'Alice Wilson enrolled in your "Complete React & TypeScript Developer 2024" course.', isRead: false } }),
    prisma.notification.create({ data: { userId: alice.id, type: NotificationType.PAYMENT_SUCCESS, title: 'Payment Successful',             message: 'Payment of USD 14.99 for "Complete React & TypeScript Developer 2024" confirmed.', isRead: true } }),
  ]);

  console.log('🔔  Created sample notifications');

  // ── 12. System settings ──────────────────────────────────────────────────────

  await Promise.all([
    prisma.systemSettings.create({ data: { key: 'platform_name',           value: 'EduBridge',                          description: 'Platform display name',              isPublic: true  } }),
    prisma.systemSettings.create({ data: { key: 'platform_tagline',        value: 'Learn. Build. Grow.',                description: 'Platform tagline',                   isPublic: true  } }),
    prisma.systemSettings.create({ data: { key: 'instructor_revenue_share',value: '70',                                 description: 'Instructor cut % of course sale',    isPublic: false } }),
    prisma.systemSettings.create({ data: { key: 'max_video_size_mb',       value: '2048',                               description: 'Maximum video upload size in MB',    isPublic: false } }),
    prisma.systemSettings.create({ data: { key: 'support_email',           value: 'support@edubridge.com',              description: 'Customer support email',             isPublic: true  } }),
    prisma.systemSettings.create({ data: { key: 'min_lessons_to_publish',  value: '1',                                  description: 'Min lessons required before publish',isPublic: false } }),
    prisma.systemSettings.create({ data: { key: 'free_preview_limit',      value: '2',                                  description: 'Max free preview lessons per course',isPublic: false } }),
    prisma.systemSettings.create({ data: { key: 'session_reminder_minutes',value: '15',                                 description: 'Minutes before live session reminder',isPublic: false } }),
  ]);

  console.log('⚙️  Created 8 system settings');

  // ── Final summary ─────────────────────────────────────────────────────────────

  const counts = await Promise.all([
    prisma.user.count(), prisma.category.count(), prisma.course.count(),
    prisma.section.count(), prisma.lesson.count(), prisma.enrollment.count(),
    prisma.review.count(), prisma.coupon.count(), prisma.certificate.count(),
    prisma.notification.count(), prisma.availabilitySlot.count(),
  ]);

  console.log(`
✅  Database seeded successfully!

📊  Summary:
   ${counts[0]}  users               ${counts[1]}  categories
   ${counts[2]}  courses             ${counts[3]}  sections
   ${counts[4]}  lessons             ${counts[5]}  enrollments
   ${counts[6]}  reviews             ${counts[7]}  coupons
   ${counts[8]}  certificates        ${counts[9]}  notifications
   ${counts[10]} availability slots

🔐  Test Accounts (password: Password123!):
   superadmin@edubridge.com  →  SUPER_ADMIN
   admin@edubridge.com       →  ADMIN
   john@edubridge.com        →  INSTRUCTOR  (React, Git, NestJS)
   sarah@edubridge.com       →  INSTRUCTOR  (Python / Data Science)
   maya@edubridge.com        →  INSTRUCTOR  (UI/UX Design)
   carlos@edubridge.com      →  INSTRUCTOR  (Flutter)
   alice@edubridge.com       →  STUDENT     (enrolled in 3 courses)
   bob@edubridge.com         →  STUDENT     (enrolled in 2 courses)

🎟️  Active Coupons:
   WELCOME50   →  50% off any course (max $50)
   STUDENT20   →  20% off any course
   REACT10     →  $10 off React course
   LAUNCH2024  →  30% off any course (14 days)
  `);
}

main()
  .catch((e) => {
    console.error('\n❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
