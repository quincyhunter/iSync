import React from 'react';
import { SafeAreaView, StatusBar, Platform } from 'react-native';
import UploadScreen from './components/UploadScreen';

export default function App() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar barStyle={Platform.OS === 'ios' ? 'dark-content' : 'light-content'} />
      <UploadScreen />
    </SafeAreaView>
  );
}


