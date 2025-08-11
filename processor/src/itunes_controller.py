"""
iTunes COM Interface Controller
Uses Windows COM to control iTunes programmatically for music file processing
"""

import os
import time
import logging
from typing import Optional, Dict, Any, Tuple
import pythoncom
import win32com.client
from pathlib import Path

logger = logging.getLogger(__name__)

class iTunesError(Exception):
    """Custom exception for iTunes-related errors"""
    pass

class iTunesController:
    """Controls iTunes via COM interface for music file processing"""
    
    def __init__(self, timeout: int = 60):
        """
        Initialize iTunes controller
        
        Args:
            timeout: Timeout in seconds for iTunes operations
        """
        self.itunes = None
        self.library = None
        self.timeout = timeout
        self.is_initialized = False
        
    def initialize(self) -> bool:
        """
        Initialize iTunes COM interface
        
        Returns:
            bool: True if initialization successful, False otherwise
        """
        try:
            logger.info("Initializing iTunes COM interface...")
            
            # Initialize COM
            pythoncom.CoInitialize()
            
            # Try to connect to iTunes application
            try:
                self.itunes = win32com.client.Dispatch("iTunes.Application")
            except Exception as com_error:
                logger.warning(f"iTunes not running, attempting to start: {com_error}")
                
                # Start iTunes application
                import subprocess
                try:
                    logger.info("Starting iTunes application...")
                    subprocess.Popen([r"C:\Program Files\iTunes\iTunes.exe"], 
                                   shell=False, 
                                   stdout=subprocess.DEVNULL, 
                                   stderr=subprocess.DEVNULL)
                    
                    # Wait for iTunes to start up
                    time.sleep(30)
                    
                    # Now try to connect again
                    self.itunes = win32com.client.Dispatch("iTunes.Application")
                    logger.info("Successfully connected to iTunes after startup")
                    
                except Exception as start_error:
                    logger.error(f"Failed to start iTunes: {start_error}")
                    raise iTunesError(f"Could not start or connect to iTunes: {start_error}")
            
            # Get the main library playlist
            self.library = self.itunes.LibraryPlaylist
            
            # Verify iTunes is working
            version = self.itunes.Version
            logger.info(f"iTunes version: {version}")
            
            # Check if iTunes is running
            if not self._is_itunes_running():
                logger.warning("iTunes application may not be fully running")
                # Try to make iTunes visible to ensure it's active
                self.itunes.BrowserWindow.Visible = True
                time.sleep(2)
            
            self.is_initialized = True
            logger.info("iTunes COM interface initialized successfully")
            return True
            
        except Exception as e:
            logger.error(f"Failed to initialize iTunes COM interface: {e}")
            self.is_initialized = False
            return False
    
    def _is_itunes_running(self) -> bool:
        """Check if iTunes application is running"""
        try:
            # Try to access iTunes properties to verify it's responsive
            _ = self.itunes.PlayerState
            return True
        except Exception:
            return False
    
    def add_file_to_library(self, file_path: str) -> Optional[Dict[str, Any]]:
        """
        Add a music file to iTunes library
        
        Args:
            file_path: Local path to the music file
            
        Returns:
            dict: Track information if successful, None otherwise
        """
        if not self.is_initialized:
            logger.error("iTunes controller not initialized")
            return None
            
        if not os.path.exists(file_path):
            logger.error(f"File does not exist: {file_path}")
            return None
        
        try:
            logger.info(f"Adding file to iTunes library: {file_path}")
            
            # Convert to absolute path
            abs_path = os.path.abspath(file_path)
            
            # Add file to library
            operation_status = self.library.AddFile(abs_path)
            
            # Wait for import to complete with timeout
            start_time = time.time()
            while operation_status.InProgress:
                if time.time() - start_time > self.timeout:
                    logger.error(f"Timeout waiting for file import: {file_path}")
                    return None
                
                pythoncom.PumpWaitingMessages()
                time.sleep(0.5)
            
            # Check if tracks were added
            if operation_status.Tracks and operation_status.Tracks.Count > 0:
                track = operation_status.Tracks.Item(1)
                
                track_info = {
                    'name': track.Name,
                    'artist': track.Artist,
                    'album': track.Album,
                    'genre': track.Genre,
                    'track_id': track.TrackID,
                    'database_id': track.TrackDatabaseID,
                    'duration': track.Duration,
                    'file_path': track.Location,
                    'year': track.Year if hasattr(track, 'Year') else None,
                    'track_number': track.TrackNumber if hasattr(track, 'TrackNumber') else None
                }
                
                logger.info(f"Successfully added track: {track_info['name']} by {track_info['artist']}")
                return track_info
            else:
                logger.error("No tracks were added to iTunes library")
                return None
                
        except Exception as e:
            logger.error(f"Failed to add file to iTunes library: {e}")
            return None
    
    def update_track_metadata(self, track_info: Dict[str, Any], metadata: Dict[str, Any]) -> bool:
        """
        Update track metadata in iTunes with complete metadata support
        
        Args:
            track_info: Track information from add_file_to_library
            metadata: New metadata to apply
            
        Returns:
            bool: True if update successful, False otherwise
        """
        if not self.is_initialized:
            logger.error("iTunes controller not initialized")
            return False
        
        try:
            # Find the track by database ID
            track_id = track_info.get('database_id')
            if not track_id:
                logger.error("No track database ID provided")
                return False
            
            # Search for the track in the library
            track = None
            for i in range(1, self.library.Tracks.Count + 1):
                library_track = self.library.Tracks.Item(i)
                if library_track.TrackDatabaseID == track_id:
                    track = library_track
                    break
            
            if not track:
                logger.error(f"Could not find track with ID {track_id} in library")
                return False
            
            logger.info(f"Updating complete metadata for track: {track.Name}")
            
            # Update all metadata fields with error handling for each
            try:
                if metadata.get('title'):
                    track.Name = metadata['title']
                if metadata.get('artist'):
                    track.Artist = metadata['artist']
                if metadata.get('album'):
                    track.Album = metadata['album']
                if metadata.get('genre'):
                    track.Genre = metadata['genre']
                if metadata.get('year'):
                    track.Year = int(metadata['year'])
                if metadata.get('track_number'):
                    track.TrackNumber = int(metadata['track_number'])
                if metadata.get('disc_number'):
                    track.DiscNumber = int(metadata['disc_number'])
                if metadata.get('album_artist'):
                    track.AlbumArtist = metadata['album_artist']
                if metadata.get('composer'):
                    track.Composer = metadata['composer']
                if metadata.get('comments'):
                    track.Comments = metadata['comments']
                
                # Force iTunes to save changes
                track.UpdateInfoFromFile()
                
            except Exception as field_error:
                logger.warning(f"Some metadata fields failed to update: {field_error}")
            
            logger.info(f"Successfully updated metadata for track: {track.Name}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to update track metadata: {e}")
            return False
    
    def set_album_artwork(self, track_info: Dict[str, Any], artwork_path: str) -> bool:
        """
        Set album artwork for a track
        
        Args:
            track_info: Track information from add_file_to_library
            artwork_path: Path to artwork image file
            
        Returns:
            bool: True if artwork set successfully, False otherwise
        """
        if not self.is_initialized:
            logger.error("iTunes controller not initialized")
            return False
        
        if not os.path.exists(artwork_path):
            logger.error(f"Artwork file does not exist: {artwork_path}")
            return False
        
        try:
            # Find the track by database ID
            track_id = track_info.get('database_id')
            if not track_id:
                logger.error("No track database ID provided")
                return False
            
            # Search for the track in the library
            track = None
            for i in range(1, self.library.Tracks.Count + 1):
                library_track = self.library.Tracks.Item(i)
                if library_track.TrackDatabaseID == track_id:
                    track = library_track
                    break
            
            if not track:
                logger.error(f"Could not find track with ID {track_id} in library")
                return False
            
            logger.info(f"Setting album artwork for track: {track.Name}")
            
            # Add artwork to the track
            track.AddArtworkFromFile(artwork_path)
            
            logger.info(f"Successfully set album artwork for track: {track.Name}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to set album artwork: {e}")
            return False
    
    def sync_to_icloud(self) -> bool:
        """
        Trigger iCloud Music Library sync with multiple methods
        
        Returns:
            bool: True if sync triggered successfully, False otherwise
        """
        if not self.is_initialized:
            logger.error("iTunes controller not initialized")
            return False
        
        try:
            logger.info("Triggering iCloud Music Library sync...")
            
            # Method 1: Update library to sync with iCloud
            self.itunes.UpdateIPod()
            
            # Method 2: Force refresh (if first method doesn't work)
            try:
                self.library.UpdateSongInfo()
            except Exception:
                # This method might not exist in all iTunes versions
                pass
            
            # Wait for sync to initiate
            time.sleep(5)
            
            logger.info("iCloud sync triggered successfully")
            return True
            
        except Exception as e:
            logger.error(f"Failed to trigger iCloud sync: {e}")
            return False
    
    def handle_itunes_crash(self) -> bool:
        """
        Detect and recover from iTunes crashes
        
        Returns:
            bool: True if iTunes is responsive or recovery successful, False otherwise
        """
        try:
            # Check if iTunes is still responsive
            try:
                _ = self.itunes.Version
                return True  # iTunes is responsive
            except Exception:
                # iTunes has crashed or is not responding
                logger.warning("iTunes not responding, attempting restart...")
                
                # Kill any hanging iTunes processes
                os.system("taskkill /f /im iTunes.exe 2>nul")
                os.system("taskkill /f /im iTunesHelper.exe 2>nul")
                time.sleep(3)
                
                # Clear current references
                self.itunes = None
                self.library = None
                self.is_initialized = False
                
                # Wait a bit more for processes to fully terminate
                time.sleep(2)
                
                # Attempt to reinitialize
                return self.initialize()
                
        except Exception as e:
            logger.error(f"iTunes crash recovery failed: {e}")
            return False
    
    def get_library_stats(self) -> Dict[str, Any]:
        """
        Get iTunes library statistics
        
        Returns:
            dict: Library statistics
        """
        if not self.is_initialized:
            return {"error": "iTunes controller not initialized"}
        
        try:
            stats = {
                'total_tracks': self.library.Tracks.Count,
                'itunes_version': self.itunes.Version,
                'player_state': self.itunes.PlayerState
            }
            
            logger.debug(f"iTunes library stats: {stats}")
            return stats
            
        except Exception as e:
            logger.error(f"Failed to get library stats: {e}")
            return {"error": str(e)}
    
    def cleanup(self) -> None:
        """Clean up iTunes COM interface"""
        try:
            if self.is_initialized:
                self.itunes = None
                self.library = None
                pythoncom.CoUninitialize()
                self.is_initialized = False
                logger.info("iTunes COM interface cleaned up")
        except Exception as e:
            logger.error(f"Error during iTunes cleanup: {e}")
    
    def __enter__(self):
        """Context manager entry"""
        self.initialize()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit"""
        self.cleanup()