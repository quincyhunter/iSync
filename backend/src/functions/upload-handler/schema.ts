/**
 * Validation schemas for upload-handler Lambda function
 */

import { z } from 'zod';
import { UploadStatus } from '@shared/types';

// Supported file types and their MIME types
export const SUPPORTED_FILE_TYPES = {
  'audio/mpeg': { extension: 'mp3', maxSize: 100 * 1024 * 1024 }, // 100MB
  'audio/mp4': { extension: 'm4a', maxSize: 100 * 1024 * 1024 },
  'audio/m4a': { extension: 'm4a', maxSize: 100 * 1024 * 1024 },
  'audio/flac': { extension: 'flac', maxSize: 200 * 1024 * 1024 }, // 200MB for FLAC
  'audio/wav': { extension: 'wav', maxSize: 200 * 1024 * 1024 },
  'audio/wave': { extension: 'wav', maxSize: 200 * 1024 * 1024 },
} as const;

export const UPLOAD_CONSTRAINTS = {
  MAX_FILE_SIZE: 200 * 1024 * 1024, // 200MB
  MIN_FILE_SIZE: 1024, // 1KB
  MAX_FILENAME_LENGTH: 255,
  PRESIGNED_URL_EXPIRY: 3600, // 1 hour
  MAX_UPLOADS_PER_USER_PER_HOUR: 50,
  SUPPORTED_CONTENT_TYPES: Object.keys(SUPPORTED_FILE_TYPES),
} as const;

/**
 * Music metadata schema
 */
export const MusicMetadataSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(200, 'Title must be less than 200 characters')
    .trim(),
  artist: z.string()
    .min(1, 'Artist is required')
    .max(200, 'Artist must be less than 200 characters')
    .trim(),
  album: z.string()
    .max(200, 'Album must be less than 200 characters')
    .trim()
    .optional(),
  genre: z.string()
    .max(50, 'Genre must be less than 50 characters')
    .trim()
    .optional(),
  year: z.number()
    .int('Year must be an integer')
    .min(1900, 'Year must be after 1900')
    .max(new Date().getFullYear() + 1, 'Year cannot be in the future')
    .optional(),
  trackNumber: z.number()
    .int('Track number must be an integer')
    .min(1, 'Track number must be positive')
    .max(999, 'Track number must be less than 1000')
    .optional(),
  discNumber: z.number()
    .int('Disc number must be an integer')
    .min(1, 'Disc number must be positive')
    .max(99, 'Disc number must be less than 100')
    .optional(),
});

/**
 * Upload initiation request schema
 */
export const UploadRequestSchema = z.object({
  fileName: z.string()
    .min(1, 'Filename is required')
    .max(UPLOAD_CONSTRAINTS.MAX_FILENAME_LENGTH, 'Filename too long')
    .regex(/^[^<>:"/\\|?*]+$/, 'Filename contains invalid characters')
    .refine(
      (name) => name.includes('.'),
      'Filename must have an extension'
    )
    .refine(
      (name) => {
        const ext = name.toLowerCase().split('.').pop();
        const validExtensions = ['mp3', 'm4a', 'flac', 'wav'];
        return validExtensions.includes(ext || '');
      },
      'File must be a supported audio format (mp3, m4a, flac, wav)'
    ),
  fileSize: z.number()
    .int('File size must be an integer')
    .min(UPLOAD_CONSTRAINTS.MIN_FILE_SIZE, 'File too small')
    .max(UPLOAD_CONSTRAINTS.MAX_FILE_SIZE, 'File too large (max 200MB)'),
  contentType: z.enum(
    UPLOAD_CONSTRAINTS.SUPPORTED_CONTENT_TYPES as [string, ...string[]],
    { errorMap: () => ({ message: 'Unsupported file type' }) }
  ),
  metadata: MusicMetadataSchema,
  userId: z.string()
    .min(1, 'User ID is required')
    .max(100, 'User ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'User ID contains invalid characters'),
  idempotencyKey: z.string()
    .max(128, 'Idempotency key too long')
    .optional(),
});

/**
 * Upload status query schema
 */
export const UploadStatusQuerySchema = z.object({
  uploadId: z.string()
    .uuid('Invalid upload ID format'),
  userId: z.string()
    .min(1, 'User ID is required')
    .max(100, 'User ID too long'),
});

/**
 * Upload cancellation schema
 */
export const CancelUploadSchema = z.object({
  uploadId: z.string()
    .uuid('Invalid upload ID format'),
  userId: z.string()
    .min(1, 'User ID is required')
    .max(100, 'User ID too long'),
  reason: z.string()
    .max(200, 'Reason too long')
    .optional(),
});

/**
 * Validate file type matches content type
 */
export function validateFileTypeConsistency(fileName: string, contentType: string): boolean {
  const extension = fileName.toLowerCase().split('.').pop();
  const supportedType = SUPPORTED_FILE_TYPES[contentType as keyof typeof SUPPORTED_FILE_TYPES];
  
  if (!supportedType) {
    return false;
  }
  
  return extension === supportedType.extension;
}

/**
 * Get maximum file size for content type
 */
export function getMaxFileSizeForType(contentType: string): number {
  const supportedType = SUPPORTED_FILE_TYPES[contentType as keyof typeof SUPPORTED_FILE_TYPES];
  return supportedType?.maxSize || UPLOAD_CONSTRAINTS.MAX_FILE_SIZE;
}

/**
 * Type definitions for validated schemas
 */
export type MusicMetadata = z.infer<typeof MusicMetadataSchema>;
export type UploadRequest = z.infer<typeof UploadRequestSchema>;
export type UploadStatusQuery = z.infer<typeof UploadStatusQuerySchema>;
export type CancelUpload = z.infer<typeof CancelUploadSchema>;