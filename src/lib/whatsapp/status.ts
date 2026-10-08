// Message status words + colours for screens (browser-safe).
export type WaStatusWord = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';

export const WA_STATUS_LABEL: Record<WaStatusWord, string> = {
  queued: 'Sending…', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not sent', received: 'Received',
};

export const WA_STATUS_TONE: Record<WaStatusWord, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  queued: 'neutral', sent: 'info', delivered: 'good', read: 'good', failed: 'bad', received: 'info',
};
