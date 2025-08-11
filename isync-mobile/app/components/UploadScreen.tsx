import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, Alert, ActivityIndicator, ScrollView, Image, Modal, Platform, KeyboardAvoidingView } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
// Universal ID3 tagging using browser-id3-writer (works on all platforms)
let ID3Writer: any | null = null;
try {
  const mod = require('browser-id3-writer');
  ID3Writer = (mod && (mod.default || mod.ID3Writer || mod.Writer)) || (typeof mod === 'function' ? mod : null);
} catch {
  console.warn('browser-id3-writer not available, ID3 tagging disabled');
}
import { initiateUpload, MetadataPayload, getEc2Status, startEc2, stopEc2 } from '../lib/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

function formatBytes(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

// Universal ID3 tagging function that works on all platforms
async function tagAudioFile(
  fileUri: string, 
  metadata: { title?: string; artist?: string; album?: string; year?: string; track?: string }, 
  coverBase64?: string | null
): Promise<{ uri: string; blob?: Blob }> {
  if (!ID3Writer) {
    console.warn('ID3Writer not available, returning original file');
    if (Platform.OS === 'web') {
      const blob = await fetch(fileUri).then(r => r.blob());
      return { uri: fileUri, blob };
    }
    return { uri: fileUri };
  }

  try {
    let arrayBuffer: ArrayBuffer;
    
    if (Platform.OS === 'web') {
      // Web: fetch the file as ArrayBuffer
      const response = await fetch(fileUri);
      arrayBuffer = await response.arrayBuffer();
    } else {
      // Native: read file using Expo FileSystem
      const base64String = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const binaryString = atob(base64String);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      arrayBuffer = bytes.buffer;
    }

    // Create ID3 writer with the audio data
    const writer = new ID3Writer(new Uint8Array(arrayBuffer));
    
    // Add metadata tags
    if (metadata.title) writer.setFrame('TIT2', metadata.title);
    if (metadata.artist) writer.setFrame('TPE1', [metadata.artist]);
    if (metadata.album) writer.setFrame('TALB', metadata.album);
    if (metadata.year) writer.setFrame('TYER', metadata.year);
    if (metadata.track) writer.setFrame('TRCK', metadata.track);
    
    // Add cover art if provided
    if (coverBase64) {
      const binaryString = atob(coverBase64);
      const coverBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        coverBytes[i] = binaryString.charCodeAt(i);
      }
      writer.setFrame('APIC', {
        type: 3, // Front cover
        data: coverBytes,
        description: 'Cover'
      });
    }
    
    // Write the tags
    writer.addTag();
    
    if (Platform.OS === 'web') {
      // Web: return as Blob
      const taggedBlob = writer.getBlob ? writer.getBlob() : new Blob([writer.arrayBuffer], { type: 'audio/mpeg' });
      return { uri: fileUri, blob: taggedBlob };
    } else {
      // Native: write to a new file
      const taggedArray = new Uint8Array(writer.arrayBuffer);
      let binaryString = '';
      for (let i = 0; i < taggedArray.length; i++) {
        binaryString += String.fromCharCode(taggedArray[i]);
      }
      const taggedBase64 = btoa(binaryString);
      
      const taggedPath = (FileSystem.documentDirectory || '') + 'tagged_audio.mp3';
      await FileSystem.writeAsStringAsync(taggedPath, taggedBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      
      return { uri: taggedPath };
    }
  } catch (error) {
    console.warn('ID3 tagging failed, returning original file:', error);
    if (Platform.OS === 'web') {
      const blob = await fetch(fileUri).then(r => r.blob());
      return { uri: fileUri, blob };
    }
    return { uri: fileUri };
  }
}

export default function UploadScreen() {
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null); // name sent to backend
  const [selectedName, setSelectedName] = useState<string | null>(null); // original display name
  const [fileSize, setFileSize] = useState<number | null>(null);

  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [year, setYear] = useState('');
  const [track, setTrack] = useState('');

  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [coverJpegBase64, setCoverJpegBase64] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [statusText, setStatusText] = useState<string>('');
  const [vmRunning, setVmRunning] = useState<boolean | null>(null);

  const STORAGE_KEY = 'isync:lastMeta';
  const saveTimerRef = useRef<any>(null);

  const headerFileLabel = useMemo(() => {
    if (!selectedName) return 'Choose File';
    const max = 7;
    return selectedName.length > max ? `${selectedName.slice(0, max)}...` : selectedName;
  }, [selectedName]);

  const canUpload = useMemo(() => !!fileUri && !!fileName && !!fileSize, [fileUri, fileName, fileSize]);

  // Refs for inputs to support focusing next
  const artistRef = useRef<TextInput | null>(null);
  const albumRef = useRef<TextInput | null>(null);
  const yearRef = useRef<TextInput | null>(null);
  const trackRef = useRef<TextInput | null>(null);

  // Load last used metadata on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const last = JSON.parse(raw);
          setTitle(last.title || '');
          setArtist(last.artist || '');
          setAlbum(last.album || '');
          setYear(last.year || '');
          setTrack(last.track || '');
        }
      } catch {}
    })();
  }, []);

  // Debounced save of metadata
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ title, artist, album, year, track })
      ).catch(() => {});
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [title, artist, album, year, track]);

  const refreshVmStatus = useCallback(async () => {
    try {
      const s = await getEc2Status();
      const running = (s.runningInstances ?? 0) > 0 || s.state === 'running';
      setVmRunning(running);
    } catch {
      setVmRunning(null);
    }
  }, []);

  useEffect(() => {
    refreshVmStatus();
  }, [refreshVmStatus]);

  const pickFile = useCallback(async () => {
    setMessage(null);
    const result = await DocumentPicker.getDocumentAsync({ type: 'audio/mpeg', multiple: false, copyToCacheDirectory: false });
    if (result.canceled) return;
    const asset = result.assets?.[0];
    if (!asset) return;
    try {
      const uri = asset.uri;
      let displayName: string | null = (asset as any).name ?? null;
      if (!displayName) {
        const lastSlash = uri.lastIndexOf('/');
        displayName = lastSlash >= 0 ? uri.slice(lastSlash + 1) : 'working.mp3';
      }
      setSelectedName(displayName);
      setFileName(displayName);

      if (Platform.OS === 'web') {
        const blob = await fetch(uri).then(r => r.blob());
        setFileUri(uri);
        setFileSize(blob.size);
        setMessage(`Selected ${formatBytes(blob.size)}`);
        console.log('[pickFile:web]', { uri, displayName, size: blob.size });
      } else {
        const workPath = FileSystem.documentDirectory! + 'working.mp3';
        try { await FileSystem.deleteAsync(workPath, { idempotent: true }); } catch {}
        await FileSystem.copyAsync({ from: uri, to: workPath });
        const info = await FileSystem.getInfoAsync(workPath, { size: true });
        setFileUri(workPath);
        setFileSize((info as any).size ?? (asset as any).size ?? 0);
        setMessage(`Selected ${formatBytes(((info as any).size ?? (asset as any).size ?? 0))}`);
        console.log('[pickFile:native]', { uri, displayName, size: (info as any).size });
      }
    } catch (e: any) {
      console.warn('pickFile failed', e);
      Alert.alert('Error', e?.message || 'Failed to prepare file');
    }
  }, []);

  const pickCover = useCallback(async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, quality: 1 });
    if (res.canceled) return;
    const img = res.assets?.[0];
    if (!img) return;
    const manip = await ImageManipulator.manipulateAsync(img.uri, [{ resize: { width: 1000 } }], { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    setCoverUri(manip.uri);
    setCoverJpegBase64(manip.base64 ?? null);
  }, []);

  const openStatus = useCallback(async () => {
    setShowInfo(true);
    setStatusText('Loading status...');
    try {
      const res = await getEc2Status();
      const lines: string[] = [];
      if (res.state) lines.push(`State: ${res.state}`);
      if (typeof res.desiredCapacity === 'number') lines.push(`Desired Capacity: ${res.desiredCapacity}`);
      if (typeof res.runningInstances === 'number') lines.push(`Running Instances: ${res.runningInstances}`);
      if (typeof res.queueDepth === 'number') lines.push(`Queue Depth: ${res.queueDepth}`);
      if (res.message) lines.push(res.message);
      setStatusText(lines.length ? lines.join('\n') : 'Status unavailable');
      const running = (res.runningInstances ?? 0) > 0 || res.state === 'running';
      setVmRunning(running);
    } catch (e: any) {
      setStatusText(e?.message || 'Status unavailable');
    }
  }, []);

  async function waitForVmRunning(timeoutMs = 120000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const s = await getEc2Status();
        if ((s.runningInstances ?? 0) > 0 || s.state === 'running' || (s.desiredCapacity ?? 0) > 0) {
          return true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 3000));
    }
    return false;
  }

  const doUpload = useCallback(async () => {
    if (!canUpload || !fileUri || !fileName || !fileSize) return;
    setLoading(true);
    setMessage('Starting VM...');
    try {
      await startEc2();
      const started = await waitForVmRunning(120000);
      if (!started) throw new Error('VM did not start in time');
      setMessage('VM running. Preparing upload...');

      const metadata: MetadataPayload = {
        title: title || undefined,
        artist: artist || undefined,
        album: album || undefined,
        year: year ? Number(year) : undefined,
        trackNumber: track ? Number(track) : undefined,
      };

      const presign = await initiateUpload({
        fileName,
        fileSize,
        contentType: 'audio/mpeg',
        userId: 'quincy',
        metadata,
      });

      setMessage('Tagging file...');
      
      // Use unified tagging function for all platforms
      const taggedFile = await tagAudioFile(
        fileUri,
        { title, artist, album, year, track },
        coverJpegBase64
      );

      setMessage('Uploading file...');
      const headers = { 'Content-Type': 'audio/mpeg', ...presign.requiredHeaders } as Record<string, string>;
      
      if (Platform.OS === 'web') {
        // Web: upload the tagged blob
        const blob = taggedFile.blob || await fetch(taggedFile.uri).then(r => r.blob());
        const resp = await fetch(presign.presignedUrl, { method: 'PUT', headers, body: blob });
        if (!resp.ok) throw new Error(`PUT failed with status ${resp.status}`);
      } else {
        // Native: upload the tagged file
        const putRes = await FileSystem.uploadAsync(presign.presignedUrl, taggedFile.uri, {
          httpMethod: 'PUT', headers, uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        });
        if (putRes.status < 200 || putRes.status >= 300) throw new Error(`PUT failed with status ${putRes.status}`);
      }

      setMessage(`Uploaded! ID: ${presign.uploadId}`);

      setTimeout(() => {
        setFileUri(null); setFileName(null); setSelectedName(null); setFileSize(null);
        setTitle(''); setArtist(''); setAlbum(''); setYear(''); setTrack('');
        setCoverUri(null); setCoverJpegBase64(null); setMessage(null); setLoading(false);
      }, 1200);
    } catch (e: any) {
      setLoading(false);
      Alert.alert('Upload failed', e?.message || String(e));
    }
  }, [canUpload, fileUri, fileName, fileSize, title, artist, album, year, track]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: '#111' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{ padding: 24, paddingBottom: 40 }}
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
            <TouchableOpacity
              onPress={async () => {
                setShowInfo(true);
                setStatusText('Toggling power...');
                try {
                  const status = await getEc2Status();
                  if ((status.runningInstances ?? 0) > 0 || status.desiredCapacity === 1) {
                    await stopEc2();
                    setStatusText('Stop requested. VM will shut down shortly.');
                    setVmRunning(false);
                  } else {
                    await startEc2();
                    setStatusText('Start requested. VM will launch shortly.');
                    setVmRunning(true);
                  }
                } catch (e: any) {
                  setStatusText(e?.message || 'Failed to toggle power');
                }
              }}
              accessibilityLabel="Power"
              style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#222', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#444' }}>
              <Ionicons name="power" size={18} color={vmRunning ? '#34C759' : '#FA233B'} />
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: 'white', fontSize: 28, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>Upload File:</Text>
              <TouchableOpacity onPress={pickFile} style={{ marginLeft: 8 }}>
                <Text style={{ color: '#4ea3ff', fontSize: 18, fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>{headerFileLabel}</Text>
              </TouchableOpacity>
            </View>
          </View>
          <TouchableOpacity onPress={openStatus} accessibilityLabel="Info" style={{ width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: '#4ea3ff', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#4ea3ff', fontSize: 18, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>i</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={pickCover} activeOpacity={0.8} style={{
          width: '100%',
          aspectRatio: 1,
          borderRadius: 16,
          backgroundColor: '#3a3a3a',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 16,
        }}>
          {coverUri ? (
            <Image source={{ uri: coverUri }} style={{ width: '100%', height: '100%', borderRadius: 16 }} resizeMode="cover" />
          ) : (
            <Text style={{ color: '#ddd', fontSize: 80, fontWeight: '300', fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>+</Text>
          )}
        </TouchableOpacity>

        {selectedName && (
          <Text style={{ color: '#bbb', marginBottom: 8, fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>
            {fileSize ? `${formatBytes(fileSize)}` : ''}
          </Text>
        )}

        {message && <Text style={{ color: '#8bd48b', marginBottom: 12, fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>{message}</Text>}

        {[{ label: 'Title', value: title, setter: setTitle, ref: undefined },
          { label: 'Artist', value: artist, setter: setArtist, ref: artistRef },
          { label: 'Album', value: album, setter: setAlbum, ref: albumRef },
          { label: 'Year', value: year, setter: setYear, ref: yearRef },
          { label: 'Track #', value: track, setter: setTrack, ref: trackRef },
        ].map((row, index, arr) => (
          <View key={row.label} style={{ borderBottomWidth: 1, borderBottomColor: '#2a2a2a', marginBottom: 8 }}>
            <Text style={{ color: '#bbb', marginBottom: 4, fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>{row.label}</Text>
            <TextInput
              ref={row.ref as any}
              value={row.value}
              onChangeText={row.setter as any}
              placeholder={row.label}
              placeholderTextColor={'#666'}
              keyboardType={row.label === 'Year' || row.label === 'Track #' ? 'number-pad' : 'default'}
              returnKeyType={index < arr.length - 1 ? 'next' : 'done'}
              blurOnSubmit={index === arr.length - 1}
              onSubmitEditing={() => {
                const next = arr[index + 1]?.ref?.current as TextInput | undefined;
                if (next) next.focus();
              }}
              style={{ color: 'white', paddingVertical: 8, fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}
            />
          </View>
        ))}

        <TouchableOpacity
          disabled={!canUpload || loading}
          onPress={doUpload}
          style={{
            backgroundColor: canUpload ? '#FA233B' : '#5a2a2a',
            borderRadius: 24,
            paddingVertical: 16,
            alignItems: 'center',
            marginTop: 16,
            marginBottom: 24,
          }}
        >
          {loading ? (
            <ActivityIndicator color={'white'} />
          ) : (
            <Text style={{ color: 'white', fontSize: 16, fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>Upload to Library</Text>
          )}
        </TouchableOpacity>

        {/* Spacer to ensure last input is comfortably above keyboard */}
        <View style={{ height: 20 }} />

        <Modal visible={showInfo} transparent animationType="fade" onRequestClose={() => setShowInfo(false)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <View style={{ backgroundColor: '#1a1a1a', borderRadius: 16, padding: 16, width: '100%' }}>
              <Text style={{ color: 'white', fontSize: 18, marginBottom: 8, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>System Status</Text>
              <Text style={{ color: '#ccc', marginBottom: 16, fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>{statusText}</Text>
              <TouchableOpacity onPress={() => setShowInfo(false)} style={{ alignSelf: 'flex-end', paddingVertical: 10, paddingHorizontal: 16, backgroundColor: '#333', borderRadius: 12 }}>
                <Text style={{ color: 'white', fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}


