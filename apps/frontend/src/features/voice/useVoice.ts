import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { realtime } from '@/lib/realtime';
import { useAppStore } from '@/lib/store';
import { readPreferences, type AudioPreferences } from '../audio/devices';
import { MeshVoice, type VoiceSnapshot } from './mesh';

export function useVoice(sessionId: string) {
  const [voice, setVoice] = useState<VoiceSnapshot>({
    status: 'off',
    muted: false,
    error: '',
    peers: {},
    playbackBlocked: false,
  });
  const service = useRef<MeshVoice | null>(null);
  useEffect(() => {
    const mesh = new MeshVoice(sessionId, realtime, setVoice);
    service.current = mesh;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.connection !== 'online' ||
        state.room?.server_id !== previous.room?.server_id
      )
        mesh.leave();
      mesh.sync(state.room?.participants ?? []);
    });
    mesh.sync(useAppStore.getState().room?.participants ?? []);
    const unsubscribeSignal = realtime.onSignal((from, signal) =>
      mesh.receive(from, signal),
    );
    const unload = () => mesh.leave();
    window.addEventListener('pagehide', unload);
    return () => {
      unsubscribe();
      unsubscribeSignal();
      window.removeEventListener('pagehide', unload);
      mesh.leave();
      service.current = null;
    };
  }, [sessionId]);
  const changeDevices = useCallback((preferences: AudioPreferences) => {
    if (service.current) {
      service.current.leave();
      void service.current.setOutput(preferences.outputId);
    }
  }, []);
  return {
    ...voice,
    join: () => {
      const preferences = readPreferences();
      return service.current?.join(
        preferences.inputId,
        preferences.outputId,
        api.rtcConfig,
      );
    },
    leave: () => service.current?.leave(),
    toggleMute: () => service.current?.mute(!voice.muted),
    resumePlayback: () => service.current?.resumePlayback(),
    changeDevices,
  };
}
