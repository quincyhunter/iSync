"""
iTunes Controller Tests (Mock)
Tests iTunes COM interface functionality without requiring actual iTunes installation
"""

import os
import sys
import unittest
from unittest.mock import Mock, patch, MagicMock
import tempfile

# Add src to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

class TestiTunesController(unittest.TestCase):
    """Test iTunes controller with mocked COM interface"""
    
    def setUp(self):
        # Mock Windows COM modules
        self.mock_pythoncom = Mock()
        self.mock_win32com = Mock()
        
        # Set up mock COM objects
        self.mock_itunes = Mock()
        self.mock_library = Mock()
        self.mock_track = Mock()
        
        # Configure mock iTunes application
        self.mock_itunes.Version = "12.12.5.7"
        self.mock_itunes.PlayerState = 1
        self.mock_itunes.LibraryPlaylist = self.mock_library
        self.mock_itunes.BrowserWindow = Mock()
        self.mock_itunes.BrowserWindow.Visible = False
        
        # Configure mock library
        self.mock_library.Tracks = Mock()
        self.mock_library.Tracks.Count = 1000
        self.mock_library.AddFile = Mock()
        
        # Configure mock track
        self.mock_track.Name = "Test Song"
        self.mock_track.Artist = "Test Artist"
        self.mock_track.Album = "Test Album"
        self.mock_track.Genre = "Test Genre"
        self.mock_track.TrackID = 12345
        self.mock_track.TrackDatabaseID = 67890
        self.mock_track.Duration = 180
        self.mock_track.Location = r"C:\Music\Test Song.mp3"
        self.mock_track.Year = 2024
        self.mock_track.TrackNumber = 1
        
        # Configure mock operation status
        self.mock_operation = Mock()
        self.mock_operation.InProgress = False
        self.mock_operation.Tracks = Mock()
        self.mock_operation.Tracks.Count = 1
        self.mock_operation.Tracks.Item = Mock(return_value=self.mock_track)
        
        self.mock_library.AddFile.return_value = self.mock_operation
        
        # Configure mock COM dispatch
        self.mock_win32com.client.Dispatch.return_value = self.mock_itunes
    
    @patch('itunes_controller.win32com', create=True)
    @patch('itunes_controller.pythoncom', create=True)
    def test_itunes_initialization(self, mock_pythoncom, mock_win32com):
        """Test iTunes controller initialization"""
        mock_win32com.client.Dispatch.return_value = self.mock_itunes
        
        from itunes_controller import iTunesController
        
        controller = iTunesController()
        result = controller.initialize()
        
        self.assertTrue(result)
        mock_pythoncom.CoInitialize.assert_called_once()
        mock_win32com.client.Dispatch.assert_called_once_with("iTunes.Application")
        self.assertEqual(controller.itunes, self.mock_itunes)
        self.assertEqual(controller.library, self.mock_library)
    
    @patch('itunes_controller.win32com', create=True)
    @patch('itunes_controller.pythoncom', create=True)
    @patch('itunes_controller.os.path.exists')
    def test_add_file_to_library(self, mock_exists, mock_pythoncom, mock_win32com):
        """Test adding file to iTunes library"""
        mock_exists.return_value = True
        mock_win32com.client.Dispatch.return_value = self.mock_itunes
        
        from itunes_controller import iTunesController
        
        controller = iTunesController()
        controller.initialize()
        
        # Test file addition
        test_file_path = r"C:\Test\song.mp3"
        result = controller.add_file_to_library(test_file_path)
        
        self.assertIsNotNone(result)
        self.assertEqual(result['name'], "Test Song")
        self.assertEqual(result['artist'], "Test Artist")
        self.assertEqual(result['track_id'], 12345)
        self.assertEqual(result['database_id'], 67890)
        
        self.mock_library.AddFile.assert_called_once_with(test_file_path)
    
    @patch('itunes_controller.win32com', create=True)
    @patch('itunes_controller.pythoncom', create=True)
    def test_update_track_metadata(self, mock_pythoncom, mock_win32com):
        """Test updating track metadata"""
        mock_win32com.client.Dispatch.return_value = self.mock_itunes
        
        # Configure library search
        self.mock_library.Tracks.Item = Mock(return_value=self.mock_track)
        
        from itunes_controller import iTunesController
        
        controller = iTunesController()
        controller.initialize()
        
        # Test metadata update
        track_info = {'database_id': 67890}
        metadata = {
            'title': 'Updated Song',
            'artist': 'Updated Artist',
            'album': 'Updated Album',
            'genre': 'Updated Genre',
            'year': 2025,
            'track_number': 2
        }
        
        result = controller.update_track_metadata(track_info, metadata)
        
        self.assertTrue(result)
        self.assertEqual(self.mock_track.Name, 'Updated Song')
        self.assertEqual(self.mock_track.Artist, 'Updated Artist')
        self.assertEqual(self.mock_track.Album, 'Updated Album')
        self.assertEqual(self.mock_track.Genre, 'Updated Genre')
        self.assertEqual(self.mock_track.Year, 2025)
        self.assertEqual(self.mock_track.TrackNumber, 2)
    
    @patch('itunes_controller.win32com', create=True)
    @patch('itunes_controller.pythoncom', create=True)
    @patch('itunes_controller.os.path.exists')
    def test_set_album_artwork(self, mock_exists, mock_pythoncom, mock_win32com):
        """Test setting album artwork"""
        mock_exists.return_value = True
        mock_win32com.client.Dispatch.return_value = self.mock_itunes
        
        # Configure library search and track artwork
        self.mock_library.Tracks.Item = Mock(return_value=self.mock_track)
        self.mock_track.AddArtworkFromFile = Mock()
        
        from itunes_controller import iTunesController
        
        controller = iTunesController()
        controller.initialize()
        
        # Test artwork setting
        track_info = {'database_id': 67890}
        artwork_path = r"C:\Test\artwork.jpg"
        
        result = controller.set_album_artwork(track_info, artwork_path)
        
        self.assertTrue(result)
        self.mock_track.AddArtworkFromFile.assert_called_once_with(artwork_path)
    
    @patch('itunes_controller.win32com', create=True)
    @patch('itunes_controller.pythoncom', create=True)
    def test_sync_to_icloud(self, mock_pythoncom, mock_win32com):
        """Test iCloud sync trigger"""
        mock_win32com.client.Dispatch.return_value = self.mock_itunes
        self.mock_itunes.UpdateIPod = Mock()
        
        from itunes_controller import iTunesController
        
        controller = iTunesController()
        controller.initialize()
        
        result = controller.sync_to_icloud()
        
        self.assertTrue(result)
        self.mock_itunes.UpdateIPod.assert_called_once()
    
    @patch('itunes_controller.win32com', create=True)
    @patch('itunes_controller.pythoncom', create=True)
    def test_get_library_stats(self, mock_pythoncom, mock_win32com):
        """Test getting library statistics"""
        mock_win32com.client.Dispatch.return_value = self.mock_itunes
        
        from itunes_controller import iTunesController
        
        controller = iTunesController()
        controller.initialize()
        
        stats = controller.get_library_stats()
        
        self.assertIsInstance(stats, dict)
        self.assertEqual(stats['total_tracks'], 1000)
        self.assertEqual(stats['itunes_version'], "12.12.5.7")
        self.assertEqual(stats['player_state'], 1)
    
    @patch('itunes_controller.win32com', create=True)
    @patch('itunes_controller.pythoncom', create=True)
    def test_cleanup(self, mock_pythoncom, mock_win32com):
        """Test cleanup of iTunes controller"""
        mock_win32com.client.Dispatch.return_value = self.mock_itunes
        
        from itunes_controller import iTunesController
        
        controller = iTunesController()
        controller.initialize()
        
        self.assertTrue(controller.is_initialized)
        
        controller.cleanup()
        
        self.assertFalse(controller.is_initialized)
        mock_pythoncom.CoUninitialize.assert_called_once()
    
    @patch('itunes_controller.win32com', create=True)
    @patch('itunes_controller.pythoncom', create=True)
    def test_context_manager(self, mock_pythoncom, mock_win32com):
        """Test iTunes controller as context manager"""
        mock_win32com.client.Dispatch.return_value = self.mock_itunes
        
        from itunes_controller import iTunesController
        
        with iTunesController() as controller:
            self.assertTrue(controller.is_initialized)
        
        # Should be cleaned up after context
        self.assertFalse(controller.is_initialized)

if __name__ == '__main__':
    print("=" * 60)
    print("iTunes Controller Tests (Mocked)")
    print("=" * 60)
    print("Note: These tests use mocked COM interfaces.")
    print("For real iTunes testing, run on Windows with iTunes installed.")
    print()
    
    unittest.main(verbosity=2)