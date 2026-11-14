import { BookmarkCreate, type BookmarkCreated, type BookmarkSummary } from '@briefroom/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { InstallService } from '../install/install.service.ts';
import { UserRateLimit } from '../rate-limit/rate-limit.ts';
import { BookmarksService } from './bookmarks.service.ts';

@Controller('v1/bookmarks')
export class BookmarksController {
  constructor(
    private readonly bookmarks: BookmarksService,
    private readonly installs: InstallService,
  ) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData): Promise<BookmarkSummary[]> {
    return this.bookmarks.list(user.id);
  }

  @UserRateLimit(10)
  @Post()
  async create(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
  ): Promise<BookmarkCreated> {
    // This makes the host fetch a user-supplied address (R97), so any account with an invite
    // link, including a declined one, must not reach it.
    if (!(await this.installs.isInstallOwner(user.id))) {
      throw new ForbiddenException('Only the install owner can add workspace bookmarks');
    }
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
