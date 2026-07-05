import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('media_queues')
export class MediaQueue {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  chatId: string;

  @Column()
  fileId: string;

  @Column()
  fileName: string;

  @Column()
  localPath: string;

  @Column()
  orderIndex: number;

  @Column({ nullable: true })
  fileSize: number;

  @Column('float', { nullable: true })
  duration: number;

  @Column({ nullable: true })
  width: number;

  @Column({ nullable: true })
  height: number;

  @CreateDateColumn()
  createdAt: Date;
}
