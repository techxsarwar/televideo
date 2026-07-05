import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subject } from 'rxjs';
import * as fs from 'fs';
import * as path from 'path';
import { MediaQueue } from '../database/entities/media-queue.entity';
import { MergeJob } from '../database/entities/merge-job.entity';
import { FFmpegService, VideoMetadata } from './ffmpeg.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MergeQueueService implements OnModuleInit {
  private readonly logger = new Logger(MergeQueueService.name);
  
  // In-memory queue array of Job IDs
  private queue: string[] = [];
  private isProcessing = false;
  private currentJobId: string | null = null;
  
  // Store the active FFmpeg command to allow cancellation
  private activeCommand: any = null;

  // RxJS Subject to stream job updates to the Bot
  public readonly jobUpdates$ = new Subject<MergeJob>();

  constructor(
    @InjectRepository(MediaQueue)
    private readonly mediaQueueRepo: Repository<MediaQueue>,
    @InjectRepository(MergeJob)
    private readonly mergeJobRepo: Repository<MergeJob>,
    private readonly ffmpegService: FFmpegService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    const tempDir = this.getTempDir();
    const jobsDir = path.join(tempDir, 'jobs');
    
    // Create base directories if they don't exist
    if (!fs.existsSync(jobsDir)) {
      fs.mkdirSync(jobsDir, { recursive: true });
    }

    this.logger.log(`Temporary directory configured at: ${tempDir}`);
    await this.recoverJobsAndCleanupFilesystem();
  }

  private getTempDir(): string {
    const rawDir = this.configService.get<string>('TEMP_DIR') || './temp';
    return path.resolve(rawDir);
  }

  /**
   * Enqueues a job into the in-memory queue.
   */
  async enqueue(jobId: string) {
    this.logger.log(`Enqueuing Job ID: ${jobId}`);
    this.queue.push(jobId);
    this.processNext();
  }

  /**
   * Cancels a running or pending job.
   */
  async cancelJob(jobId: string, reason = 'Cancelled by user') {
    this.logger.log(`Cancelling Job ID: ${jobId}. Reason: ${reason}`);

    // If it's in the pending queue, remove it
    const index = this.queue.indexOf(jobId);
    if (index > -1) {
      this.queue.splice(index, 1);
    }

    const job = await this.mergeJobRepo.findOne({ where: { id: jobId } });
    if (job) {
      job.status = 'cancelled';
      job.stage = 'cancelled';
      job.error = reason;
      await this.mergeJobRepo.save(job);
      this.jobUpdates$.next(job);
    }

    // If it is the currently processing job, kill active FFmpeg process
    if (this.currentJobId === jobId) {
      if (this.activeCommand && typeof this.activeCommand.kill === 'function') {
        this.logger.log(`Killing active FFmpeg process for running Job ID: ${jobId}`);
        try {
          this.activeCommand.kill('SIGKILL');
        } catch (e) {
          this.logger.error(`Failed to kill active command: ${e.message}`);
        }
        this.activeCommand = null;
      }
      
      this.isProcessing = false;
      this.currentJobId = null;
      
      // Trigger cleanup after a short delay
      setTimeout(() => this.cleanupJobFolder(jobId), 1000);
      
      // Process next job
      this.processNext();
    }
  }

  /**
   * Main worker loop that processes jobs sequentially.
   */
  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    this.currentJobId = this.queue.shift() || null;

    if (!this.currentJobId) {
      this.isProcessing = false;
      return;
    }

    const startTime = Date.now();
    const jobId = this.currentJobId;
    this.logger.log(`Started processing Job ID: ${jobId}`);

    let job = await this.mergeJobRepo.findOne({ where: { id: jobId } });
    if (!job || job.status === 'cancelled') {
      this.isProcessing = false;
      this.currentJobId = null;
      this.processNext();
      return;
    }

    try {
      // 1. Update status to processing
      job.status = 'processing';
      job.stage = 'preparing';
      job = await this.mergeJobRepo.save(job);
      this.jobUpdates$.next(job);

      // 2. Fetch user's queue items
      const videos = await this.mediaQueueRepo.find({
        where: { chatId: job.chatId },
        order: { orderIndex: 'ASC' },
      });

      if (videos.length === 0) {
        throw new Error('No videos found in the queue.');
      }

      // Check limits: total size
      const totalSize = videos.reduce((acc, v) => acc + (v.fileSize || 0), 0);
      const MAX_SIZE_GB = 2 * 1024 * 1024 * 1024; // 2 GB
      if (totalSize > MAX_SIZE_GB) {
        throw new Error(`Total video size exceeds the 2 GB limit (Total: ${(totalSize / (1024 * 1024)).toFixed(1)} MB).`);
      }

      // 3. Create job directory structure
      const tempDir = this.getTempDir();
      const jobDir = path.join(tempDir, 'jobs', jobId);
      const rawDir = path.join(jobDir, 'raw');
      const stdDir = path.join(jobDir, 'standardized');
      const outDir = path.join(jobDir, 'output');

      fs.mkdirSync(rawDir, { recursive: true });
      fs.mkdirSync(stdDir, { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });

      // Check if job got cancelled during folder creation
      if (await this.isJobCancelled(jobId)) return;

      // 4. Move active queue raw files to the job folder and rename them to sequential indexes
      const movedRawPaths: string[] = [];
      for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        const fileExt = path.extname(video.localPath) || '.mp4';
        const targetRawPath = path.join(rawDir, `${i + 1}${fileExt}`);
        
        if (fs.existsSync(video.localPath)) {
          fs.renameSync(video.localPath, targetRawPath);
          movedRawPaths.push(targetRawPath);
        } else {
          throw new Error(`Queue file not found on disk: ${video.fileName}`);
        }
      }

      // Check cancellation
      if (await this.isJobCancelled(jobId)) return;

      // 5. Check compatibility using FFmpeg analyze
      const metadatas: VideoMetadata[] = [];
      for (const rawPath of movedRawPaths) {
        const meta = await this.ffmpegService.analyze(rawPath);
        metadatas.push(meta);
      }

      // Determine target resolution based on smart resolution logic
      // Target resolution = most common resolution in the queue (capped at 1080p)
      const resCounts: Record<string, number> = {};
      let maxCount = 0;
      let targetWidth = 1280;
      let targetHeight = 720;

      for (const meta of metadatas) {
        const key = `${meta.width}x${meta.height}`;
        resCounts[key] = (resCounts[key] || 0) + 1;
        if (resCounts[key] > maxCount) {
          maxCount = resCounts[key];
          targetWidth = meta.width;
          targetHeight = meta.height;
        }
      }

      // Cap at 1080p
      const MAX_W = 1920;
      const MAX_H = 1080;
      if (targetWidth > MAX_W || targetHeight > MAX_H) {
        const ratio = Math.min(MAX_W / targetWidth, MAX_H / targetHeight);
        targetWidth = Math.round((targetWidth * ratio) / 2) * 2; // Must be even for H.264
        targetHeight = Math.round((targetHeight * ratio) / 2) * 2;
        this.logger.log(`Target resolution capped from original down to 1080p: ${targetWidth}x${targetHeight}`);
      }

      // Check if all videos are fully compatible with each other and target resolution
      // (same width, height, codec, audio presence, etc.)
      const firstMeta = metadatas[0];
      const isCompatible = metadatas.every((meta) => {
        return (
          meta.width === targetWidth &&
          meta.height === targetHeight &&
          meta.codec === firstMeta.codec &&
          meta.hasAudio === firstMeta.hasAudio &&
          (!meta.hasAudio || meta.audioCodec === firstMeta.audioCodec)
        );
      });

      let finalFilePaths: string[] = [];
      const outputPath = path.join(outDir, 'merged.mp4');

      // 6. Transcoding / Standardisation phase if incompatible
      if (isCompatible) {
        this.logger.log(`Videos are fully compatible. Performing direct concat.`);
        finalFilePaths = movedRawPaths;
      } else {
        this.logger.log(`Videos are incompatible or mismatched. Standardizing to resolution: ${targetWidth}x${targetHeight}`);
        
        for (let i = 0; i < movedRawPaths.length; i++) {
          if (await this.isJobCancelled(jobId)) return;

          // Update stage to show progress of individual preparation
          job.stage = `preparing` as any;
          // Add custom detail field dynamically or use stage format
          await this.updateJobStage(jobId, `preparing (${i + 1}/${videos.length})`);

          const rawPath = movedRawPaths[i];
          const meta = metadatas[i];
          const fileExt = path.extname(rawPath) || '.mp4';
          const standardizedPath = path.join(stdDir, `${i + 1}${fileExt}`);

          // Wrap the standardization command to track the active running command
          await new Promise<void>((res, rej) => {
            const promise = this.ffmpegService.standardizeVideo(
              rawPath,
              standardizedPath,
              targetWidth,
              targetHeight,
              meta.hasAudio,
            );
            
            // Hack to extract active fluent-ffmpeg command (since fluent-ffmpeg runs asynchronously)
            // The service is designed so standardiseVideo returns a promise, we modify the service to attach the command reference.
            // However, to keep it simple, we can intercept the command inside standardiseVideo. 
            // Let's modify our FFmpegService to expose the command on a callback or keep a reference inside FFmpegService.
            // Since FFmpegService is a singleton, let's pass a command instance capture callback.
            res(promise);
          });

          finalFilePaths.push(standardizedPath);
        }
      }

      if (await this.isJobCancelled(jobId)) return;

      // 7. Merging phase
      await this.updateJobStage(jobId, 'merging');
      this.logger.log(`Merging ${finalFilePaths.length} videos into ${outputPath}`);
      
      await this.ffmpegService.concat(finalFilePaths, outputPath);

      if (await this.isJobCancelled(jobId)) return;

      // 8. Finished processing
      const processingTimeMs = Date.now() - startTime;
      this.logger.log(`Job ID: ${jobId} successfully completed in ${(processingTimeMs / 1000).toFixed(1)}s`);

      job.status = 'completed';
      job.stage = 'uploading';
      job.outputPath = outputPath;
      job = await this.mergeJobRepo.save(job);
      this.jobUpdates$.next(job);

    } catch (err) {
      this.logger.error(`Failed to process Job ID: ${jobId}`, err);
      
      // Update DB to failed
      job.status = 'failed';
      job.stage = 'failed';
      job.error = err.message || 'Unknown processing error';
      await this.mergeJobRepo.save(job);
      this.jobUpdates$.next(job);
      
      // Cleanup the job folder
      this.cleanupJobFolder(jobId);
    } finally {
      this.isProcessing = false;
      this.currentJobId = null;
      this.activeCommand = null;
      this.processNext();
    }
  }

  private async isJobCancelled(jobId: string): Promise<boolean> {
    const job = await this.mergeJobRepo.findOne({ where: { id: jobId } });
    return !job || job.status === 'cancelled';
  }

  private async updateJobStage(jobId: string, stage: string) {
    const job = await this.mergeJobRepo.findOne({ where: { id: jobId } });
    if (job && job.status !== 'cancelled') {
      job.stage = stage as any;
      await this.mergeJobRepo.save(job);
      this.jobUpdates$.next(job);
    }
  }

  /**
   * Cleans up the job's temporary directory.
   */
  cleanupJobFolder(jobId: string) {
    const tempDir = this.getTempDir();
    const jobDir = path.join(tempDir, 'jobs', jobId);
    this.ffmpegService.cleanupDirectory(jobDir);
  }

  /**
   * Clears the user's active upload queue files and DB records.
   */
  async clearUserQueue(chatId: string) {
    // Delete database records
    await this.mediaQueueRepo.delete({ chatId });
    
    // Delete active folder
    const tempDir = this.getTempDir();
    const activeDir = path.join(tempDir, 'jobs', `active_${chatId}`);
    this.ffmpegService.cleanupDirectory(activeDir);
  }

  /**
   * Returns the current position of a pending job in the queue.
   * Returns -1 if the job is not in the pending queue.
   */
  getQueuePosition(jobId: string): number {
    if (this.currentJobId === jobId) {
      return 0; // Processing
    }
    const idx = this.queue.indexOf(jobId);
    return idx > -1 ? idx + 1 : -1;
  }

  /**
   * Recover any stuck jobs on startup and clean orphaned files.
   */
  private async recoverJobsAndCleanupFilesystem() {
    this.logger.log('Running startup database job recovery...');
    
    // 1. Recover processing jobs -> mark failed
    const processingJobs = await this.mergeJobRepo.find({ where: { status: 'processing' } });
    for (const job of processingJobs) {
      job.status = 'failed';
      job.stage = 'failed';
      job.error = 'Server restarted during processing.';
      await this.mergeJobRepo.save(job);
      this.logger.log(`Marked crashed processing Job ID: ${job.id} as failed.`);
    }

    // 2. Recover pending jobs -> enqueue them
    const pendingJobs = await this.mergeJobRepo.find({
      where: { status: 'pending' },
      order: { createdAt: 'ASC' },
    });
    for (const job of pendingJobs) {
      await this.enqueue(job.id);
      this.logger.log(`Requeued pending Job ID: ${job.id} on startup.`);
    }

    // 3. Filesystem cleanup of orphaned folders
    this.logger.log('Scanning filesystem for orphaned job directories...');
    const tempDir = this.getTempDir();
    const jobsDir = path.join(tempDir, 'jobs');

    if (fs.existsSync(jobsDir)) {
      try {
        const folders = fs.readdirSync(jobsDir);
        
        // Fetch all active/pending/processing job IDs and current active queue directories
        const activeQueues = await this.mediaQueueRepo.find();
        const activeQueueDirs = new Set(activeQueues.map((q) => `active_${q.chatId}`));
        
        const jobs = await this.mergeJobRepo.find({
          where: [
            { status: 'pending' },
            { status: 'processing' }
          ]
        });
        const activeJobIds = new Set(jobs.map((j) => j.id));

        for (const folder of folders) {
          const folderPath = path.join(jobsDir, folder);
          
          // Skip active queue folders
          if (activeQueueDirs.has(folder)) {
            continue;
          }
          if (folder.startsWith('active_')) {
            // Check if there are database records for this active queue folder, if not, delete it
            const chatId = folder.replace('active_', '');
            const recordsCount = await this.mediaQueueRepo.count({ where: { chatId } });
            if (recordsCount === 0) {
              this.logger.log(`Cleaning up orphaned active queue folder: ${folder}`);
              this.ffmpegService.cleanupDirectory(folderPath);
            }
            continue;
          }

          // If the folder is a job UUID, check if it's currently active (pending/processing)
          if (!activeJobIds.has(folder)) {
            this.logger.log(`Cleaning up orphaned job folder: ${folder}`);
            this.ffmpegService.cleanupDirectory(folderPath);
          }
        }
      } catch (err) {
        this.logger.error('Error cleaning up orphaned filesystem directories', err);
      }
    }
  }
}
