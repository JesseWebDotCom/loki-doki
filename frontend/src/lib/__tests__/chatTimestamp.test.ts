import { describe, expect, it } from 'vitest';
import {
  createMessageTimestamp,
  formatMessageDateTime,
  formatMessageTime,
} from '../chatTimestamp';

describe('chatTimestamp', () => {
  it('creates ISO timestamps for new messages', () => {
    const ts = createMessageTimestamp(new Date('2026-04-12T17:45:00.000Z'));
    expect(ts).toBe('2026-04-12T17:45:00.000Z');
  });

  it('formats compact inline times for valid timestamps', () => {
    expect(formatMessageTime('2026-04-12T17:45:00.000Z')).toMatch(/\d{1,2}:\d{2}/);
  });

  it('formats full hover labels with both date and time', () => {
    const label = formatMessageDateTime('2026-04-12T17:45:00.000Z');
    expect(label).toContain('2026');
    expect(label).toMatch(/\d{1,2}:\d{2}/);
  });

  it('falls back to the original value for non-date legacy strings', () => {
    expect(formatMessageTime('3:14:15 PM')).toBe('3:14:15 PM');
    expect(formatMessageDateTime('3:14:15 PM')).toBe('3:14:15 PM');
  });
});
