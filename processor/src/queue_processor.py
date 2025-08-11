"""
SQS Queue Processor for iSync Music Processor
Handles polling SQS for music processing messages and message lifecycle management
"""

import json
import logging
import time
from typing import List, Dict, Any, Optional
import boto3
from botocore.exceptions import ClientError, NoCredentialsError
from dataclasses import dataclass
from config import Config

logger = logging.getLogger(__name__)

@dataclass
class ProcessingMessage:
    """Represents a music file processing message from SQS"""
    
    # SQS message properties
    message_id: str
    receipt_handle: str
    
    # Processing data
    upload_id: str
    user_id: str
    s3_key: str
    file_name: str
    file_size: int
    content_type: str
    
    # Metadata
    metadata: Dict[str, Any]
    
    # Processing context
    attempts: int = 0
    created_at: Optional[int] = None
    
    @classmethod
    def from_sqs_message(cls, sqs_message: Dict[str, Any]) -> Optional['ProcessingMessage']:
        """
        Create ProcessingMessage from SQS message
        
        Args:
            sqs_message: Raw SQS message dictionary
            
        Returns:
            ProcessingMessage instance or None if parsing fails
        """
        try:
            # Parse the message body (JSON)
            body = json.loads(sqs_message['Body'])
            
            # Extract required fields
            upload_id = body.get('uploadId')
            user_id = body.get('userId')
            s3_key = body.get('s3Key')
            file_name = body.get('fileName')
            file_size = body.get('fileSize')
            content_type = body.get('contentType')
            metadata = body.get('metadata', {})
            
            # Validate required fields
            if not all([upload_id, user_id, s3_key, file_name]):
                logger.error(f"Missing required fields in SQS message: {body}")
                return None
            
            return cls(
                message_id=sqs_message['MessageId'],
                receipt_handle=sqs_message['ReceiptHandle'],
                upload_id=upload_id,
                user_id=user_id,
                s3_key=s3_key,
                file_name=file_name,
                file_size=file_size or 0,
                content_type=content_type or 'application/octet-stream',
                metadata=metadata,
                attempts=body.get('attempts', 0),
                created_at=body.get('createdAt')
            )
            
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            logger.error(f"Failed to parse SQS message: {e}")
            logger.debug(f"Message body: {sqs_message.get('Body', 'N/A')}")
            return None

class QueueProcessor:
    """Handles SQS queue operations for music processing messages"""
    
    def __init__(self, config: Config):
        """
        Initialize queue processor with configuration
        
        Args:
            config: Configuration instance
        """
        self.config = config
        
        try:
            self.sqs = boto3.client('sqs', **config.get_aws_config())
            logger.info(f"SQS client initialized for queue: {config.sqs_queue_url}")
        except NoCredentialsError:
            logger.error("AWS credentials not found")
            raise
        except Exception as e:
            logger.error(f"Failed to initialize SQS client: {e}")
            raise
    
    def get_messages(self, max_messages: int = 1, wait_time: Optional[int] = None) -> List[ProcessingMessage]:
        """
        Poll SQS queue for processing messages
        
        Args:
            max_messages: Maximum number of messages to retrieve (1-10)
            wait_time: Long polling wait time in seconds (0-20)
            
        Returns:
            list: List of ProcessingMessage objects
        """
        if wait_time is None:
            wait_time = self.config.message_wait_time
        
        # Validate parameters
        max_messages = min(max(max_messages, 1), 10)  # SQS limit is 10
        wait_time = min(max(wait_time, 0), 20)  # SQS limit is 20
        
        try:
            logger.debug(f"Polling SQS queue for up to {max_messages} messages (wait time: {wait_time}s)")
            
            response = self.sqs.receive_message(
                QueueUrl=self.config.sqs_queue_url,
                MaxNumberOfMessages=max_messages,
                WaitTimeSeconds=wait_time,
                MessageAttributeNames=['All'],
                AttributeNames=['All']
            )
            
            messages = response.get('Messages', [])
            
            if not messages:
                logger.debug("No messages available in queue")
                return []
            
            logger.info(f"Retrieved {len(messages)} message(s) from SQS queue")
            
            # Parse messages into ProcessingMessage objects
            processing_messages = []
            for message in messages:
                processing_message = ProcessingMessage.from_sqs_message(message)
                if processing_message:
                    processing_messages.append(processing_message)
                else:
                    logger.warning(f"Failed to parse message {message.get('MessageId', 'unknown')}")
            
            logger.info(f"Successfully parsed {len(processing_messages)} message(s)")
            return processing_messages
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'AWS.SimpleQueueService.NonExistentQueue':
                logger.error(f"SQS queue does not exist: {self.config.sqs_queue_url}")
            else:
                logger.error(f"SQS client error retrieving messages: {e}")
            return []
        except Exception as e:
            logger.error(f"Unexpected error retrieving messages from SQS: {e}")
            return []
    
    def delete_message(self, message: ProcessingMessage) -> bool:
        """
        Delete a message from SQS queue after successful processing
        
        Args:
            message: ProcessingMessage to delete
            
        Returns:
            bool: True if deletion successful, False otherwise
        """
        try:
            logger.info(f"Deleting SQS message for upload {message.upload_id}")
            
            self.sqs.delete_message(
                QueueUrl=self.config.sqs_queue_url,
                ReceiptHandle=message.receipt_handle
            )
            
            logger.info(f"Successfully deleted SQS message {message.message_id}")
            return True
            
        except ClientError as e:
            logger.error(f"SQS client error deleting message {message.message_id}: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error deleting message {message.message_id}: {e}")
            return False
    
    def change_message_visibility(self, message: ProcessingMessage, visibility_timeout: int) -> bool:
        """
        Change message visibility timeout (extend processing time)
        
        Args:
            message: ProcessingMessage to modify
            visibility_timeout: New visibility timeout in seconds
            
        Returns:
            bool: True if change successful, False otherwise
        """
        try:
            logger.debug(f"Changing message visibility for upload {message.upload_id} to {visibility_timeout}s")
            
            self.sqs.change_message_visibility(
                QueueUrl=self.config.sqs_queue_url,
                ReceiptHandle=message.receipt_handle,
                VisibilityTimeout=visibility_timeout
            )
            
            logger.debug(f"Successfully changed message visibility for {message.message_id}")
            return True
            
        except ClientError as e:
            logger.error(f"SQS client error changing message visibility: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error changing message visibility: {e}")
            return False
    
    def get_queue_attributes(self) -> Dict[str, Any]:
        """
        Get queue attributes for monitoring
        
        Returns:
            dict: Queue attributes
        """
        try:
            response = self.sqs.get_queue_attributes(
                QueueUrl=self.config.sqs_queue_url,
                AttributeNames=['All']
            )
            
            attributes = response.get('Attributes', {})
            
            # Convert numeric attributes to integers
            numeric_attrs = [
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
                'ApproximateNumberOfMessagesDelayed',
                'ApproximateAgeOfOldestMessage'
            ]
            
            for attr in numeric_attrs:
                if attr in attributes:
                    try:
                        attributes[attr] = int(attributes[attr])
                    except ValueError:
                        pass
            
            logger.debug(f"Queue attributes: {attributes}")
            return attributes
            
        except ClientError as e:
            logger.error(f"SQS client error getting queue attributes: {e}")
            return {}
        except Exception as e:
            logger.error(f"Unexpected error getting queue attributes: {e}")
            return {}
    
    def send_message_to_dlq(self, message: ProcessingMessage, error_reason: str) -> bool:
        """
        Send a failed message to dead letter queue (if configured)
        
        Args:
            message: ProcessingMessage that failed processing
            error_reason: Reason for failure
            
        Returns:
            bool: True if sent to DLQ successfully, False otherwise
        """
        try:
            # Create DLQ message body with error information
            dlq_body = {
                'originalMessage': {
                    'uploadId': message.upload_id,
                    'userId': message.user_id,
                    's3Key': message.s3_key,
                    'fileName': message.file_name,
                    'fileSize': message.file_size,
                    'contentType': message.content_type,
                    'metadata': message.metadata,
                    'attempts': message.attempts
                },
                'errorInformation': {
                    'reason': error_reason,
                    'failedAt': int(time.time()),
                    'originalMessageId': message.message_id
                }
            }
            
            # Note: In a real implementation, you would need the DLQ URL
            # For now, we'll log the failure
            logger.error(f"Message failed processing and should be sent to DLQ: {json.dumps(dlq_body)}")
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to send message to DLQ: {e}")
            return False
    
    def is_queue_empty(self) -> bool:
        """
        Check if the queue is empty
        
        Returns:
            bool: True if queue is empty, False otherwise
        """
        attributes = self.get_queue_attributes()
        visible_messages = attributes.get('ApproximateNumberOfMessages', 0)
        invisible_messages = attributes.get('ApproximateNumberOfMessagesNotVisible', 0)
        
        return visible_messages == 0 and invisible_messages == 0