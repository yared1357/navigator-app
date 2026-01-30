
export enum AppStatus {
  IDLE = 'IDLE',
  NEEDS_KEY = 'NEEDS_KEY',
  CONNECTING = 'CONNECTING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR',
  PRO_SCANNING = 'PRO_SCANNING',
  VIDEO_GENERATING = 'VIDEO_GENERATING'
}

export interface TranscriptionEntry {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}
