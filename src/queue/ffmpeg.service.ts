import { Injectable, Logger } from '@nestjs/common';
import * as ffmpegPath from '@ffmpeg-installer/ffmpeg';
import * as ffprobePath from '@ffprobe-installer/ffprobe';
import ffmpeg = require('fluent-ffmpeg');
import * as fs from 'fs';
import * as path from 'path';

// Set binary paths for fluent-ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath.path);
ffmpeg.setFfprobePath(ffprobePath.path);

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
  codec: string;
  hasAudio: boolean;
  audioCodec?: string;
  fileSize: number;
}

@Injectable()
export class FFmpegService {
  private readonly logger = new Logger(FFmpegService.name);

  constructor() {
    this.logger.log(`Initialized with FFmpeg: ${ffmpegPath.path}`);
    this.logger.log(`Initialized with FFprobe: ${ffprobePath.path}`);
  }

  /**
   * Analyzes a video file to retrieve dimensions, codec, duration, and audio details.
   */
  async analyze(filePath: string): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(filePath)) {
        return reject(new Error(`File not found: ${filePath}`));
      }

      const stats = fs.statSync(filePath);

      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          this.logger.error(`FFprobe failed for file: ${filePath}`, err);
          return reject(err);
        }

        const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
        const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');

        if (!videoStream) {
          return reject(new Error('No video stream found in the file'));
        }

        resolve({
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          duration: Number(metadata.format.duration) || 0,
          codec: videoStream.codec_name || '',
          hasAudio: !!audioStream,
          audioCodec: audioStream?.codec_name,
          fileSize: stats.size,
        });
      });
    });
  }

  /**
   * Prepares and standardizes a single video file to a target resolution,
   * standard frame rate (30fps), uniform H.264/AAC codecs, and injects silent audio if needed.
   */
  async standardizeVideo(
    rawPath: string,
    outputPath: string,
    targetWidth: number,
    targetHeight: number,
    hasAudio: boolean,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const command = ffmpeg(rawPath);

      // Scale and pad to fit the target resolution while maintaining aspect ratio (letterbox/pillarbox)
      command.videoFilters([
        `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease`,
        `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black`,
      ]);

      // Set output options for compatibility
      command
        .videoCodec('libx264')
        .fps(30)
        .outputOptions([
          '-pix_fmt yuv420p',
          '-preset medium',
          '-crf 23',
        ]);

      if (!hasAudio) {
        // Input 1 is the silent audio source
        command
          .input('anullsrc=channel_layout=stereo:sample_rate=44100')
          .inputFormat('lavfi')
          .audioCodec('aac')
          .outputOptions([
            '-map 0:v:0',
            '-map 1:a:0',
            '-shortest'
          ]);
      } else {
        command
          .audioCodec('aac')
          .audioFrequency(44100)
          .audioChannels(2);
      }

      command
        .on('start', (cmdLine) => {
          this.logger.log(`FFmpeg Standardization Started. Command: ${cmdLine}`);
        })
        .on('progress', (progress) => {
          if (progress.percent && onProgress) {
            onProgress(Math.min(99, Math.max(0, Math.round(progress.percent))));
          }
        })
        .on('end', () => {
          this.logger.log(`FFmpeg Standardization Completed: ${outputPath}`);
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          this.logger.error(`FFmpeg Standardization Failed for: ${rawPath}`);
          this.logger.error(`stdout: ${stdout}`);
          this.logger.error(`stderr: ${stderr}`);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Concatenates multiple compatible videos using FFmpeg's concat demuxer.
   */
  async concat(filePaths: string[], outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Create a concat text list file
      const listFilePath = path.join(outputDir, 'concat_list.txt');
      const listContent = filePaths
        .map((fp) => `file '${fp.replace(/\\/g, '/')}'`)
        .join('\n');

      fs.writeFileSync(listFilePath, listContent, 'utf8');
      this.logger.log(`Created concat list file at ${listFilePath}`);

      ffmpeg()
        .input(listFilePath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions('-c copy')
        .on('start', (cmdLine) => {
          this.logger.log(`FFmpeg Concat Started. Command: ${cmdLine}`);
        })
        .on('end', () => {
          this.logger.log(`FFmpeg Concat Completed. Merged file: ${outputPath}`);
          // Clean up the text list file
          try {
            fs.unlinkSync(listFilePath);
          } catch (e) {
            this.logger.warn(`Failed to clean up concat list file: ${e.message}`);
          }
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          this.logger.error(`FFmpeg Concat Failed`);
          this.logger.error(`stdout: ${stdout}`);
          this.logger.error(`stderr: ${stderr}`);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Helper method to recursively delete a directory
   */
  cleanupDirectory(dirPath: string): void {
    if (fs.existsSync(dirPath)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        this.logger.log(`Cleaned up directory: ${dirPath}`);
      } catch (err) {
        this.logger.error(`Failed to clean up directory: ${dirPath}`, err);
      }
    }
  }
}
