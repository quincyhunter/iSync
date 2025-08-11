import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, Alert, ActivityIndicator, ScrollView, Image, Modal, Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
// Native FS module and Node-style Buffer for RN
let RNFS: any | null = null;
let NodeID3: any | null = null;

// Import react-native-fs
try { 
  RNFS = require('react-native-fs'); 
} catch {}

// Dynamically import node-id3 only at runtime, not during bundling
const loadNodeID3 = async () => {
  if (NodeID3 !== null) return NodeID3;
  
  try {
    // Use dynamic import to avoid Metro bundling issues
    NodeID3 = await import('node-id3').then(module => module.default || module);
    return NodeID3;
  } catch {
    console.warn('node-id3 not available, ID3 tagging disabled');
    return null;
  }
};
// Web-only ID3 tagging (supports both default and CommonJS exports)
let WebID3WriterCtor: any | null = null;
if (typeof window !== 'undefined') {
  try {
    const mod = require('browser-id3-writer');
    WebID3WriterCtor = (mod && (mod.default || mod.ID3Writer || mod.Writer)) || (typeof mod === 'function' ? mod : null);
  } catch {}
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
    const max = 10;
    return selectedName.length > max ? `${selectedName.slice(0, max)}...` : selectedName;
  }, [selectedName]);

  const canUpload = useMemo(() => !!fileUri && !!fileName && !!fileSize, [fileUri, fileName, fileSize]);

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

      setMessage('Uploading file...');
      const headers = { 'Content-Type': 'audio/mpeg', ...presign.requiredHeaders } as Record<string, string>;
      if (Platform.OS === 'web') {
        let blob = await fetch(fileUri).then(r => r.blob());
        // Attempt to tag on web using browser-id3-writer if available
        if (typeof WebID3WriterCtor === 'function') {
          try {
            const arrayBuffer = await blob.arrayBuffer();
            const writer = new WebID3WriterCtor(new Uint8Array(arrayBuffer));
            if (title) writer.setFrame('TIT2', title);
            if (artist) writer.setFrame('TPE1', [artist]);
            if (album) writer.setFrame('TALB', album);
            if (year) writer.setFrame('TYER', String(year));
            if (track) writer.setFrame('TRCK', String(track));
            if (coverJpegBase64) {
              const bin = atob(coverJpegBase64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              writer.setFrame('APIC', { type: 3, data: bytes, description: 'Cover' });
            }
            writer.addTag();
            const taggedBlob = writer.getBlob ? writer.getBlob() : new Blob([writer.arrayBuffer], { type: 'audio/mpeg' });
            if (taggedBlob) blob = taggedBlob;
          } catch (e) {
            console.warn('Web ID3 tagging failed, uploading original', e);
          }
        }
        const resp = await fetch(presign.presignedUrl, { method: 'PUT', headers, body: blob });
        if (!resp.ok) throw new Error(`PUT failed with status ${resp.status}`);
      } else {
        // Native: tag file on-device if RNFS and node-id3 are available
        let finalPath = fileUri;
        try {
          const nodeId3 = await loadNodeID3();
          if (RNFS && nodeId3) {
            // Read file bytes as base64
            const base64 = await RNFS.readFile(fileUri.replace('file://',''), 'base64');
            const buf = Buffer.from(base64, 'base64');
            const frames: any = {};
            if (title) frames.title = title;
            if (artist) frames.artist = artist;
            if (album) frames.album = album;
            if (year) frames.year = String(year);
            if (track) frames.trackNumber = String(track);
            if (coverJpegBase64) {
              frames.APIC = {
                mime: 'image/jpeg',
                type: { id: 3, name: 'front cover' },
                description: 'Cover',
                imageBuffer: Buffer.from(coverJpegBase64, 'base64'),
              };
            }
            const tagged = nodeId3.update(frames, buf);
            const outPath = (FileSystem.documentDirectory || '') + 'tagged.mp3';
            await FileSystem.writeAsStringAsync(outPath, Buffer.from(tagged).toString('base64'), { encoding: FileSystem.EncodingType.Base64 });
            finalPath = outPath;
          }
        } catch (e) {
          console.warn('Native ID3 tagging failed; uploading original', e);
        }
        const putRes = await FileSystem.uploadAsync(presign.presignedUrl, finalPath, {
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
    <ScrollView contentContainerStyle={{ padding: 24 }} style={{ flex: 1, backgroundColor: '#111' }}>
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

      {[{ label: 'Title', value: title, setter: setTitle },
        { label: 'Artist', value: artist, setter: setArtist },
        { label: 'Album', value: album, setter: setAlbum },
        { label: 'Year', value: year, setter: setYear },
        { label: 'Track #', value: track, setter: setTrack },
      ].map((row) => (
        <View key={row.label} style={{ borderBottomWidth: 1, borderBottomColor: '#2a2a2a', marginBottom: 8 }}>
          <Text style={{ color: '#bbb', marginBottom: 4, fontFamily: Platform.OS === 'ios' ? 'System' : undefined }}>{row.label}</Text>
          <TextInput
            value={row.value}
            onChangeText={row.setter}
            placeholder={row.label}
            placeholderTextColor={'#666'}
            keyboardType={row.label === 'Year' || row.label === 'Track #' ? 'number-pad' : 'default'}
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
  );
}


