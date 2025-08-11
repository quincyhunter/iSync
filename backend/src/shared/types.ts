/**
 * Shared type definitions for iSync Lambda functions
 */

export interface UploadRequest {
  uploadId: string;
  userId: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  metadata: MusicMetadata;
  status: UploadStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  attempts: number;
  ttl: number;
}

export interface MusicMetadata {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  duration?: number;
  artwork?: string;
  trackNumber?: number;
  discNumber?: number;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
}

export enum UploadStatus {
  PENDING = 'pending',
  UPLOADING = 'uploading', 
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

export interface PresignedUrlResponse {
  uploadId: string;
  presignedUrl: string;
  expiresIn: number;
  maxFileSize: number;
  requiredHeaders: Record<string, string>;
}

export interface SQSMessage {
  uploadId: string;
  userId: string;
  s3Key: string;
  metadata: MusicMetadata;
  timestamp: number;
}

export interface ProcessingMetrics {
  queueDepth: number;
  runningInstances: number;
  lastProcessingTime: number;
  averageProcessingTime: number;
  successRate: number;
}

export interface EC2ScalingDecision {
  shouldScale: boolean;
  desiredCapacity: number;
  reason: string;
  currentCapacity: number;
  queueDepth: number;
}

export interface ApiResponse<T = unknown> {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  requestId?: string;
  timestamp: number;
}

// AWS Event Types
export interface S3Event {
  Records: Array<{
    s3: {
      bucket: {
        name: string;
      };
      object: {
        key: string;
        size: number;
      };
    };
    eventName: string;
    eventTime: string;
  }>;
}

export interface EventBridgeEvent {
  source: string;
  'detail-type': string;
  detail: Record<string, unknown>;
  time: string;
}

// Configuration interfaces
export interface LambdaConfig {
  region: string;
  uploadBucket: string;
  uploadTable: string;
  queueUrl: string;
  logLevel: string;
  enableXRay: boolean;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}