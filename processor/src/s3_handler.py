"""
S3 File Handler for iSync Music Processor
Handles downloading music files from S3 and uploading processing results
"""

import os
import logging
from typing import Optional, Dict, Any
from pathlib import Path
import boto3
from botocore.exceptions import ClientError, NoCredentialsError
from config import Config

logger = logging.getLogger(__name__)

class S3Handler:
    """Handles S3 file operations for music processing"""
    
    def __init__(self, config: Config):
        """Initialize S3 handler with configuration"""
        self.config = config
        
        try:
            self.s3_client = boto3.client('s3', **config.get_aws_config())
            logger.info("S3 client initialized successfully")
        except NoCredentialsError:
            logger.error("AWS credentials not found")
            raise
        except Exception as e:
            logger.error(f"Failed to initialize S3 client: {e}")
            raise
    
    def download_file(self, s3_key: str, local_path: str) -> bool:
        """
        Download a file from S3 to local storage
        
        Args:
            s3_key: S3 object key (e.g., 'users/user123/upload456/song.mp3')
            local_path: Local file path to save the file
            
        Returns:
            bool: True if download successful, False otherwise
        """
        try:
            # Create directory if it doesn't exist
            local_dir = os.path.dirname(local_path)
            os.makedirs(local_dir, exist_ok=True)
            
            logger.info(f"Downloading {s3_key} from bucket {self.config.s3_bucket} to {local_path}")
            
            # Download the file
            self.s3_client.download_file(
                Bucket=self.config.s3_bucket,
                Key=s3_key,
                Filename=local_path
            )
            
            # Verify file was downloaded and has content
            if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
                file_size = os.path.getsize(local_path)
                logger.info(f"Successfully downloaded {s3_key} ({file_size} bytes)")
                return True
            else:
                logger.error(f"Downloaded file {local_path} is empty or doesn't exist")
                return False
                
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'NoSuchKey':
                logger.error(f"File {s3_key} not found in S3 bucket {self.config.s3_bucket}")
            elif error_code == 'NoSuchBucket':
                logger.error(f"S3 bucket {self.config.s3_bucket} not found")
            else:
                logger.error(f"S3 client error downloading {s3_key}: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error downloading {s3_key}: {e}")
            return False
    
    def upload_file(self, local_path: str, s3_key: str, metadata: Optional[Dict[str, str]] = None) -> bool:
        """
        Upload a file from local storage to S3
        
        Args:
            local_path: Local file path to upload
            s3_key: S3 object key to store the file
            metadata: Optional metadata to attach to the S3 object
            
        Returns:
            bool: True if upload successful, False otherwise
        """
        try:
            if not os.path.exists(local_path):
                logger.error(f"Local file {local_path} does not exist")
                return False
            
            upload_args = {
                'Bucket': self.config.s3_bucket,
                'Key': s3_key,
                'Filename': local_path
            }
            
            # Add metadata if provided
            if metadata:
                upload_args['ExtraArgs'] = {'Metadata': metadata}
            
            logger.info(f"Uploading {local_path} to {s3_key} in bucket {self.config.s3_bucket}")
            
            self.s3_client.upload_file(**upload_args)
            
            logger.info(f"Successfully uploaded {local_path} to {s3_key}")
            return True
            
        except ClientError as e:
            logger.error(f"S3 client error uploading {local_path}: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error uploading {local_path}: {e}")
            return False
    
    def delete_file(self, s3_key: str) -> bool:
        """
        Delete a file from S3
        
        Args:
            s3_key: S3 object key to delete
            
        Returns:
            bool: True if deletion successful, False otherwise
        """
        try:
            logger.info(f"Deleting {s3_key} from bucket {self.config.s3_bucket}")
            
            self.s3_client.delete_object(
                Bucket=self.config.s3_bucket,
                Key=s3_key
            )
            
            logger.info(f"Successfully deleted {s3_key}")
            return True
            
        except ClientError as e:
            logger.error(f"S3 client error deleting {s3_key}: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error deleting {s3_key}: {e}")
            return False
    
    def get_file_metadata(self, s3_key: str) -> Optional[Dict[str, Any]]:
        """
        Get metadata for an S3 object
        
        Args:
            s3_key: S3 object key to get metadata for
            
        Returns:
            dict: Object metadata if successful, None otherwise
        """
        try:
            response = self.s3_client.head_object(
                Bucket=self.config.s3_bucket,
                Key=s3_key
            )
            
            return {
                'size': response.get('ContentLength', 0),
                'last_modified': response.get('LastModified'),
                'content_type': response.get('ContentType', ''),
                'metadata': response.get('Metadata', {})
            }
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'NoSuchKey':
                logger.warning(f"File {s3_key} not found in S3 bucket {self.config.s3_bucket}")
            else:
                logger.error(f"S3 client error getting metadata for {s3_key}: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error getting metadata for {s3_key}: {e}")
            return None
    
    def generate_download_path(self, s3_key: str) -> str:
        """
        Generate a safe local download path for an S3 key
        
        Args:
            s3_key: S3 object key
            
        Returns:
            str: Safe local file path
        """
        # Extract filename from S3 key
        filename = os.path.basename(s3_key)
        
        # Create a subdirectory based on the S3 key structure
        # e.g., 'users/user123/upload456/song.mp3' -> 'user123/upload456/song.mp3'
        parts = s3_key.split('/')
        if len(parts) >= 3 and parts[0] == 'users':
            # Extract user_id and upload_id for directory structure
            user_id = parts[1]
            upload_id = parts[2]
            subdir = os.path.join(user_id, upload_id)
        else:
            # Fallback: use hash of s3_key as subdirectory
            import hashlib
            subdir = hashlib.md5(s3_key.encode()).hexdigest()[:8]
        
        # Combine download directory with subdirectory and filename
        return os.path.join(self.config.download_directory, subdir, filename)
    
    def cleanup_local_file(self, local_path: str) -> bool:
        """
        Clean up a local file after processing
        
        Args:
            local_path: Local file path to delete
            
        Returns:
            bool: True if cleanup successful, False otherwise
        """
        try:
            if os.path.exists(local_path):
                os.remove(local_path)
                logger.info(f"Cleaned up local file: {local_path}")
                return True
            else:
                logger.warning(f"Local file {local_path} does not exist for cleanup")
                return True
                
        except Exception as e:
            logger.error(f"Failed to cleanup local file {local_path}: {e}")
            return False