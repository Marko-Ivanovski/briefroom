import { BookmarkCreate, type BookmarkCreated, type BookmarkSummary } from '@briefroom/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { UserRateLimit } from '../rate-limit/rate-limit.ts';
import { BookmarksService } from './bookmarks.service.ts';

@Controller('v1/bookmarks')
export class BookmarksController {
  constructor(private readonly bookmarks: BookmarksService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData): Promise<BookmarkSummary[]> {
    return this.bookmarks.list(user.id);
  }

  @UserRateLimit(10)
  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() body: unknown): Promise<BookmarkCreated> {
    const parsed = BookmarkCreate.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_invite_url',
        message: 'That is not a Briefroom invite link.',
      });
    }
    return this.bookmarks.create({ userId: user.id, via: 'web' }, parsed.data.inviteUrl);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: CurrentUserData, @Param('id') id: string): Promise<void> {
    return this.bookmarks.remove(user.id, id);
  }
}
