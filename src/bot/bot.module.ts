import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaQueue } from '../database/entities/media-queue.entity';
import { MergeJob } from '../database/entities/merge-job.entity';
import { QueueModule } from '../queue/queue.module';
import { BotService } from './bot.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([MediaQueue, MergeJob]),
    QueueModule,
  ],
  providers: [BotService],
})
export class BotModule {}
