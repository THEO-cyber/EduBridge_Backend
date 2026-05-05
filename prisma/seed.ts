import { PrismaClient, Role, CourseStatus, CourseLevel } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Clean existing data (in development only)
  if (process.env.NODE_ENV === 'development') {
    console.log('🧹 Cleaning existing data...');
    await prisma.courseAnalytics.deleteMany();
    await prisma.userAnalytics.deleteMany();
    await prisma.certificate.deleteMany();
    await prisma.lessonProgress.deleteMany();
    await prisma.enrollment.deleteMany();
    await prisma.review.deleteMany();
    await prisma.wishlist.deleteMany();
    await prisma.chatMessage.deleteMany();
    await prisma.chatParticipant.deleteMany();
    await prisma.chat.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.attachment.deleteMany();
    await prisma.lesson.deleteMany();
    await prisma.section.deleteMany();
    await prisma.course.deleteMany();
    await prisma.category.deleteMany();
    await prisma.liveSession.deleteMany();
    await prisma.sessionRequest.deleteMany();
    await prisma.availabilitySlot.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.payout.deleteMany();
    await prisma.coupon.deleteMany();
    await prisma.instructorProfile.deleteMany();
    await prisma.studentProfile.deleteMany();
    await prisma.userAuth.deleteMany();
    await prisma.user.deleteMany();
  }

  // Create Users
  const hashedPassword = await bcrypt.hash('password123', 12);

  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@edubridge.com',
      username: 'admin',
      firstName: 'Admin',
      lastName: 'User',
      role: Role.ADMIN,
      isEmailVerified: true,
      userAuth: {
        create: {
          passwordHash: hashedPassword,
        },
      },
    },
  });

  const instructor1 = await prisma.user.create({
    data: {
      email: 'instructor@edubridge.com',
      username: 'instructor1',
      firstName: 'John',
      lastName: 'Smith',
      role: Role.INSTRUCTOR,
      isEmailVerified: true,
      bio: 'Experienced software developer with 10+ years in web development.',
      userAuth: {
        create: {
          passwordHash: hashedPassword,
        },
      },
      instructorProfile: {
        create: {
          title: 'Senior Software Developer',
          expertise: ['JavaScript', 'TypeScript', 'React', 'Node.js'],
          experience: '10+ years in software development',
          education: 'Computer Science, MIT',
          certifications: [
            'AWS Certified Developer',
            'Google Cloud Professional',
          ],
          hourlyRate: 75.0,
          isVerified: true,
          rating: 4.8,
          totalReviews: 150,
          totalStudents: 2500,
          totalRevenue: 15000.0,
        },
      },
    },
  });

  const instructor2 = await prisma.user.create({
    data: {
      email: 'sarah@edubridge.com',
      username: 'sarah_teacher',
      firstName: 'Sarah',
      lastName: 'Johnson',
      role: Role.INSTRUCTOR,
      isEmailVerified: true,
      bio: 'Data Science expert and machine learning enthusiast.',
      userAuth: {
        create: {
          passwordHash: hashedPassword,
        },
      },
      instructorProfile: {
        create: {
          title: 'Data Scientist',
          expertise: [
            'Python',
            'Machine Learning',
            'Data Analysis',
            'TensorFlow',
          ],
          experience: '8 years in data science and analytics',
          education: 'PhD in Statistics, Stanford University',
          certifications: [
            'Google Data Analytics Certificate',
            'IBM Data Science Professional',
          ],
          hourlyRate: 90.0,
          isVerified: true,
          rating: 4.9,
          totalReviews: 89,
          totalStudents: 1200,
          totalRevenue: 8500.0,
        },
      },
    },
  });

  const student1 = await prisma.user.create({
    data: {
      email: 'student@edubridge.com',
      username: 'student1',
      firstName: 'Alice',
      lastName: 'Wilson',
      role: Role.STUDENT,
      isEmailVerified: true,
      userAuth: {
        create: {
          passwordHash: hashedPassword,
        },
      },
      studentProfile: {
        create: {
          interests: ['Web Development', 'Mobile Apps', 'UI/UX Design'],
          learningGoals: 'Become a full-stack developer within 1 year',
        },
      },
    },
  });

  console.log('👥 Created users...');

  // Create Categories
  const webDevCategory = await prisma.category.create({
    data: {
      name: 'Web Development',
      slug: 'web-development',
      description: 'Learn to build modern web applications',
      icon: 'code',
      sortOrder: 1,
    },
  });

  const dataScienceCategory = await prisma.category.create({
    data: {
      name: 'Data Science',
      slug: 'data-science',
      description: 'Master data analysis and machine learning',
      icon: 'chart',
      sortOrder: 2,
    },
  });

  const mobileDevCategory = await prisma.category.create({
    data: {
      name: 'Mobile Development',
      slug: 'mobile-development',
      description: 'Build mobile applications for iOS and Android',
      icon: 'mobile',
      sortOrder: 3,
    },
  });

  // Create subcategories
  await prisma.category.create({
    data: {
      name: 'Frontend Development',
      slug: 'frontend-development',
      description: 'HTML, CSS, JavaScript, React, Vue.js',
      parentId: webDevCategory.id,
      sortOrder: 1,
    },
  });

  await prisma.category.create({
    data: {
      name: 'Backend Development',
      slug: 'backend-development',
      description: 'Node.js, Python, PHP, Databases',
      parentId: webDevCategory.id,
      sortOrder: 2,
    },
  });

  console.log('📂 Created categories...');

  // Create Courses
  const reactCourse = await prisma.course.create({
    data: {
      title: 'Complete React Developer Course 2024',
      slug: 'complete-react-developer-course-2024',
      description:
        'Master React.js by building real-world projects including a e-commerce application, todo app, and social media dashboard.',
      shortDescription:
        'Learn React.js from beginner to advanced with hands-on projects',
      instructorId: instructor1.id,
      categoryId: webDevCategory.id,
      price: 89.99,
      currency: 'USD',
      level: CourseLevel.INTERMEDIATE,
      duration: 2400, // 40 hours
      language: 'en',
      requirements: [
        'Basic JavaScript knowledge',
        'Understanding of HTML & CSS',
      ],
      objectives: [
        'Build modern React applications',
        'Understand React Hooks and Context API',
        'Deploy React apps to production',
        'Master state management with Redux',
      ],
      tags: ['react', 'javascript', 'frontend', 'web-development'],
      status: CourseStatus.PUBLISHED,
      isPublished: true,
      publishedAt: new Date(),
      totalEnrollments: 1520,
      totalRevenue: 136808.0,
      rating: 4.7,
      totalReviews: 89,
    },
  });

  const pythonCourse = await prisma.course.create({
    data: {
      title: 'Python for Data Science and Machine Learning',
      slug: 'python-for-data-science-machine-learning',
      description:
        'Complete Python course covering data analysis, visualization, and machine learning with practical projects.',
      shortDescription:
        'Master Python for data science with real-world projects',
      instructorId: instructor2.id,
      categoryId: dataScienceCategory.id,
      price: 129.99,
      currency: 'USD',
      level: CourseLevel.BEGINNER,
      duration: 3000, // 50 hours
      language: 'en',
      requirements: ['No prior programming experience required'],
      objectives: [
        'Master Python programming fundamentals',
        'Analyze data with Pandas and NumPy',
        'Create visualizations with Matplotlib',
        'Build machine learning models',
      ],
      tags: ['python', 'data-science', 'machine-learning', 'analytics'],
      status: CourseStatus.PUBLISHED,
      isPublished: true,
      publishedAt: new Date(),
      totalEnrollments: 890,
      totalRevenue: 115691.0,
      rating: 4.9,
      totalReviews: 45,
    },
  });

  console.log('📚 Created courses...');

  // Create Sections and Lessons
  const reactSection1 = await prisma.section.create({
    data: {
      title: 'Getting Started with React',
      description:
        'Introduction to React and setting up the development environment',
      courseId: reactCourse.id,
      sortOrder: 1,
      isPublished: true,
    },
  });

  await prisma.lesson.create({
    data: {
      title: 'What is React?',
      description: 'Understanding React library and its ecosystem',
      sectionId: reactSection1.id,
      sortOrder: 1,
      videoDuration: 480, // 8 minutes
      isPreview: true,
      isPublished: true,
    },
  });

  await prisma.lesson.create({
    data: {
      title: 'Setting up Development Environment',
      description: 'Installing Node.js, npm, and creating your first React app',
      sectionId: reactSection1.id,
      sortOrder: 2,
      videoDuration: 720, // 12 minutes
      isPublished: true,
    },
  });

  const pythonSection1 = await prisma.section.create({
    data: {
      title: 'Python Fundamentals',
      description: 'Learn Python basics and syntax',
      courseId: pythonCourse.id,
      sortOrder: 1,
      isPublished: true,
    },
  });

  await prisma.lesson.create({
    data: {
      title: 'Introduction to Python',
      description: 'What is Python and why use it for data science?',
      sectionId: pythonSection1.id,
      sortOrder: 1,
      videoDuration: 600, // 10 minutes
      isPreview: true,
      isPublished: true,
    },
  });

  console.log('📝 Created sections and lessons...');

  // Create Sample Enrollment
  const enrollment = await prisma.enrollment.create({
    data: {
      userId: student1.id,
      courseId: reactCourse.id,
      price: 89.99,
      currency: 'USD',
      progressPercentage: 15.5,
    },
  });

  // Create Sample Review
  await prisma.review.create({
    data: {
      userId: student1.id,
      courseId: reactCourse.id,
      rating: 5,
      title: 'Excellent Course!',
      content:
        'This course is amazing! The instructor explains everything clearly and the projects are very practical.',
      isVerifiedPurchase: true,
    },
  });

  console.log('⭐ Created enrollments and reviews...');

  // Create Availability Slots for Instructors
  const instructor1Profile = await prisma.instructorProfile.findFirst({
    where: { userId: instructor1.id },
  });

  const instructor2Profile = await prisma.instructorProfile.findFirst({
    where: { userId: instructor2.id },
  });

  if (instructor1Profile) {
    await prisma.availabilitySlot.create({
      data: {
        instructorId: instructor1Profile.id,
        dayOfWeek: 1, // Monday
        startTime: '09:00',
        endTime: '17:00',
        timezone: 'America/New_York',
        sessionDuration: 60,
        maxStudents: 1,
      },
    });
  }

  if (instructor2Profile) {
    await prisma.availabilitySlot.create({
      data: {
        instructorId: instructor2Profile.id,
        dayOfWeek: 2, // Tuesday
        startTime: '10:00',
        endTime: '16:00',
        timezone: 'America/Los_Angeles',
        sessionDuration: 90,
        maxStudents: 3,
      },
    });
  }
  console.log('📅 Created availability slots...');

  // Create Sample Coupon
  await prisma.coupon.create({
    data: {
      code: 'WELCOME20',
      name: 'Welcome Discount',
      description: '20% off for new students',
      discountType: 'percentage',
      discountValue: 20.0,
      minimumAmount: 50.0,
      usageLimit: 1000,
      usedCount: 45,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      applicableCourses: [reactCourse.id, pythonCourse.id],
    },
  });

  console.log('🎟️ Created coupons...');

  // Create System Settings
  await prisma.systemSettings.create({
    data: {
      key: 'site_name',
      value: 'EduBridge',
      description: 'The name of the platform',
      isPublic: true,
    },
  });

  await prisma.systemSettings.create({
    data: {
      key: 'max_file_size',
      value: '100000000',
      description: 'Maximum file upload size in bytes',
      isPublic: false,
    },
  });

  console.log('⚙️ Created system settings...');

  console.log('✅ Database seeded successfully!');
  console.log(`
📊 Created:
- ${await prisma.user.count()} users
- ${await prisma.category.count()} categories  
- ${await prisma.course.count()} courses
- ${await prisma.section.count()} sections
- ${await prisma.lesson.count()} lessons
- ${await prisma.enrollment.count()} enrollments
- ${await prisma.review.count()} reviews
- ${await prisma.availabilitySlot.count()} availability slots
- ${await prisma.coupon.count()} coupons

🔐 Test Accounts:
Admin: admin@edubridge.com / password123
Instructor: instructor@edubridge.com / password123  
Student: student@edubridge.com / password123
  `);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
