import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import {
  UpdateProfileDto,
  UpdateStudentProfileDto,
  UpdateInstructorProfileDto,
} from './dto/update-profile.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, User } from '@prisma/client';

@ApiTags('Users')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get all users (Admin only)' })
  @ApiQuery({ name: 'role', required: false, enum: Role })
  async findAll(
    @Query() paginationDto: PaginationDto,
    @Query('role') role?: Role,
  ) {
    return this.usersService.findAll(paginationDto, role);
  }

  @Get('instructors')
  @ApiOperation({ summary: 'Get all instructors' })
  async getInstructors(@Query() paginationDto: PaginationDto) {
    return this.usersService.getInstructors(paginationDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  async findOne(@Param('id') id: string, @CurrentUser() currentUser: User) {
    // Users can view their own profile, admins can view any profile
    if (
      currentUser.id !== id &&
      currentUser.role !== Role.ADMIN &&
      currentUser.role !== Role.SUPER_ADMIN
    ) {
      throw new ForbiddenException('Cannot access other user profiles');
    }
    return this.usersService.findOne(id);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update user profile' })
  async updateProfile(
    @CurrentUser() user: User,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.id, updateProfileDto);
  }

  @Put('profile/student')
  @UseGuards(RolesGuard)
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: 'Update student profile' })
  async updateStudentProfile(
    @CurrentUser() user: User,
    @Body() updateDto: UpdateStudentProfileDto,
  ) {
    return this.usersService.updateStudentProfile(user.id, updateDto);
  }

  @Put('profile/instructor')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Update instructor profile' })
  async updateInstructorProfile(
    @CurrentUser() user: User,
    @Body() updateDto: UpdateInstructorProfileDto,
  ) {
    return this.usersService.updateInstructorProfile(user.id, updateDto);
  }

  @Delete('account')
  @ApiOperation({ summary: 'Delete user account' })
  async deleteAccount(@CurrentUser() user: User) {
    return this.usersService.deleteAccount(user.id);
  }
}
