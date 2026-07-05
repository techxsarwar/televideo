import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telegraf, Markup } from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import { MediaQueue } from '../database/entities/media-queue.entity';
import { MergeJob } from '../database/entities/merge-job.entity';
import { MergeQueueService } from '../queue/merge-queue.service';
import { FFmpegService } from '../queue/ffmpeg.service';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot: Telegraf;
  
  // Tracks status message ID of active merge jobs for each chatId
  private activeJobMessages = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    private readonly queueService: MergeQueueService,
    private readonly ffmpegService: FFmpegService,
    @InjectRepository(MediaQueue)
    private readonly mediaQueueRepo: Repository<MediaQueue>,
    @InjectRepository(MergeJob)
    private readonly mergeJobRepo: Repository<MergeJob>,
  ) {}

  onModuleInit() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
      this.logger.warn('TELEGRAM_BOT_TOKEN is not configured in .env. Bot will not start.');
      return;
    }

    this.bot = new Telegraf(token);
    this.registerHandlers();
    
    this.bot.launch()
      .then(() => {
        this.logger.log('Telegram Bot successfully launched.');
      })
      .catch((err) => {
        this.logger.error('Failed to launch Telegram Bot', err);
      });

    // Subscribe to merge queue events
    this.queueService.jobUpdates$.subscribe((job) => {
      this.handleJobUpdate(job).catch((err) => {
        this.logger.error(`Error handling job update for Job ID: ${job.id}: ${err.message}`, err);
      });
    });
  }

  onModuleDestroy() {
    if (this.bot) {
      this.bot.stop('SIGINT');
      this.logger.log('Telegram Bot stopped.');
    }
  }

  /**
   * Registers all Telegram commands, message listeners, and callback buttons.
   */
  private registerHandlers() {
    // /start & /help
    const helpHandler = (ctx: any) => {
      ctx.reply(
        `🎥 *Welcome to the Telegram Video Merger Bot!* (v${this.configService.get('BOT_VERSION') || '1.0.0'})\n\n` +
        `Send me multiple video files, and I will merge them in your preferred order.\n\n` +
        `*Available Commands:*\n` +
        `• /queue - View and reorder your current video queue\n` +
        `• /status - Check the status of your active merge jobs\n` +
        `• /clear - Clear your video queue\n` +
        `• /version - Show current bot version\n\n` +
        `*Limits & Constraints:*\n` +
        `• Max videos in queue: *10*\n` +
        `• Max size per video: *20 MB* (Telegram API download limit)\n` +
        `• Max total queue size: *2 GB*\n` +
        `• Max output size: *50 MB* (Telegram API upload limit)\n` +
        `• Limit: *1 concurrent merge* per user`,
        { parse_mode: 'Markdown' }
      );
    };

    this.bot.start(helpHandler);
    this.bot.help(helpHandler);

    // /version
    this.bot.command('version', (ctx) => {
      ctx.reply(
        `🤖 *Televideo Bot*\n` +
        `• Version: \`${this.configService.get('BOT_VERSION') || '1.0.0'}\`\n` +
        `• Environment: \`${process.env.NODE_ENV || 'development'}\`\n` +
        `• Platform: \`${process.platform}\``,
        { parse_mode: 'Markdown' }
      );
    });

    // /queue
    this.bot.command('queue', async (ctx) => {
      try {
        await this.sendQueueView(ctx.chat.id.toString(), ctx);
      } catch (err) {
        this.logger.error(`Error sending queue view: ${err.message}`, err);
        ctx.reply('❌ Failed to fetch queue. Please try again.');
      }
    });

    // /clear
    this.bot.command('clear', async (ctx) => {
      try {
        const chatId = ctx.chat.id.toString();
        if (await this.hasActiveJob(chatId)) {
          return ctx.reply('⚠️ You have a merge in progress. Cannot clear queue now.');
        }
        await this.queueService.clearUserQueue(chatId);
        ctx.reply('🧹 Queue and active temporary files have been cleared.');
      } catch (err) {
        this.logger.error(`Error clearing queue: ${err.message}`, err);
        ctx.reply('❌ Failed to clear queue.');
      }
    });

    // /status
    this.bot.command('status', async (ctx) => {
      try {
        const chatId = ctx.chat.id.toString();
        const activeJob = await this.mergeJobRepo.findOne({
          where: [
            { chatId, status: 'pending' },
            { chatId, status: 'processing' },
          ],
        });

        if (!activeJob) {
          return ctx.reply('ℹ️ You have no active merge jobs.');
        }

        const pos = this.queueService.getQueuePosition(activeJob.id);
        const posText = pos === 0 ? 'Processing...' : `Queue Position: ${pos}`;

        const statusMsg = `⏳ *Active Merge Job*\n` +
          `• ID: \`${activeJob.id.substring(0, 8)}...\`\n` +
          `• Status: *${activeJob.status.toUpperCase()}*\n` +
          `• Current Stage: *${activeJob.stage.toUpperCase()}*\n` +
          `• ${posText}`;

        ctx.reply(statusMsg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('🚫 Cancel Merge', `cancel_merge:${activeJob.id}`),
          ]),
        });
      } catch (err) {
        this.logger.error(`Error fetching status: ${err.message}`, err);
        ctx.reply('❌ Failed to fetch status.');
      }
    });

    // Video & Document attachment handler
    this.bot.on(['video', 'document'], async (ctx) => {
      const chatId = ctx.chat?.id?.toString();
      if (!chatId) return;
      try {
        // Check active job limit
        if (await this.hasActiveJob(chatId)) {
          return ctx.reply('⚠️ You have a merge job currently in progress. Please wait until it finishes.');
        }

        const message = ctx.message as any;
        if (!message) return;

        let file: any = null;
        let originalName = '';

        if (message.video) {
          file = message.video;
          originalName = file.file_name || `video_${Date.now()}.mp4`;
        } else if (message.document) {
          const doc = message.document;
          if (doc.mime_type?.startsWith('video/')) {
            file = doc;
            originalName = doc.file_name || `video_${Date.now()}.mp4`;
          } else {
            return; // Ignore non-video documents silently
          }
        }

        if (!file) return;

        // Check queue limit (max 10 videos)
        const currentCount = await this.mediaQueueRepo.count({ where: { chatId } });
        if (currentCount >= 10) {
          return ctx.reply('⚠️ Your queue is full (max 10 videos). Please merge or clear (/clear) the queue.');
        }

        // Check file size (Telegram limits bots to download files under 20MB)
        const sizeLimit = 20 * 1024 * 1024; // 20 MB
        if (file.file_size && file.file_size > sizeLimit) {
          return ctx.reply(
            `⚠️ File too large! Telegram limits bots to download files under *20 MB*.\n` +
            `Your file size: *${(file.file_size / (1024 * 1024)).toFixed(1)} MB*.\n\n` +
            `Please compress the video or send a smaller clip.`,
            { parse_mode: 'Markdown' }
          );
        }

        // Notify user downloading started
        const downloadStatus = await ctx.reply('📥 Downloading video...');

        // Set up directories
        const rawDir = path.resolve(this.configService.get('TEMP_DIR') || './temp', 'jobs', `active_${chatId}`, 'raw');
        if (!fs.existsSync(rawDir)) {
          fs.mkdirSync(rawDir, { recursive: true });
        }

        // Generate safe internal filename
        const safeId = file.file_id.substring(0, 12).replace(/[^a-zA-Z0-9]/g, '');
        const internalPath = path.join(rawDir, `${Date.now()}_${safeId}.mp4`);

        // Fetch file URL from Telegram
        const fileLink = await ctx.telegram.getFileLink(file.file_id);
        
        // Download using native Node 25 Fetch
        const response = await fetch(fileLink.href);
        if (!response.ok) {
          throw new Error(`Failed to fetch file from Telegram: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        fs.writeFileSync(internalPath, Buffer.from(arrayBuffer));

        // Analyze using FFmpegService
        const meta = await this.ffmpegService.analyze(internalPath);

        // Save metadata to queue database
        const queueItem = new MediaQueue();
        queueItem.chatId = chatId;
        queueItem.fileId = file.file_id;
        queueItem.fileName = originalName;
        queueItem.localPath = internalPath;
        queueItem.orderIndex = currentCount;
        queueItem.fileSize = file.file_size || meta.fileSize;
        queueItem.duration = meta.duration;
        queueItem.width = meta.width;
        queueItem.height = meta.height;
        await this.mediaQueueRepo.save(queueItem);

        // Delete download status message, and send updated queue
        try {
          await ctx.telegram.deleteMessage(chatId, downloadStatus.message_id);
        } catch (e) {
          // ignore
        }

        await this.sendQueueView(chatId, ctx);

      } catch (err) {
        this.logger.error(`Error uploading video: ${err.message}`, err);
        ctx.reply('❌ Failed to process the uploaded video. It may be corrupted or in an unsupported format.');
      }
    });

    // Callback queries (swap order, delete, clear, merge, cancel)
    this.bot.on('callback_query', async (ctx) => {
      const data = (ctx.callbackQuery as any).data;
      const chatId = ctx.chat?.id?.toString();
      if (!chatId) return;

      try {
        if (await this.hasActiveJob(chatId) && !data.startsWith('cancel_merge:')) {
          await ctx.answerCbQuery('⚠️ A merge job is currently running. Please wait.');
          return;
        }

        if (data.startsWith('move_up:')) {
          const id = parseInt(data.split(':')[1], 10);
          await this.reorderQueue(chatId, id, -1);
          await ctx.answerCbQuery('Moved up ⬆️');
          await this.updateQueueView(chatId, ctx);
        } 
        else if (data.startsWith('move_down:')) {
          const id = parseInt(data.split(':')[1], 10);
          await this.reorderQueue(chatId, id, 1);
          await ctx.answerCbQuery('Moved down ⬇️');
          await this.updateQueueView(chatId, ctx);
        } 
        else if (data.startsWith('delete:')) {
          const id = parseInt(data.split(':')[1], 10);
          await this.deleteFromQueue(chatId, id);
          await ctx.answerCbQuery('Removed from queue ❌');
          await this.updateQueueView(chatId, ctx);
        } 
        else if (data === 'clear_queue') {
          await this.queueService.clearUserQueue(chatId);
          await ctx.answerCbQuery('Queue cleared 🧹');
          await this.updateQueueView(chatId, ctx);
        } 
        else if (data === 'start_merge') {
          const count = await this.mediaQueueRepo.count({ where: { chatId } });
          if (count < 2) {
            await ctx.answerCbQuery('⚠️ You need at least 2 videos to merge.');
            return;
          }

          // Create merge job record
          const job = new MergeJob();
          job.chatId = chatId;
          job.status = 'pending';
          job.stage = 'queued';
          const savedJob = await this.mergeJobRepo.save(job);

          // Enqueue job
          await this.queueService.enqueue(savedJob.id);
          await ctx.answerCbQuery('Enqueued merge job! ⏳');
          
          // Send initial merge progress message and record its messageId
          const pos = this.queueService.getQueuePosition(savedJob.id);
          const msg = await ctx.reply(
            `⏳ *Merging Videos...*\n` +
            `• Stage: *QUEUED*\n` +
            `• Position: \`${pos}\``,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                Markup.button.callback('🚫 Cancel Merge', `cancel_merge:${savedJob.id}`),
              ]),
            }
          );
          this.activeJobMessages.set(chatId, msg.message_id);
        } 
        else if (data.startsWith('cancel_merge:')) {
          const jobId = data.split(':')[1];
          await this.queueService.cancelJob(jobId);
          await ctx.answerCbQuery('Merge cancelled 🚫');
        }
      } catch (err) {
        this.logger.error(`Error handling callback query ${data}: ${err.message}`, err);
        await ctx.answerCbQuery('❌ Action failed.');
      }
    });
  }

  /**
   * Evaluates if a user has an active pending/processing merge job.
   */
  private async hasActiveJob(chatId: string): Promise<boolean> {
    const job = await this.mergeJobRepo.findOne({
      where: [
        { chatId, status: 'pending' },
        { chatId, status: 'processing' },
      ],
    });
    return !!job;
  }

  /**
   * Helper to reorder items inside the user queue by swapping indexes.
   */
  private async reorderQueue(chatId: string, id: number, direction: number) {
    const item = await this.mediaQueueRepo.findOne({ where: { id, chatId } });
    if (!item) return;

    const oldIndex = item.orderIndex;
    const newIndex = oldIndex + direction;

    const swapItem = await this.mediaQueueRepo.findOne({
      where: { chatId, orderIndex: newIndex },
    });

    if (swapItem) {
      item.orderIndex = newIndex;
      swapItem.orderIndex = oldIndex;
      await this.mediaQueueRepo.save([item, swapItem]);
    }
  }

  /**
   * Deletes a single item from the user's queue, deletes the local file,
   * and normalizes orderIndex of remaining clips.
   */
  private async deleteFromQueue(chatId: string, id: number) {
    const item = await this.mediaQueueRepo.findOne({ where: { id, chatId } });
    if (!item) return;

    // Delete file
    if (fs.existsSync(item.localPath)) {
      try {
        fs.unlinkSync(item.localPath);
      } catch (e) {
        this.logger.error(`Failed to delete raw file ${item.localPath}: ${e.message}`);
      }
    }

    // Delete db record
    await this.mediaQueueRepo.delete({ id });

    // Normalize other indices
    const items = await this.mediaQueueRepo.find({
      where: { chatId },
      order: { orderIndex: 'ASC' },
    });

    for (let i = 0; i < items.length; i++) {
      items[i].orderIndex = i;
      await this.mediaQueueRepo.save(items[i]);
    }
  }

  /**
   * Constructs queue details and inline keyboard buttons.
   */
  private async buildQueueResponse(chatId: string) {
    const items = await this.mediaQueueRepo.find({
      where: { chatId },
      order: { orderIndex: 'ASC' },
    });

    if (items.length === 0) {
      return {
        text: '🎥 *Your Video Merger Queue is currently empty.*\n\nSend me multiple video clips to add them here!',
        keyboard: undefined,
      };
    }

    let text = `🎥 *Video Merger Queue (${items.length}/10)*\n\n`;
    let totalDuration = 0;
    let totalSize = 0;

    const rows: any[][] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      totalDuration += item.duration || 0;
      totalSize += item.fileSize || 0;

      text += `${i + 1}. *${this.escapeMarkdown(item.fileName)}* ` +
        `(\`${item.width}x${item.height}\`, \`${this.formatDuration(item.duration)}\`, \`${this.formatSize(item.fileSize)}\`)\n`;

      const truncatedName = item.fileName.length > 15 
        ? item.fileName.substring(0, 15) + '...'
        : item.fileName;

      const controlRow: any[] = [];
      controlRow.push(Markup.button.callback(`${i + 1}. ${truncatedName}`, 'dummy'));
      
      if (i > 0) {
        controlRow.push(Markup.button.callback('⬆️', `move_up:${item.id}`));
      }
      if (i < items.length - 1) {
        controlRow.push(Markup.button.callback('⬇️', `move_down:${item.id}`));
      }
      controlRow.push(Markup.button.callback('❌', `delete:${item.id}`));

      rows.push(controlRow);
    }

    text += `\n*Total Duration:* \`${this.formatDuration(totalDuration)}\`\n` +
      `*Total Queue Size:* \`${this.formatSize(totalSize)}\``;

    // Action row
    const actionRow: any[] = [];
    actionRow.push(Markup.button.callback('🧹 Clear Queue', 'clear_queue'));
    if (items.length >= 2) {
      actionRow.push(Markup.button.callback('✅ Merge', 'start_merge'));
    }
    rows.push(actionRow);

    return {
      text,
      keyboard: Markup.inlineKeyboard(rows),
    };
  }

  private async sendQueueView(chatId: string, ctx: any) {
    const { text, keyboard } = await this.buildQueueResponse(chatId);
    if (keyboard) {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown' });
    }
  }

  private async updateQueueView(chatId: string, ctx: any) {
    const { text, keyboard } = await this.buildQueueResponse(chatId);
    try {
      if (keyboard) {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
      } else {
        await ctx.editMessageText(text, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      // Catch "Message not modified" or "Message to edit not found"
    }
  }

  /**
   * Handles dynamic job stage edits, file sending, and directory cleaning.
   */
  private async handleJobUpdate(job: MergeJob) {
    const chatId = job.chatId;
    const messageId = this.activeJobMessages.get(chatId);

    if (!messageId) {
      return;
    }

    if (job.status === 'processing') {
      const pos = this.queueService.getQueuePosition(job.id);
      const posText = pos === 0 ? 'Processing...' : `Queue Position: ${pos}`;
      const text = `⏳ *Merging Videos...*\n` +
        `• Stage: *${job.stage.toUpperCase()}*\n` +
        `• ${posText}`;

      try {
        await this.bot.telegram.editMessageText(chatId, messageId, undefined, text, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('🚫 Cancel Merge', `cancel_merge:${job.id}`),
          ]),
        });
      } catch (e) {
        // ignore
      }
    } 
    
    else if (job.status === 'completed' && job.stage === 'uploading') {
      try {
        const stats = fs.statSync(job.outputPath);
        
        // 50 MB upload limit check
        const MAX_UPLOAD_LIMIT = 50 * 1024 * 1024; // 50 MB
        if (stats.size > MAX_UPLOAD_LIMIT) {
          throw new Error(
            `Output video size is ${(stats.size / (1024 * 1024)).toFixed(1)} MB, ` +
            `which exceeds Telegram's 50 MB bot upload limit.`
          );
        }

        // Notify user uploading started
        try {
          await this.bot.telegram.editMessageText(
            chatId,
            messageId,
            undefined,
            `📤 *Merging completed successfully!* Preparing download...\n` +
            `• Output Size: *${this.formatSize(stats.size)}*\n\n` +
            `Uploading video to Telegram (this might take a moment)...`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          // ignore
        }

        // Analyze output file for metrics display
        const meta = await this.ffmpegService.analyze(job.outputPath);
        
        // Calculate exact processing time
        const durationMs = Date.now() - job.createdAt.getTime();
        const processTimeText = `${(durationMs / 1000).toFixed(1)}s`;

        // Send merged video
        await this.bot.telegram.sendVideo(
          chatId,
          { source: job.outputPath },
          {
            caption: `✅ *Finished Successfully!*\n\n` +
              `• *Videos merged:* \`${await this.mediaQueueRepo.count({ where: { chatId } })}\`\n` +
              `• *Total Duration:* \`${this.formatDuration(meta.duration)}\`\n` +
              `• *Resolution:* \`${meta.width}x${meta.height}\`\n` +
              `• *Size:* \`${this.formatSize(stats.size)}\`\n` +
              `• *Processing Time:* \`${processTimeText}\``,
            parse_mode: 'Markdown',
          }
        );

        // Clear active status message
        try {
          await this.bot.telegram.deleteMessage(chatId, messageId);
        } catch (e) {
          // ignore
        }

        // Clear the user queue records and queue filesystem folder
        await this.queueService.clearUserQueue(chatId);

      } catch (err) {
        this.logger.error(`Error delivering merged file for Job ID: ${job.id}: ${err.message}`, err);
        
        // Edit status message to notify failure
        try {
          await this.bot.telegram.editMessageText(
            chatId,
            messageId,
            undefined,
            `❌ *Merge failed during upload/delivery!*\n\n` +
            `• *Error Details:* ${err.message || 'Unknown delivery error'}`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          // ignore
        }

        // Fail the job in DB
        job.status = 'failed';
        job.stage = 'failed';
        job.error = err.message;
        await this.mergeJobRepo.save(job);
      } finally {
        this.activeJobMessages.delete(chatId);
        
        // Schedule job folder cleanup in 60 seconds
        this.logger.log(`Scheduling directory cleanup for Job ID: ${job.id} in 60s`);
        setTimeout(() => this.queueService.cleanupJobFolder(job.id), 60000);
      }
    } 
    
    else if (job.status === 'failed') {
      try {
        await this.bot.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          `❌ *Merge failed!*\n\n` +
          `• *Error Details:* ${job.error || 'Unknown processing error'}`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        // ignore
      }
      this.activeJobMessages.delete(chatId);
      
      // Cleanup files immediately
      this.queueService.cleanupJobFolder(job.id);
    } 
    
    else if (job.status === 'cancelled') {
      try {
        await this.bot.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          `🚫 *Merge cancelled!*\n\n` +
          `The job was cancelled. Queue and temporary files have been restored/cleaned.`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        // ignore
      }
      this.activeJobMessages.delete(chatId);
    }
  }

  // --- UTILS ---

  private formatDuration(sec: number): string {
    if (!sec || isNaN(sec)) return '0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);

    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  private formatSize(bytes: number): string {
    if (!bytes || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*`\[]/g, '\\$&');
  }
}
