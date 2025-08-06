/**
 * Centralized logging utility for iSync Lambda functions
 * Uses Winston with CloudWatch integration and X-Ray correlation
 */

import winston from 'winston';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug'
}

interface LogContext {
  requestId?: string;
  correlationId?: string;
  userId?: string;
  uploadId?: string;
  functionName?: string;
  [key: string]: unknown;
}

class Logger {
  private winston: winston.Logger;
  private context: LogContext = {};

  constructor() {
    const logLevel = process.env.LOG_LEVEL || 'info';
    const isDevelopment = process.env.NODE_ENV === 'development';

    this.winston = winston.createLogger({
      level: logLevel,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
        winston.format.printf((info) => {
          const { timestamp, level, message, stack, ...meta } = info as any;
          
          const logEntry = {
            timestamp,
            level,
            message,
            ...this.context,
            ...meta,
          };

          if (stack) {
            logEntry.stack = stack;
          }

          return JSON.stringify(logEntry);
        })
      ),
      transports: [
        new winston.transports.Console({
          format: isDevelopment 
            ? winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
              )
            : winston.format.json(),
        }),
      ],
    });
  }

  /**
   * Set context that will be included in all log entries
   */
  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Clear all context
   */
  clearContext(): void {
    this.context = {};
  }

  /**
   * Get current context
   */
  getContext(): LogContext {
    return { ...this.context };
  }

  /**
   * Log error message
   */
  error(message: string, error?: Error | unknown, meta?: Record<string, unknown>): void {
    const logData: Record<string, unknown> = { ...meta };
    
    if (error instanceof Error) {
      logData.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    } else if (error) {
      logData.error = error;
    }

    this.winston.error(message, logData);
  }

  /**
   * Log warning message
   */
  warn(message: string, meta?: Record<string, unknown>): void {
    this.winston.warn(message, meta);
  }

  /**
   * Log info message
   */
  info(message: string, meta?: Record<string, unknown>): void {
    this.winston.info(message, meta);
  }

  /**
   * Log debug message
   */
  debug(message: string, meta?: Record<string, unknown>): void {
    this.winston.debug(message, meta);
  }

  /**
   * Log performance metrics
   */
  performance(operation: string, durationMs: number, meta?: Record<string, unknown>): void {
    this.info(`Performance: ${operation}`, {
      operation,
      durationMs,
      ...meta,
    });
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): Logger {
    const childLogger = new Logger();
    childLogger.setContext({ ...this.context, ...context });
    return childLogger;
  }

  /**
   * Measure and log execution time of an async operation
   */
  async timeAsync<T>(operation: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
    const start = Date.now();
    this.debug(`Starting operation: ${operation}`, meta);
    
    try {
      const result = await fn();
      const duration = Date.now() - start;
      this.performance(operation, duration, { success: true, ...meta });
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.error(`Operation failed: ${operation}`, error, { duration, ...meta });
      throw error;
    }
  }

  /**
   * Measure and log execution time of a sync operation
   */
  time<T>(operation: string, fn: () => T, meta?: Record<string, unknown>): T {
    const start = Date.now();
    this.debug(`Starting operation: ${operation}`, meta);
    
    try {
      const result = fn();
      const duration = Date.now() - start;
      this.performance(operation, duration, { success: true, ...meta });
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.error(`Operation failed: ${operation}`, error, { duration, ...meta });
      throw error;
    }
  }
}

// Create singleton instance
const logger = new Logger();

// Set function name from AWS Lambda context if available
if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  logger.setContext({
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
  });
}

export { logger };
export default logger;