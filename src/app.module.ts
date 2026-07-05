import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaQueue } from './database/entities/media-queue.entity';
import { MergeJob } from './database/entities/merge-job.entity';
import { BotModule } from './bot/bot.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    // Global Configuration Module
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    
    // SQLite Database Configuration
    TypeOrmModule.forRoot({
      type: 'sqlite' as any,
      database: 'database.sqlite',
      entities: [MediaQueue, MergeJob],
      synchronize: true, // Automatically synchronize DB tables in dev
      logging: false,
    }),
    
    // Application Modules
    BotModule,
    QueueModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
