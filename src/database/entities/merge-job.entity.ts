import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('merge_jobs')
export class MergeJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  chatId: string;

  @Column({ default: 'pending' })
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

  @Column({ default: 'queued' })
  stage: 'queued' | 'preparing' | 'merging' | 'uploading' | 'finished' | 'failed' | 'cancelled';

  @Column({ nullable: true })
  outputPath: string;

  @Column({ nullable: true })
  error: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
