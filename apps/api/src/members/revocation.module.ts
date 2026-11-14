import { Module } from '@nestjs/common';
import { RevocationService } from './revocation.service.ts';

@Module({ providers: [RevocationService], exports: [RevocationService] })
export class RevocationModule {}
