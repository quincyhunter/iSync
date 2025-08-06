#!/bin/bash

# iSync Music Processing Instance Initialization Script
# This script sets up the EC2 instance for music processing

set -e

# Update system
apt-get update
apt-get upgrade -y

# Install required packages
apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    unzip \
    awscli \
    jq \
    wine \
    xvfb

# Create application directory
mkdir -p /opt/isync
cd /opt/isync

# Create system user for the application
useradd -r -s /bin/false -d /opt/isync isync-processor
chown -R isync-processor:isync-processor /opt/isync

# Create Python virtual environment
python3 -m venv venv
source venv/bin/activate

# Install Python dependencies
pip install --upgrade pip
pip install boto3 botocore python-dotenv requests

# Create environment configuration
cat > /opt/isync/.env <<EOF
ENVIRONMENT=${environment}
AWS_DEFAULT_REGION=${aws_region}
QUEUE_URL=${queue_url}
UPLOAD_BUCKET=${upload_bucket}
UPLOAD_TABLE=${upload_table}
PYTHONPATH=/opt/isync
EOF

# Create the main processor script
cat > /opt/isync/processor.py <<'PYTHON_SCRIPT'
#!/usr/bin/env python3
"""
iSync Music Processor
Processes music files from SQS queue and adds them to iTunes library
"""

import os
import sys
import json
import time
import logging
import subprocess
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional

import boto3
from botocore.exceptions import ClientError

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/opt/isync/processor.log'),
        logging.StreamHandler()
    ]
)

logger = logging.getLogger(__name__)

class MusicProcessor:
    def __init__(self):
        self.s3_client = boto3.client('s3')
        self.sqs_client = boto3.client('sqs')
        self.dynamodb = boto3.resource('dynamodb')
        
        self.queue_url = os.environ['QUEUE_URL']
        self.upload_bucket = os.environ['UPLOAD_BUCKET']
        self.upload_table = self.dynamodb.Table(os.environ['UPLOAD_TABLE'])
        
        self.working_dir = Path('/tmp/isync-processing')
        self.working_dir.mkdir(exist_ok=True)
        
        logger.info(f"Initialized processor with bucket: {self.upload_bucket}")
        logger.info(f"Queue URL: {self.queue_url}")

    def process_queue(self):
        """Process all messages in the SQS queue"""
        logger.info("Starting queue processing...")
        
        processed_count = 0
        while True:
            # Receive messages from SQS
            try:
                response = self.sqs_client.receive_message(
                    QueueUrl=self.queue_url,
                    MaxNumberOfMessages=10,
                    WaitTimeSeconds=20,
                    VisibilityTimeoutSeconds=300
                )
                
                messages = response.get('Messages', [])
                if not messages:
                    logger.info("No more messages in queue")
                    break
                
                for message in messages:
                    try:
                        self.process_message(message)
                        processed_count += 1
                        
                        # Delete message after successful processing
                        self.sqs_client.delete_message(
                            QueueUrl=self.queue_url,
                            ReceiptHandle=message['ReceiptHandle']
                        )
                        
                    except Exception as e:
                        logger.error(f"Error processing message: {e}")
                        
            except Exception as e:
                logger.error(f"Error receiving messages: {e}")
                break
        
        logger.info(f"Processed {processed_count} files")
        return processed_count

    def process_message(self, message: Dict[str, Any]):
        """Process a single SQS message"""
        body = json.loads(message['Body'])
        upload_id = body.get('uploadId')
        user_id = body.get('userId')
        s3_key = body.get('s3Key')
        
        logger.info(f"Processing upload {upload_id} for user {user_id}")
        
        # Update status to processing
        self.update_status(upload_id, user_id, 'processing')
        
        try:
            # Download file from S3
            local_file = self.download_file(s3_key)
            
            # Process the file (placeholder for actual iTunes integration)
            success = self.add_to_itunes(local_file, body.get('metadata', {}))
            
            if success:
                self.update_status(upload_id, user_id, 'completed')
                logger.info(f"Successfully processed {upload_id}")
            else:
                self.update_status(upload_id, user_id, 'failed', 'iTunes processing failed')
                logger.error(f"Failed to process {upload_id}")
                
        except Exception as e:
            logger.error(f"Error processing {upload_id}: {e}")
            self.update_status(upload_id, user_id, 'failed', str(e))
        finally:
            # Cleanup
            if 'local_file' in locals():
                try:
                    os.unlink(local_file)
                except:
                    pass

    def download_file(self, s3_key: str) -> Path:
        """Download file from S3"""
        filename = Path(s3_key).name
        local_file = self.working_dir / filename
        
        logger.info(f"Downloading {s3_key} to {local_file}")
        
        self.s3_client.download_file(
            self.upload_bucket,
            s3_key,
            str(local_file)
        )
        
        return local_file

    def add_to_itunes(self, file_path: Path, metadata: Dict[str, Any]) -> bool:
        """Add file to iTunes library (placeholder implementation)"""
        logger.info(f"Adding {file_path} to iTunes library")
        
        # TODO: Implement actual iTunes/Apple Music integration
        # For now, just simulate processing
        time.sleep(2)
        
        # Move file to processed folder in S3
        processed_key = f"processed/{file_path.name}"
        try:
            self.s3_client.copy_object(
                CopySource={'Bucket': self.upload_bucket, 'Key': str(file_path.name)},
                Bucket=self.upload_bucket,
                Key=processed_key
            )
            logger.info(f"Moved file to processed folder: {processed_key}")
            return True
        except Exception as e:
            logger.error(f"Failed to move file to processed folder: {e}")
            return False

    def update_status(self, upload_id: str, user_id: str, status: str, error: str = None):
        """Update upload status in DynamoDB"""
        try:
            update_expression = "SET #status = :status, updatedAt = :updated"
            expression_values = {
                ':status': status,
                ':updated': int(datetime.utcnow().timestamp())
            }
            expression_names = {'#status': 'status'}
            
            if error:
                update_expression += ", #error = :error"
                expression_values[':error'] = error
                expression_names['#error'] = 'error'
            
            if status == 'completed':
                update_expression += ", completedAt = :completed"
                expression_values[':completed'] = int(datetime.utcnow().timestamp())
            
            self.upload_table.update_item(
                Key={'uploadId': upload_id, 'userId': user_id},
                UpdateExpression=update_expression,
                ExpressionAttributeValues=expression_values,
                ExpressionAttributeNames=expression_names
            )
            
            logger.info(f"Updated status for {upload_id}: {status}")
            
        except Exception as e:
            logger.error(f"Failed to update status for {upload_id}: {e}")

def main():
    """Main entry point"""
    logger.info("Starting iSync Music Processor")
    
    processor = MusicProcessor()
    processed_count = processor.process_queue()
    
    logger.info(f"Processing complete. Processed {processed_count} files.")
    
    # If no files were processed, shut down the instance after a short delay
    if processed_count == 0:
        logger.info("No files to process, shutting down instance in 5 minutes")
        time.sleep(300)
        
        # Get instance ID and shutdown
        try:
            response = subprocess.run(['curl', '-s', 'http://169.254.169.254/latest/meta-data/instance-id'], 
                                    capture_output=True, text=True)
            instance_id = response.stdout.strip()
            
            if instance_id:
                ec2_client = boto3.client('ec2')
                ec2_client.terminate_instances(InstanceIds=[instance_id])
                logger.info(f"Terminated instance {instance_id}")
        except Exception as e:
            logger.error(f"Failed to terminate instance: {e}")

if __name__ == "__main__":
    main()
PYTHON_SCRIPT

chmod +x /opt/isync/processor.py

# Create systemd service
cat > /etc/systemd/system/isync-processor.service <<EOF
[Unit]
Description=iSync Music Processor
After=network.target

[Service]
Type=oneshot
User=isync-processor
Group=isync-processor
WorkingDirectory=/opt/isync
Environment=PATH=/opt/isync/venv/bin
EnvironmentFile=/opt/isync/.env
ExecStart=/opt/isync/venv/bin/python /opt/isync/processor.py
StandardOutput=journal
StandardError=journal
SyslogIdentifier=isync-processor

[Install]
WantedBy=multi-user.target
EOF

# Enable and start the service
systemctl daemon-reload
systemctl enable isync-processor.service

# Set proper ownership
chown -R isync-processor:isync-processor /opt/isync

# Start processing immediately
systemctl start isync-processor.service

# Log completion
logger "iSync processor instance initialization complete"