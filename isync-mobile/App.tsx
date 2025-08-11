import React from 'react';
import { SafeAreaView, StatusBar, Platform } from 'react-native';
import UploadScreen from './app/components/UploadScreen';

export default function App() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#111' }}>
      <StatusBar barStyle={'light-content'} />
      <UploadScreen />
    </SafeAreaView>
  );
}
