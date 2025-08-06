/**
 * Upload Handler Lambda Function
 * 
 * Handles music file upload operations:
 * - POST /upload: Generate presigned URLs for file uploads
 * - GET /upload/{id}: Check upload status
 * - DELETE /upload/{id}: Cancel upload
 */

import { APIGatewayProxyHandler, APIGatewayProxyEvent, Context } from 'aws-lambda';
import { PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@shared/aws-clients';
import { awsClients, document } from '@shared/aws-clients';
import logger from '@shared/logger';
import {
  generateUploadId,
  generateTTL,
  generateS3Key,
  createSuccessResponse,
  createErrorResponse,
  getRequestId,
  getLambdaConfig,
  parseJSON,
  retry,
  createRetryConfig,
} from '@shared/utils';
import {
  UploadRequest as DatabaseUploadRequest,
  UploadStatus,
  PresignedUrlResponse,
} from '@shared/types';
import {
  ValidationError,
  FileError,
  AWSServiceError,
  RateLimitError,
  ErrorCode,
  iSyncError,
} from '@shared/errors';
import {
  UploadRequestSchema,
  UploadStatusQuerySchema,
  CancelUploadSchema,
  validateFileTypeConsistency,
  getMaxFileSizeForType,
  UPLOAD_CONSTRAINTS,
  type UploadRequest as UploadRequestType,
} from './schema';

// Lambda configuration
const config = getLambdaConfig();

/**
 * Main Lambda handler
 */
export const handler: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent, context: Context) => {
  const requestId = getRequestId(context);
  
  // Set up logging context
  logger.setContext({
    requestId,
    functionName: context.functionName,
    httpMethod: event.httpMethod,
    path: event.path,
  });

  logger.info('Processing upload request', {
    httpMethod: event.httpMethod,
    path: event.path,
    userAgent: event.headers['User-Agent'],
  });

  try {
    // Route based on HTTP method and path
    const method = event.httpMethod;
    const pathSegments = event.path.split('/').filter(Boolean);
    
    if (method === 'POST' && pathSegments[0] === 'upload') {
      return await handleUploadInitiation(event, requestId);
    } else if (method === 'GET' && pathSegments[0] === 'upload' && pathSegments[1]) {
      return await handleUploadStatus(event, requestId);
    } else if (method === 'DELETE' && pathSegments[0] === 'upload' && pathSegments[1]) {
      return await handleUploadCancellation(event, requestId);
    } else {
      throw new iSyncError(
        ErrorCode.VALIDATION_ERROR,
        `Method ${method} not allowed for path ${event.path}`,
        405
      );
    }
  } catch (error) {
    logger.error('Upload handler error', error, { requestId });
    return createErrorResponse(error, requestId);
  } finally {
    logger.clearContext();
  }
};

/**
 * Handle upload initiation (POST /upload)
 */
async function handleUploadInitiation(event: APIGatewayProxyEvent, requestId: string) {
  const body = parseJSON(event.body || '{}');
  
  // Validate request
  const validationResult = UploadRequestSchema.safeParse(body);
  if (!validationResult.success) {
    const errors = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  }

  const request = validationResult.data;
  
  logger.setContext({ userId: request.userId });
  logger.info('Initiating upload', {
    fileName: request.fileName,
    fileSize: request.fileSize,
    contentType: request.contentType,
  });

  // Additional validation
  await validateUploadRequest(request);

  // Check rate limits
  await checkRateLimit(request.userId);

  // Generate upload ID and S3 key
  const uploadId = generateUploadId();
  const s3Key = generateS3Key(request.userId, uploadId, request.fileName);
  
  logger.setContext({ uploadId });

  try {
    // Create DynamoDB record
    const uploadRecord: DatabaseUploadRequest = {
      uploadId,
      userId: request.userId,
      fileName: request.fileName,
      fileSize: request.fileSize,
      contentType: request.contentType,
      metadata: request.metadata,
      status: UploadStatus.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
      ttl: generateTTL(24), // 24 hours TTL
    };

    await retry(
      () => document.send(new PutCommand({
        TableName: config.uploadTable,
        Item: uploadRecord,
        ConditionExpression: 'attribute_not_exists(uploadId)', // Prevent duplicates
      })),
      createRetryConfig(),
      'createUploadRecord'
    );

    logger.info('Upload record created', { uploadId, s3Key });

    // Generate presigned URL
    const presignedUrl = await awsClients.generatePresignedUrl(
      config.uploadBucket,
      s3Key,
      UPLOAD_CONSTRAINTS.PRESIGNED_URL_EXPIRY,
      request.contentType
    );

    // Publish metrics
    await awsClients.publishMetric(
      'iSync/Uploads',
      'UploadInitiated',
      1,
      'Count',
      [
        { Name: 'Environment', Value: config.nodeEnv },
        { Name: 'ContentType', Value: request.contentType },
      ]
    );

    const response: PresignedUrlResponse = {
      uploadId,
      presignedUrl,
      expiresIn: UPLOAD_CONSTRAINTS.PRESIGNED_URL_EXPIRY,
      maxFileSize: getMaxFileSizeForType(request.contentType),
      requiredHeaders: {
        'Content-Type': request.contentType,
      },
    };

    logger.info('Upload initiation successful', {
      uploadId,
      expiresIn: response.expiresIn,
    });

    return createSuccessResponse(response, 201);

  } catch (error) {
    logger.error('Failed to create upload record', error, { uploadId });
    
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new ValidationError('Upload with this ID already exists');
    }
    
    throw new AWSServiceError('DynamoDB', ErrorCode.DYNAMODB_ERROR, 'Failed to create upload record', true, error as Error);
  }
}

/**
 * Handle upload status check (GET /upload/{id})
 */
async function handleUploadStatus(event: APIGatewayProxyEvent, requestId: string) {
  const uploadId = event.pathParameters?.id;
  const userId = event.queryStringParameters?.userId;

  const queryData = { uploadId, userId };
  
  // Validate request
  const validationResult = UploadStatusQuerySchema.safeParse(queryData);
  if (!validationResult.success) {
    const errors = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  }

  const { uploadId: validatedUploadId, userId: validatedUserId } = validationResult.data;
  
  logger.setContext({ uploadId: validatedUploadId, userId: validatedUserId });
  logger.info('Checking upload status');

  try {
    const result = await retry(
      () => document.send(new GetCommand({
        TableName: config.uploadTable,
        Key: {
          uploadId: validatedUploadId,
          userId: validatedUserId,
        },
      })),
      createRetryConfig(),
      'getUploadStatus'
    );

    if (!result.Item) {
      throw new iSyncError(
        ErrorCode.UPLOAD_NOT_FOUND,
        'Upload not found',
        404
      );
    }

    const upload = result.Item as DatabaseUploadRequest;
    
    logger.info('Upload status retrieved', {
      status: upload.status,
      createdAt: upload.createdAt,
      updatedAt: upload.updatedAt,
    });

    // Remove sensitive fields from response
    const { ttl, ...safeUpload } = upload;

    return createSuccessResponse(safeUpload);

  } catch (error) {
    if (error instanceof iSyncError) {
      throw error;
    }
    
    logger.error('Failed to retrieve upload status', error);
    throw new AWSServiceError('DynamoDB', ErrorCode.DYNAMODB_ERROR, 'Failed to retrieve upload status', true, error as Error);
  }
}

/**
 * Handle upload cancellation (DELETE /upload/{id})
 */
async function handleUploadCancellation(event: APIGatewayProxyEvent, requestId: string) {
  const uploadId = event.pathParameters?.id;
  const body = parseJSON(event.body || '{}') as Record<string, unknown>;
  const cancelData = { uploadId, ...body };

  // Validate request
  const validationResult = CancelUploadSchema.safeParse(cancelData);
  if (!validationResult.success) {
    const errors = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  }

  const { uploadId: validatedUploadId, userId, reason } = validationResult.data;
  
  logger.setContext({ uploadId: validatedUploadId, userId });
  logger.info('Cancelling upload', { reason });

  try {
    // Update upload status to failed
    const updateResult = await retry(
      () => document.send(new UpdateCommand({
        TableName: config.uploadTable,
        Key: {
          uploadId: validatedUploadId,
          userId,
        },
        UpdateExpression: 'SET #status = :status, updatedAt = :updated, #error = :reason',
        ConditionExpression: 'attribute_exists(uploadId) AND #status IN (:pending, :uploading)',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#error': 'error',
        },
        ExpressionAttributeValues: {
          ':status': UploadStatus.FAILED,
          ':updated': Date.now(),
          ':reason': reason || 'Cancelled by user',
          ':pending': UploadStatus.PENDING,
          ':uploading': UploadStatus.UPLOADING,
        },
        ReturnValues: 'ALL_NEW',
      })),
      createRetryConfig(),
      'cancelUpload'
    );

    if (!updateResult.Attributes) {
      throw new iSyncError(
        ErrorCode.UPLOAD_NOT_FOUND,
        'Upload not found or cannot be cancelled',
        404
      );
    }

    logger.info('Upload cancelled successfully');

    // Publish metrics
    await awsClients.publishMetric(
      'iSync/Uploads',
      'UploadCancelled',
      1,
      'Count',
      [{ Name: 'Environment', Value: config.nodeEnv }]
    );

    return createSuccessResponse({ 
      message: 'Upload cancelled successfully',
      uploadId: validatedUploadId,
      status: UploadStatus.FAILED,
    });

  } catch (error) {
    if (error instanceof iSyncError) {
      throw error;
    }
    
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new iSyncError(
        ErrorCode.UPLOAD_NOT_FOUND,
        'Upload not found or cannot be cancelled',
        404
      );
    }
    
    logger.error('Failed to cancel upload', error);
    throw new AWSServiceError('DynamoDB', ErrorCode.DYNAMODB_ERROR, 'Failed to cancel upload', true, error as Error);
  }
}

/**
 * Validate upload request with additional business rules
 */
async function validateUploadRequest(request: UploadRequestType): Promise<void> {
  // Check file type consistency
  if (!validateFileTypeConsistency(request.fileName, request.contentType)) {
    throw new FileError(
      ErrorCode.INVALID_FILE_TYPE,
      'File extension does not match content type',
      request.fileName
    );
  }

  // Check file size against content type limits
  const maxSize = getMaxFileSizeForType(request.contentType);
  if (request.fileSize > maxSize) {
    throw new FileError(
      ErrorCode.FILE_TOO_LARGE,
      `File too large for ${request.contentType}. Maximum size is ${Math.floor(maxSize / (1024 * 1024))}MB`,
      request.fileName
    );
  }
}

/**
 * Check rate limits for user
 */
async function checkRateLimit(userId: string): Promise<void> {
  try {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    const result = await document.send(new QueryCommand({
      TableName: config.uploadTable,
      IndexName: 'UserUploadsIndex',
      KeyConditionExpression: 'userId = :userId AND createdAt > :oneHourAgo',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':oneHourAgo': oneHourAgo,
      },
      Select: 'COUNT',
    }));

    const recentUploads = result.Count || 0;
    
    if (recentUploads >= UPLOAD_CONSTRAINTS.MAX_UPLOADS_PER_USER_PER_HOUR) {
      throw new RateLimitError(
        `Rate limit exceeded. Maximum ${UPLOAD_CONSTRAINTS.MAX_UPLOADS_PER_USER_PER_HOUR} uploads per hour allowed.`,
        3600 // Retry after 1 hour
      );
    }

    logger.debug('Rate limit check passed', {
      userId,
      recentUploads,
      limit: UPLOAD_CONSTRAINTS.MAX_UPLOADS_PER_USER_PER_HOUR,
    });

  } catch (error) {
    if (error instanceof RateLimitError) {
      throw error;
    }
    
    logger.warn('Rate limit check failed, allowing request', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    // Don't block uploads if rate limit check fails
  }
}