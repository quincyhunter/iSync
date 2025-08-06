/**
 * Custom error classes for iSync Lambda functions
 */

export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  INVALID_FILE_TYPE = 'INVALID_FILE_TYPE',
  UPLOAD_NOT_FOUND = 'UPLOAD_NOT_FOUND',
  S3_ERROR = 'S3_ERROR',
  DYNAMODB_ERROR = 'DYNAMODB_ERROR',
  SQS_ERROR = 'SQS_ERROR',
  EC2_ERROR = 'EC2_ERROR',
  METADATA_EXTRACTION_ERROR = 'METADATA_EXTRACTION_ERROR',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR = 'AUTHORIZATION_ERROR'
}

export class iSyncError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number = 500,
    retryable: boolean = false,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'iSyncError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;

    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, iSyncError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      retryable: this.retryable,
      details: this.details,
      stack: this.stack,
    };
  }
}

export class ValidationError extends iSyncError {
  constructor(message: string, field?: string) {
    super(
      ErrorCode.VALIDATION_ERROR,
      message,
      400,
      false,
      field ? { field } : undefined
    );
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class FileError extends iSyncError {
  constructor(code: ErrorCode, message: string, fileName?: string) {
    super(code, message, 400, false, fileName ? { fileName } : undefined);
    this.name = 'FileError';
    Object.setPrototypeOf(this, FileError.prototype);
  }
}

export class AWSServiceError extends iSyncError {
  public readonly service: string;

  constructor(
    service: string,
    code: ErrorCode,
    message: string,
    retryable: boolean = true,
    originalError?: Error
  ) {
    super(code, message, 500, retryable, {
      service,
      originalError: originalError?.message,
    });
    this.name = 'AWSServiceError';
    this.service = service;
    Object.setPrototypeOf(this, AWSServiceError.prototype);
  }
}

export class RateLimitError extends iSyncError {
  public readonly retryAfter: number;

  constructor(message: string, retryAfter: number = 60) {
    super(ErrorCode.RATE_LIMIT_EXCEEDED, message, 429, true, { retryAfter });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class TimeoutError extends iSyncError {
  constructor(operation: string, timeoutMs: number) {
    super(
      ErrorCode.TIMEOUT_ERROR,
      `Operation '${operation}' timed out after ${timeoutMs}ms`,
      408,
      true,
      { operation, timeoutMs }
    );
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Utility function to determine if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof iSyncError) {
    return error.retryable;
  }

  // Check for common AWS SDK retryable errors
  if (error instanceof Error) {
    const errorName = error.name;
    const retryableErrors = [
      'ThrottlingException',
      'ServiceUnavailableException', 
      'InternalServerException',
      'RequestTimeout',
      'TooManyRequestsException',
      'ProvisionedThroughputExceededException',
    ];
    return retryableErrors.includes(errorName);
  }

  return false;
}

/**
 * Extract error code from AWS SDK errors
 */
export function getAWSErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    return error.name as string;
  }
  return 'UnknownError';
}

/**
 * Create standardized error response for API Gateway
 */
export function createErrorResponse(
  error: unknown,
  requestId?: string
): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
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
  }

  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify({
      error: {
        code: errorCode,
        message,
        retryable,
        details,
      },
      requestId,
      timestamp: Date.now(),
    }),
  };
}