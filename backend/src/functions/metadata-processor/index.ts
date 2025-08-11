/**
 * Metadata Processor Lambda Function
 * 
 * Processes S3 event notifications for new uploads and extracts ID3 tags and metadata
 * from uploaded music files using the music-metadata library.
 */

import { S3Event, S3Handler } from 'aws-lambda';
import { parseStream } from 'music-metadata';
import { Readable } from 'stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { awsClients, document, sqs } from '@shared/aws-clients';
import logger from '@shared/logger';
import { 
  getLambdaConfig,
  retry,
  createRetryConfig,
  getRequestId,
} from '@shared/utils';
import {
  AWSServiceError,
  FileError,
  ErrorCode,
  iSyncError,
} from '@shared/errors';
import { UploadStatus, MusicMetadata, SQSMessage } from '@shared/types';

// Lambda configuration
const config = getLambdaConfig();

/**
 * Main Lambda handler for S3 events
 */
export const handler: S3Handler = async (event: S3Event, context) => {
  const requestId = getRequestId(context);
  
  logger.setContext({
    requestId,
    functionName: context.functionName,
  });

  logger.info('Metadata processor triggered', {
    recordCount: event.Records.length,
  });

  // Process each S3 record
  const results = await Promise.allSettled(
    event.Records.map(record => processS3Record(record, requestId))
  );

  // Log any failures
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length > 0) {
    logger.error('Some records failed to process', {
      totalRecords: event.Records.length,
      failures: failures.length,
    });
  }

  logger.info('Metadata processing completed', {
    totalRecords: event.Records.length,
    successful: results.filter(r => r.status === 'fulfilled').length,
    failed: failures.length,
  });
};

/**
 * Process a single S3 record
 */
async function processS3Record(record: any, requestId: string): Promise<void> {
  const bucketName = record.s3.bucket.name;
  const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const objectSize = record.s3.object.size;

  logger.setContext({ 
    requestId, 
    bucket: bucketName, 
    key: objectKey,
    size: objectSize 
  });

  logger.info('Processing S3 object for metadata extraction', {
    eventName: record.eventName,
    eventTime: record.eventTime,
  });

  try {
    // Skip non-upload events
    if (!record.eventName.startsWith('ObjectCreated')) {
      logger.debug('Skipping non-create event', { eventName: record.eventName });
      return;
    }

    // Extract upload ID and user ID from the S3 key path
    const uploadId = extractUploadIdFromKey(objectKey);
    const userId = extractUserIdFromKey(objectKey);
    
    if (!uploadId || !userId) {
      throw new FileError(
        ErrorCode.INVALID_FILE_PATH,
        'Could not extract upload ID or user ID from S3 key',
        objectKey
      );
    }

    logger.setContext({ uploadId, userId });

    // Update DynamoDB record to processing status
    await updateUploadStatus(uploadId, userId, UploadStatus.PROCESSING, 'Starting metadata extraction');

    // Check file format
    if (!isSupportedAudioFormat(objectKey)) {
      throw new FileError(
        ErrorCode.INVALID_FILE_TYPE,
        'Unsupported audio format',
        objectKey
      );
    }

    // Stream file from S3 and extract metadata
    const metadata = await extractMetadataFromS3(bucketName, objectKey);
    
    // Extract and save album artwork if present
    let artworkUrl: string | undefined;
    if (metadata.common?.picture && metadata.common.picture.length > 0) {
      artworkUrl = await saveAlbumArtwork(bucketName, objectKey, metadata.common.picture[0], uploadId);
    }

    // Build clean metadata object
    const cleanMetadata: MusicMetadata = {
      title: metadata.common?.title || extractTitleFromFilename(objectKey),
      artist: metadata.common?.artist || 'Unknown Artist',
      album: metadata.common?.album,
      genre: metadata.common?.genre?.[0],
      year: metadata.common?.year,
      duration: metadata.format?.duration,
      trackNumber: metadata.common?.track?.no,
      discNumber: metadata.common?.disk?.no,
      bitrate: metadata.format?.bitrate,
      sampleRate: metadata.format?.sampleRate,
      channels: metadata.format?.numberOfChannels,
      artwork: artworkUrl,
    };

    // Update DynamoDB record with extracted metadata
    await updateUploadWithMetadata(uploadId, userId, cleanMetadata);

    // Send message to processing queue
    await sendToProcessingQueue(uploadId, userId, objectKey, cleanMetadata);

    // Update status to completed
    await updateUploadStatus(uploadId, userId, UploadStatus.COMPLETED, 'Metadata extraction completed successfully');

    // Publish success metrics
    await awsClients.publishMetric(
      'iSync/MetadataProcessor',
      'ProcessingSuccess',
      1,
      'Count',
      [
        { Name: 'Environment', Value: config.nodeEnv },
        { Name: 'FileFormat', Value: getFileExtension(objectKey) },
      ]
    );

    logger.info('Metadata extraction completed successfully', {
      uploadId,
      title: cleanMetadata.title,
      artist: cleanMetadata.artist,
      duration: cleanMetadata.duration,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to process S3 record', error, {
      bucket: bucketName,
      key: objectKey,
      error: errorMessage,
    });

    // Try to update upload status to failed
    try {
      const uploadId = extractUploadIdFromKey(objectKey);
      const userId = extractUserIdFromKey(objectKey);
      if (uploadId && userId) {
        await updateUploadStatus(uploadId, userId, UploadStatus.FAILED, `Metadata extraction failed: ${errorMessage}`);
      }
    } catch (updateError) {
      logger.warn('Failed to update upload status to failed', { updateError });
    }

    // Publish failure metrics
    await awsClients.publishMetric(
      'iSync/MetadataProcessor',
      'ProcessingFailure',
      1,
      'Count',
      [
        { Name: 'Environment', Value: config.nodeEnv },
        { Name: 'ErrorType', Value: error instanceof Error ? error.constructor.name : 'Unknown' },
      ]
    );

    throw error;
  } finally {
    logger.clearContext();
  }
}

/**
 * Extract upload ID from S3 key
 * Supports both legacy and current layouts:
 *  - users/{userId}/{uploadId}/filename.ext
 *  - uploads/{userId}/{uploadId}/filename.ext
 */
function extractUploadIdFromKey(s3Key: string): string | null {
  const pathParts = s3Key.split('/');
  if (pathParts.length >= 3 && (pathParts[0] === 'users' || pathParts[0] === 'uploads')) {
    return pathParts[2]; // uploadId
  }
  return null;
}

/**
 * Extract user ID from S3 key
 * Supports both legacy and current layouts:
 *  - users/{userId}/{uploadId}/filename.ext
 *  - uploads/{userId}/{uploadId}/filename.ext
 */
function extractUserIdFromKey(s3Key: string): string | null {
  const pathParts = s3Key.split('/');
  if (pathParts.length >= 3 && (pathParts[0] === 'users' || pathParts[0] === 'uploads')) {
    return pathParts[1]; // userId
  }
  return null;
}

/**
 * Check if file format is supported for audio metadata extraction
 */
function isSupportedAudioFormat(filename: string): boolean {
  const supportedExtensions = ['.mp3', '.m4a', '.aac', '.flac', '.wav'];
  const extension = getFileExtension(filename).toLowerCase();
  return supportedExtensions.includes(extension);
}

/**
 * Get file extension from filename
 */
function getFileExtension(filename: string): string {
  return filename.substring(filename.lastIndexOf('.'));
}

/**
 * Extract title from filename as fallback
 */
function extractTitleFromFilename(s3Key: string): string {
  const filename = s3Key.split('/').pop() || s3Key;
  return filename.substring(0, filename.lastIndexOf('.')) || filename;
}

/**
 * Stream file from S3 and extract metadata using music-metadata
 */
async function extractMetadataFromS3(bucketName: string, objectKey: string) {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Range: 'bytes=0-16777215', // First 16MB should be enough for metadata
    });

    const response = await retry(
      () => awsClients.s3.send(command),
      createRetryConfig(),
      'getS3ObjectForMetadata'
    );

    if (!response.Body) {
      throw new AWSServiceError(
        'S3',
        ErrorCode.S3_ERROR,
        'No response body from S3 GetObject',
        true
      );
    }

    // Convert S3 body to Node.js readable stream
    const stream = response.Body as Readable;
    
    // Parse metadata using music-metadata (use parseStream for Readable)
    const metadata = await parseStream(
      stream as any,
      response.ContentType || undefined,
      { skipCovers: false, duration: true }
    );

    logger.debug('Metadata extracted successfully', {
      format: metadata.format,
      hasArtwork: !!(metadata.common?.picture && metadata.common.picture.length > 0),
    });

    return metadata;

  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') {
      throw new FileError(
        ErrorCode.FILE_NOT_FOUND,
        'File not found in S3',
        objectKey
      );
    }
    
    throw new AWSServiceError(
      'S3',
      ErrorCode.S3_ERROR,
      `Failed to extract metadata from S3 object: ${error instanceof Error ? error.message : String(error)}`,
      true,
      error as Error
    );
  }
}

/**
 * Save album artwork to S3 as a separate object
 */
async function saveAlbumArtwork(
  bucketName: string,
  originalKey: string,
  artwork: any,
  uploadId: string
): Promise<string> {
  try {
    const artworkKey = originalKey.replace(/\.[^.]+$/, '_artwork.jpg');
    
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: artworkKey,
      Body: artwork.data,
      ContentType: artwork.format === 'image/png' ? 'image/png' : 'image/jpeg',
      Metadata: {
        'upload-id': uploadId,
        'original-file': originalKey,
      },
    });

    await retry(
      () => awsClients.s3.send(command),
      createRetryConfig(),
      'saveAlbumArtwork'
    );

    logger.debug('Album artwork saved successfully', { artworkKey });
    return artworkKey;

  } catch (error) {
    // Don't fail the entire process if artwork saving fails
    logger.warn('Failed to save album artwork', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

/**
 * Update DynamoDB upload record with extracted metadata
 */
async function updateUploadWithMetadata(uploadId: string, userId: string, metadata: MusicMetadata): Promise<void> {
  try {
    
    await retry(
      () => document.send(new UpdateCommand({
        TableName: config.uploadTable,
        Key: {
          uploadId,
          userId,
        },
        UpdateExpression: 'SET metadata = :metadata, updatedAt = :updated',
        ExpressionAttributeValues: {
          ':metadata': metadata,
          ':updated': Date.now(),
        },
        ConditionExpression: 'attribute_exists(uploadId)',
      })),
      createRetryConfig(),
      'updateUploadWithMetadata'
    );

    logger.debug('Upload record updated with metadata', { uploadId });

  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new iSyncError(
        ErrorCode.UPLOAD_NOT_FOUND,
        'Upload record not found for metadata update',
        404
      );
    }
    
    throw new AWSServiceError(
      'DynamoDB',
      ErrorCode.DYNAMODB_ERROR,
      `Failed to update upload record with metadata: ${error instanceof Error ? error.message : String(error)}`,
      true,
      error as Error
    );
  }
}

/**
 * Update upload status in DynamoDB
 */
async function updateUploadStatus(uploadId: string, userId: string, status: UploadStatus, message?: string): Promise<void> {
  try {
    
    const updateExpression = message 
      ? 'SET #status = :status, updatedAt = :updated, #message = :message'
      : 'SET #status = :status, updatedAt = :updated';
    
    const expressionAttributeValues: any = {
      ':status': status,
      ':updated': Date.now(),
    };
    
    if (message) {
      expressionAttributeValues[':message'] = message;
    }

    await retry(
      () => document.send(new UpdateCommand({
        TableName: config.uploadTable,
        Key: {
          uploadId,
          userId,
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: {
          '#status': 'status',
          ...(message && { '#message': 'processingMessage' }),
        },
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: 'attribute_exists(uploadId)',
      })),
      createRetryConfig(),
      'updateUploadStatus'
    );

  } catch (error) {
    logger.error('Failed to update upload status', { uploadId, status, message, error });
    // Don't throw here as this is a side effect
  }
}


/**
 * Send message to SQS processing queue
 */
async function sendToProcessingQueue(uploadId: string, userId: string, s3Key: string, metadata: MusicMetadata): Promise<void> {
  try {
    const fileName = s3Key.split('/').pop() || s3Key;
    const message: SQSMessage = {
      uploadId,
      userId,
      s3Key,
      fileName,
      metadata,
      timestamp: Date.now(),
    };

    await retry(
      () => sqs.send(new SendMessageCommand({
        QueueUrl: config.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          'upload-id': {
            DataType: 'String',
            StringValue: uploadId,
          },
          'file-type': {
            DataType: 'String', 
            StringValue: getFileExtension(s3Key),
          },
        },
      })),
      createRetryConfig(),
      'sendToProcessingQueue'
    );

    logger.debug('Message sent to processing queue', { uploadId });

  } catch (error) {
    throw new AWSServiceError(
      'SQS',
      ErrorCode.SQS_ERROR,
      `Failed to send message to processing queue: ${error instanceof Error ? error.message : String(error)}`,
      true,
      error as Error
    );
  }
}