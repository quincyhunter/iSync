/**
 * Shared utility functions for iSync Lambda functions
 */

import { v4 as uuidv4 } from 'uuid';
import { addSeconds, isPast } from 'date-fns';
import { ApiResponse, ErrorResponse, RetryConfig } from './types';
import { iSyncError, ErrorCode, isRetryableError } from './errors';
import logger from './logger';

/**
 * Generate unique upload ID
 */
export function generateUploadId(): string {
  return uuidv4();
}

/**
 * Generate TTL timestamp for DynamoDB (24 hours from now)
 */
export function generateTTL(hoursFromNow: number = 24): number {
  return Math.floor(addSeconds(new Date(), hoursFromNow * 3600).getTime() / 1000);
}

/**
 * Check if TTL has expired
 */
export function isTTLExpired(ttl: number): boolean {
  return isPast(new Date(ttl * 1000));
}

/**
 * Create standardized API Gateway response
 */
export function createApiResponse<T>(
  statusCode: number,
  data: T,
  headers: Record<string, string> = {}
): ApiResponse<T> {
  const defaultHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  };

  return {
    statusCode,
    headers: { ...defaultHeaders, ...headers },
    body: JSON.stringify(data),
    isBase64Encoded: false,
  };
}

/**
 * Create success response
 */
export function createSuccessResponse<T>(
  data: T, 
  statusCode: number = 200, 
  headers?: Record<string, string>
): ApiResponse<T> {
  return createApiResponse(statusCode, data, headers);
}

/**
 * Create error response
 */
export function createErrorResponse(
  error: unknown, 
  requestId?: string
): ApiResponse<ErrorResponse> {
  let statusCode = 500;
  let errorCode = ErrorCode.INTERNAL_ERROR;
  let message = 'Internal server error';
  let retryable = false;
  let details: Record<string, unknown> | undefined;

  if (error instanceof iSyncError) {
    statusCode = error.statusCode;
    errorCode = error.code;
    message = error.message;
    retryable = error.retryable;
    details = error.details;
  } else if (error instanceof Error) {
    message = error.message;
    details = { originalError: error.name };
    retryable = isRetryableError(error);
  }

  const errorResponse: ErrorResponse = {
    error: {
      code: errorCode,
      message,
      retryable,
      details,
    },
    requestId,
    timestamp: Date.now(),
  };

  return createApiResponse(statusCode, errorResponse);
}

/**
 * Validate file type based on content type
 */
export function validateFileType(contentType: string): boolean {
  const allowedTypes = [
    'audio/mpeg',      // MP3
    'audio/mp4',       // M4A
    'audio/m4a',       // M4A alternative
    'audio/flac',      // FLAC
    'audio/wav',       // WAV
    'audio/wave',      // WAV alternative
  ];
  
  return allowedTypes.includes(contentType.toLowerCase());
}

/**
 * Validate file size (in bytes)
 */
export function validateFileSize(fileSize: number, maxSizeBytes: number = 104857600): boolean {
  return fileSize > 0 && fileSize <= maxSizeBytes;
}

/**
 * Generate S3 key for uploaded file
 */
export function generateS3Key(userId: string, uploadId: string, fileName: string): string {
  // Sanitize filename
  const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `uploads/${userId}/${uploadId}/${sanitizedName}`;
}

/**
 * Extract file extension from filename
 */
export function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf('.');
  return lastDotIndex !== -1 ? fileName.substring(lastDotIndex + 1).toLowerCase() : '';
}

/**
 * Format file size for human reading
 */
export function formatFileSize(bytes: number): string {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Sleep for specified milliseconds (useful for retries)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 */
export async function retry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  operationName: string = 'operation'
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      logger.debug(`Attempting ${operationName}`, { attempt, maxRetries: config.maxRetries });
      
      const result = await operation();
      
      if (attempt > 0) {
        logger.info(`${operationName} succeeded after ${attempt} retries`);
      }
      
      return result;
    } catch (error) {
      lastError = error;
      
      if (!isRetryableError(error)) {
        logger.debug(`${operationName} failed with non-retryable error`, { error });
        throw error;
      }
      
      if (attempt === config.maxRetries) {
        logger.error(`${operationName} failed after ${config.maxRetries} retries`, error);
        break;
      }
      
      const delay = Math.min(
        config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt),
        config.maxDelayMs
      );
      
      logger.warn(`${operationName} failed, retrying in ${delay}ms`, {
        attempt,
        error: error instanceof Error ? error.message : String(error),
        delay,
      });
      
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Create default retry configuration
 */
export function createRetryConfig(overrides?: Partial<RetryConfig>): RetryConfig {
  return {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    ...overrides,
  };
}

/**
 * Extract request ID from Lambda context or generate one
 */
export function getRequestId(context?: { awsRequestId?: string }): string {
  return context?.awsRequestId || uuidv4();
}

/**
 * Parse JSON safely with error handling
 */
export function parseJSON<T>(jsonString: string, fallback?: T): T {
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    logger.warn('Failed to parse JSON', { jsonString, error });
    if (fallback !== undefined) {
      return fallback;
    }
    throw new iSyncError(
      ErrorCode.VALIDATION_ERROR,
      'Invalid JSON format',
      400,
      false
    );
  }
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (obj instanceof Date) {
    return new Date(obj.getTime()) as unknown as T;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item)) as unknown as T;
  }
  
  const cloned = {} as T;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  
  return cloned;
}

/**
 * Check if running in Lambda environment
 */
export function isLambdaEnvironment(): boolean {
  return !!(process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.AWS_LAMBDA_FUNCTION_VERSION);
}

/**
 * Get Lambda function configuration from environment
 */
export function getLambdaConfig() {
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    uploadBucket: process.env.UPLOAD_BUCKET || '',
    uploadTable: process.env.UPLOAD_TABLE || '',
    queueUrl: process.env.QUEUE_URL || '',
    logLevel: process.env.LOG_LEVEL || 'info',
    enableXRay: process.env.ENABLE_XRAY === 'true',
    nodeEnv: process.env.NODE_ENV || 'production',
  };
}