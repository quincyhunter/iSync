"""
Status Updater for iSync Music Processor
Handles DynamoDB status updates during music file processing
"""

import logging
import time
from typing import Optional, Dict, Any
from datetime import datetime
from enum import Enum
import boto3
from botocore.exceptions import ClientError, NoCredentialsError
from config import Config

logger = logging.getLogger(__name__)

class ProcessingStatus(Enum):
    """Processing status enumeration"""
    PENDING = "pending"
    PROCESSING = "processing"
    DOWNLOADING = "downloading"
    IMPORTING = "importing"
    SYNCING = "syncing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class StatusUpdater:
    """Handles DynamoDB status updates for music processing"""
    
    def __init__(self, config: Config):
        """Initialize status updater with configuration"""
        self.config = config
        
        try:
            self.dynamodb = boto3.resource('dynamodb', **config.get_aws_config())
            self.table = self.dynamodb.Table(config.dynamodb_table)
            logger.info(f"DynamoDB client initialized for table: {config.dynamodb_table}")
        except NoCredentialsError:
            logger.error("AWS credentials not found")
            raise
        except Exception as e:
            logger.error(f"Failed to initialize DynamoDB client: {e}")
            raise
    
    def update_status(self, upload_id: str, user_id: str, status: ProcessingStatus, 
                     message: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> bool:
        """
        Update processing status for an upload
        
        Args:
            upload_id: Upload ID (partition key)
            user_id: User ID (sort key)
            status: Processing status
            message: Optional status message
            metadata: Optional additional metadata
            
        Returns:
            bool: True if update successful, False otherwise
        """
        try:
            current_time = int(time.time())
            iso_time = datetime.utcnow().isoformat() + 'Z'
            
            update_expression = "SET #status = :status, updatedAt = :updated_at, updatedAtISO = :updated_iso"
            expression_values = {
                ':status': status.value,
                ':updated_at': current_time,
                ':updated_iso': iso_time
            }
            expression_names = {
                '#status': 'status'  # 'status' is a reserved word in DynamoDB
            }
            
            # Add message if provided
            if message:
                update_expression += ", statusMessage = :message"
                expression_values[':message'] = message
            
            # Add metadata if provided
            if metadata:
                update_expression += ", processingMetadata = :metadata"
                expression_values[':metadata'] = metadata
            
            # Add completion timestamp if status is completed or failed
            if status in [ProcessingStatus.COMPLETED, ProcessingStatus.FAILED, ProcessingStatus.CANCELLED]:
                update_expression += ", completedAt = :completed_at"
                expression_values[':completed_at'] = current_time
            
            # Add processing start time if status is processing
            if status == ProcessingStatus.PROCESSING:
                update_expression += ", processingStartedAt = :processing_started"
                expression_values[':processing_started'] = current_time
            
            logger.info(f"Updating status for upload {upload_id} (user {user_id}) to {status.value}")
            
            response = self.table.update_item(
                Key={
                    'uploadId': upload_id,
                    'userId': user_id
                },
                UpdateExpression=update_expression,
                ExpressionAttributeValues=expression_values,
                ExpressionAttributeNames=expression_names,
                ReturnValues="UPDATED_NEW"
            )
            
            logger.info(f"Successfully updated status for upload {upload_id} to {status.value}")
            return True
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'ResourceNotFoundException':
                logger.error(f"DynamoDB table {self.config.dynamodb_table} not found")
            elif error_code == 'ConditionalCheckFailedException':
                logger.error(f"Upload record {upload_id} not found or condition failed")
            else:
                logger.error(f"DynamoDB client error updating status: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error updating status for upload {upload_id}: {e}")
            return False
    
    def get_upload_record(self, upload_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """
        Get an upload record from DynamoDB
        
        Args:
            upload_id: Upload ID (partition key)
            user_id: User ID (sort key)
            
        Returns:
            dict: Upload record if found, None otherwise
        """
        try:
            response = self.table.get_item(
                Key={
                    'uploadId': upload_id,
                    'userId': user_id
                }
            )
            
            if 'Item' in response:
                logger.info(f"Retrieved upload record for {upload_id}")
                return response['Item']
            else:
                logger.warning(f"Upload record {upload_id} not found")
                return None
                
        except ClientError as e:
            logger.error(f"DynamoDB client error retrieving upload record {upload_id}: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error retrieving upload record {upload_id}: {e}")
            return None
    
    def increment_attempts(self, upload_id: str, user_id: str) -> bool:
        """
        Increment the processing attempts counter for an upload
        
        Args:
            upload_id: Upload ID (partition key)
            user_id: User ID (sort key)
            
        Returns:
            bool: True if increment successful, False otherwise
        """
        try:
            current_time = int(time.time())
            
            response = self.table.update_item(
                Key={
                    'uploadId': upload_id,
                    'userId': user_id
                },
                UpdateExpression="ADD attempts :increment SET lastAttemptAt = :last_attempt",
                ExpressionAttributeValues={
                    ':increment': 1,
                    ':last_attempt': current_time
                },
                ReturnValues="UPDATED_NEW"
            )
            
            attempts = response.get('Attributes', {}).get('attempts', 0)
            logger.info(f"Incremented attempts for upload {upload_id} to {attempts}")
            return True
            
        except ClientError as e:
            logger.error(f"DynamoDB client error incrementing attempts for {upload_id}: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error incrementing attempts for {upload_id}: {e}")
            return False
    
    def update_progress(self, upload_id: str, user_id: str, stage: str, 
                       progress_percent: int = 0, details: Optional[str] = None) -> bool:
        """
        Update processing progress for an upload
        
        Args:
            upload_id: Upload ID
            user_id: User ID
            stage: Current processing stage
            progress_percent: Progress percentage (0-100)
            details: Optional progress details
            
        Returns:
            bool: True if update successful, False otherwise
        """
        try:
            current_time = int(time.time())
            
            progress_data = {
                'stage': stage,
                'percent': progress_percent,
                'updatedAt': current_time
            }
            
            if details:
                progress_data['details'] = details
            
            response = self.table.update_item(
                Key={
                    'uploadId': upload_id,
                    'userId': user_id
                },
                UpdateExpression="SET progress = :progress, updatedAt = :updated_at",
                ExpressionAttributeValues={
                    ':progress': progress_data,
                    ':updated_at': current_time
                },
                ReturnValues="NONE"
            )
            
            logger.debug(f"Updated progress for upload {upload_id}: {stage} ({progress_percent}%)")
            return True
            
        except ClientError as e:
            logger.error(f"DynamoDB client error updating progress for {upload_id}: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error updating progress for {upload_id}: {e}")
            return False
    
    def add_error_details(self, upload_id: str, user_id: str, error_type: str, 
                         error_message: str, error_details: Optional[Dict[str, Any]] = None) -> bool:
        """
        Add error details to an upload record
        
        Args:
            upload_id: Upload ID
            user_id: User ID
            error_type: Type of error (e.g., 'DOWNLOAD_ERROR', 'ITUNES_ERROR')
            error_message: Error message
            error_details: Optional additional error details
            
        Returns:
            bool: True if update successful, False otherwise
        """
        try:
            current_time = int(time.time())
            
            error_data = {
                'type': error_type,
                'message': error_message,
                'timestamp': current_time
            }
            
            if error_details:
                error_data['details'] = error_details
            
            response = self.table.update_item(
                Key={
                    'uploadId': upload_id,
                    'userId': user_id
                },
                UpdateExpression="SET lastError = :error, updatedAt = :updated_at",
                ExpressionAttributeValues={
                    ':error': error_data,
                    ':updated_at': current_time
                },
                ReturnValues="NONE"
            )
            
            logger.info(f"Added error details for upload {upload_id}: {error_type}")
            return True
            
        except ClientError as e:
            logger.error(f"DynamoDB client error adding error details for {upload_id}: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error adding error details for {upload_id}: {e}")
            return False
    
    def mark_processing_complete(self, upload_id: str, user_id: str, 
                               itunes_track_id: Optional[str] = None,
                               processing_duration: Optional[int] = None) -> bool:
        """
        Mark processing as complete with success details
        
        Args:
            upload_id: Upload ID
            user_id: User ID
            itunes_track_id: iTunes track ID if available
            processing_duration: Processing duration in seconds
            
        Returns:
            bool: True if update successful, False otherwise
        """
        completion_metadata = {}
        
        if itunes_track_id:
            completion_metadata['itunesTrackId'] = itunes_track_id
        
        if processing_duration:
            completion_metadata['processingDuration'] = processing_duration
        
        return self.update_status(
            upload_id=upload_id,
            user_id=user_id,
            status=ProcessingStatus.COMPLETED,
            message="File successfully processed and added to iTunes library",
            metadata=completion_metadata
        )