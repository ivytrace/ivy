import { badRequest } from './http-error.js';

export interface Cursor {
  ts: number;
  spanId: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.ts, cursor.spanId])).toString('base64url');
}

export function decodeCursor(value: string): Cursor {
  try {
    const [ts, spanId] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof ts === 'number' && typeof spanId === 'string') return { ts, spanId };
  } catch {
    // fall through
  }
  throw badRequest('Invalid cursor');
}
