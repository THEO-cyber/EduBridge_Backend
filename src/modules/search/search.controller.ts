import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SearchService, SearchDto } from './search.service';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Search')
@Public()
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Search courses with filters and full-text matching' })
  search(@Query() dto: SearchDto) {
    return this.searchService.searchCourses(dto);
  }

  @Get('suggestions')
  @ApiOperation({ summary: 'Get autocomplete suggestions as user types' })
  @ApiQuery({ name: 'q', type: String })
  suggestions(@Query('q') q: string) {
    return this.searchService.getSearchSuggestions(q);
  }

  @Get('categories')
  @ApiOperation({ summary: 'Get popular course categories' })
  categories() {
    return this.searchService.getPopularCategories();
  }

  @Get('featured')
  @ApiOperation({ summary: 'Get featured / top-rated courses' })
  featured() {
    return this.searchService.getFeaturedCourses();
  }
}
