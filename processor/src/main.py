"""
iSync Music Processor - Main Entry Point
Runs on Windows EC2 instances to process music files with iTunes

This script orchestrates the complete workflow:
1. Poll SQS for music processing messages
2. Download files from S3
3. Add files to iTunes library
4. Apply metadata and artwork
5. Trigger iCloud sync
6. Update DynamoDB status
7. Clean up resources
"""

import os
import sys
import time
import signal
import logging
import traceback
from typing import Optional, Dict, Any
from pathlib import Path

# Local imports
from config import Config, get_config
from queue_processor import QueueProcessor, ProcessingMessage
from s3_handler import S3Handler
from itunes_controller import iTunesController, iTunesError
from status_updater import StatusUpdater, ProcessingStatus

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(r'C:\iSync\logs\processor.log', mode='a', encoding='utf-8')
    ]
)

logger = logging.getLogger(__name__)

class MusicProcessor:
    """Main processor class that orchestrates the music processing workflow"""
    
    def __init__(self):
        """Initialize the music processor with all required components"""
        self.config = get_config()
        self.running = True
        self.processing_count = 0
        
        # Initialize components
        self.queue_processor = QueueProcessor(self.config)
        self.s3_handler = S3Handler(self.config)
        self.status_updater = StatusUpdater(self.config)
        self.itunes_controller = iTunesController(timeout=self.config.itunes_timeout)
        
        # Setup signal handlers for graceful shutdown
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
        
        logger.info("Music processor initialized successfully")
    
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals gracefully"""
        logger.info(f"Received signal {signum}, initiating graceful shutdown...")
        self.running = False
    
    def run(self) -> int:
        """
        Main processing loop
        
        Returns:
            int: Exit code (0 for success, non-zero for error)
        """
        logger.info("Starting iSync music processor...")
        
        try:
            # Validate configuration
            if not self.config.is_valid():
                logger.error("Configuration validation failed")
                return 1
            
            # Initialize iTunes
            if not self.itunes_controller.initialize():
                logger.error("Failed to initialize iTunes controller")
                return 1
            
            # Log iTunes library stats
            stats = self.itunes_controller.get_library_stats()
            logger.info(f"iTunes library stats: {stats}")
            
            # Main processing loop
            while self.running:
                try:
                    self._process_batch()
                    
                    # Check if we should continue running
                    if not self.running:
                        break
                    
                    # Wait before next poll if no messages were processed
                    time.sleep(5)
                    
                except KeyboardInterrupt:
                    logger.info("Keyboard interrupt received, shutting down...")
                    break
                except Exception as e:
                    logger.error(f"Unexpected error in main loop: {e}")
                    logger.error(traceback.format_exc())
                    time.sleep(30)  # Wait longer after errors
            
            logger.info(f"Processor shutting down. Total files processed: {self.processing_count}")
            return 0
            
        except Exception as e:
            logger.error(f"Fatal error in music processor: {e}")
            logger.error(traceback.format_exc())
            return 1
        finally:
            self._cleanup()
    
    def _process_batch(self) -> None:
        """Process a batch of messages from SQS"""
        # Get messages from SQS
        messages = self.queue_processor.get_messages(
            max_messages=self.config.max_messages_per_batch,
            wait_time=self.config.message_wait_time
        )
        
        if not messages:
            logger.debug("No messages to process")
            return
        
        logger.info(f"Processing batch of {len(messages)} message(s)")
        
        # Process each message
        for message in messages:
            try:
                self._process_single_message(message)
                self.processing_count += 1
            except Exception as e:
                logger.error(f"Failed to process message {message.upload_id}: {e}")
                logger.error(traceback.format_exc())
                
                # Mark as failed in DynamoDB
                self.status_updater.update_status(
                    upload_id=message.upload_id,
                    user_id=message.user_id,
                    status=ProcessingStatus.FAILED,
                    message=f"Processing failed: {str(e)}"
                )
                
                # Send to DLQ
                self.queue_processor.send_message_to_dlq(message, str(e))
    
    def _process_single_message(self, message: ProcessingMessage) -> None:
        """
        Process a single music file message with retry logic and iTunes crash recovery
        
        Args:
            message: ProcessingMessage to process
        """
        logger.info(f"Processing upload {message.upload_id} for user {message.user_id}")
        
        max_retries = 3
        for attempt in range(max_retries):
            try:
                return self._process_single_file_attempt(message, attempt + 1)
            except Exception as e:
                logger.error(f"Attempt {attempt + 1} failed for {message.upload_id}: {e}")
                
                if attempt < max_retries - 1:
                    # Check iTunes health before retry
                    if not self.itunes_controller.handle_itunes_crash():
                        logger.error("iTunes recovery failed, skipping remaining retries")
                        break
                    
                    wait_time = (attempt + 1) * 10  # Progressive backoff
                    logger.info(f"Waiting {wait_time}s before retry {attempt + 2}")
                    time.sleep(wait_time)
                else:
                    # Final failure
                    self.status_updater.update_status(
                        upload_id=message.upload_id,
                        user_id=message.user_id,
                        status=ProcessingStatus.FAILED,
                        message=f"All retry attempts failed: {str(e)}"
                    )
                    raise
    
    def _process_single_file_attempt(self, message: ProcessingMessage, attempt_number: int) -> None:
        """
        Single attempt at processing a file
        
        Args:
            message: ProcessingMessage to process
            attempt_number: Current attempt number
        """
        logger.info(f"Processing attempt {attempt_number} for upload {message.upload_id}")
        
        # Update status to processing
        self.status_updater.update_status(
            upload_id=message.upload_id,
            user_id=message.user_id,
            status=ProcessingStatus.PROCESSING,
            message=f"Starting file processing (attempt {attempt_number})"
        )
        
        # Increment attempts counter
        self.status_updater.increment_attempts(message.upload_id, message.user_id)
        
        # Check iTunes health before processing
        if not self.itunes_controller.handle_itunes_crash():
            raise iTunesError("iTunes is not available for processing")
        
        start_time = time.time()
        local_file_path = None
        artwork_file_path = None
        
        try:
            # Step 1: Download file from S3
            logger.info(f"Step 1: Downloading file {message.s3_key}")
            self.status_updater.update_progress(
                upload_id=message.upload_id,
                user_id=message.user_id,
                stage="downloading",
                progress_percent=10,
                details=f"Downloading {message.file_name}"
            )
            
            local_file_path = self.s3_handler.generate_download_path(message.s3_key)
            
            if not self.s3_handler.download_file(message.s3_key, local_file_path):
                raise Exception("Failed to download file from S3")
            
            # Step 2: Add file to iTunes library
            logger.info(f"Step 2: Adding file to iTunes library")
            self.status_updater.update_progress(
                upload_id=message.upload_id,
                user_id=message.user_id,
                stage="importing",
                progress_percent=40,
                details="Adding to iTunes library"
            )
            
            track_info = self.itunes_controller.add_file_to_library(local_file_path)
            if not track_info:
                raise iTunesError("Failed to add file to iTunes library")
            
            # Step 3: Respect embedded metadata by default (do not overwrite)
            apply_metadata = (os.getenv("APPLY_METADATA", "false").lower() == "true")
            if apply_metadata:
                logger.info("Step 3: Updating track metadata (APPLY_METADATA=true)")
                self.status_updater.update_progress(
                    upload_id=message.upload_id,
                    user_id=message.user_id,
                    stage="metadata",
                    progress_percent=60,
                    details="Updating track metadata"
                )
                if not self.itunes_controller.update_track_metadata(track_info, message.metadata):
                    logger.warning("Failed to update track metadata, but continuing...")
            else:
                logger.debug("Skipping metadata update; using embedded tags (APPLY_METADATA=false)")
            
            # Step 4: Artwork (optional via APPLY_ARTWORK=true). Default: keep embedded artwork only
            apply_artwork = (os.getenv("APPLY_ARTWORK", "false").lower() == "true")
            artwork_s3_key = self._get_artwork_s3_key(message.s3_key) if apply_artwork else None
            if apply_artwork and artwork_s3_key:
                logger.info("Step 4: Setting album artwork (APPLY_ARTWORK=true)")
                self.status_updater.update_progress(
                    upload_id=message.upload_id,
                    user_id=message.user_id,
                    stage="artwork",
                    progress_percent=70,
                    details="Setting album artwork"
                )
                artwork_file_path = os.path.join(self.config.temp_directory, f"{message.upload_id}_artwork.jpg")
                if self.s3_handler.download_file(artwork_s3_key, artwork_file_path):
                    if not self.itunes_controller.set_album_artwork(track_info, artwork_file_path):
                        logger.warning("Failed to set album artwork, but continuing...")
            elif not apply_artwork:
                logger.debug("Skipping artwork update (APPLY_ARTWORK=false)")
            
            # Step 5: Trigger iCloud sync
            logger.info(f"Step 5: Triggering iCloud sync")
            self.status_updater.update_progress(
                upload_id=message.upload_id,
                user_id=message.user_id,
                stage="syncing",
                progress_percent=85,
                details="Syncing to iCloud Music Library"
            )
            
            if not self.itunes_controller.sync_to_icloud():
                logger.warning("Failed to trigger iCloud sync, but continuing...")
            
            # Step 6: Mark as completed
            processing_duration = int(time.time() - start_time)
            self.status_updater.mark_processing_complete(
                upload_id=message.upload_id,
                user_id=message.user_id,
                itunes_track_id=str(track_info.get('track_id')),
                processing_duration=processing_duration
            )
            
            # Step 7: Delete SQS message
            self.queue_processor.delete_message(message)
            
            logger.info(f"Successfully processed upload {message.upload_id} in {processing_duration} seconds")
            
        except Exception as e:
            # Update status to failed
            self.status_updater.update_status(
                upload_id=message.upload_id,
                user_id=message.user_id,
                status=ProcessingStatus.FAILED,
                message=f"Processing failed: {str(e)}"
            )
            
            # Add detailed error information
            self.status_updater.add_error_details(
                upload_id=message.upload_id,
                user_id=message.user_id,
                error_type=type(e).__name__,
                error_message=str(e),
                error_details={'traceback': traceback.format_exc()}
            )
            
            logger.error(f"Failed to process upload {message.upload_id}: {e}")
            raise
        
        finally:
            # Clean up local files
            if local_file_path:
                self.s3_handler.cleanup_local_file(local_file_path)
            if artwork_file_path:
                self.s3_handler.cleanup_local_file(artwork_file_path)
    
    def _get_artwork_s3_key(self, music_s3_key: str) -> Optional[str]:
        """
        Generate artwork S3 key from music file S3 key
        
        Args:
            music_s3_key: S3 key for music file
            
        Returns:
            str: Artwork S3 key if it might exist, None otherwise
        """
        try:
            # Convert music file key to artwork key
            # e.g., 'users/user123/upload456/song.mp3' -> 'users/user123/upload456/artwork.jpg'
            path_parts = music_s3_key.split('/')
            if len(path_parts) >= 3:
                artwork_key = '/'.join(path_parts[:-1]) + '/artwork.jpg'
                
                # Check if artwork exists
                if self.s3_handler.get_file_metadata(artwork_key):
                    return artwork_key
            
            return None
            
        except Exception as e:
            logger.debug(f"Error checking for artwork: {e}")
            return None
    
    def _cleanup(self) -> None:
        """Clean up resources before shutdown"""
        logger.info("Cleaning up resources...")
        
        try:
            if hasattr(self, 'itunes_controller'):
                self.itunes_controller.cleanup()
        except Exception as e:
            logger.error(f"Error during iTunes cleanup: {e}")
        
        logger.info("Cleanup completed")

def main() -> int:
    """
    Main entry point for the music processor
    
    Returns:
        int: Exit code
    """
    try:
        # Create log directory if it doesn't exist
        import os
        os.makedirs(r'C:\iSync\logs', exist_ok=True)
        
        logger.info("=" * 50)
        logger.info("iSync Music Processor Starting")
        logger.info("=" * 50)
        
        # Create and run processor
        processor = MusicProcessor()
        return processor.run()
        
    except Exception as e:
        logger.error(f"Fatal error in main: {e}")
        logger.error(traceback.format_exc())
        return 1

if __name__ == "__main__":
    sys.exit(main())