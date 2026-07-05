import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaQueue } from '../database/entities/media-queue.entity';
import { MergeJob } from '../database/entities/merge-job.entity';
import { FFmpegService } from './ffmpeg.service';
import { MergeQueueService } from './merge-queue.service';

@Module({
  imports: [TypeOrmModule.forFeature([MediaQueue, MergeJob])],
  providers: [FFmpegService, MergeQueueService],
  exports: [FFmpegService, MergeQueueService],
})
export class QueueModule {}
