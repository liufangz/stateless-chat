import { describe, it, expect } from 'vitest';
import { isServerSentErrorEvent } from '../src/lib/api';

describe('isServerSentErrorEvent', () => {
  it('recognizes a server-sent `event: error` message (a MessageEvent carrying a JSON string payload)', () => {
    const messageEvent = { data: '{"message":"turn failed"}' } as MessageEvent;
    expect(isServerSentErrorEvent(messageEvent)).toBe(true);
  });

  it('recognizes an empty-but-present data string as server-sent too (still a MessageEvent, just no payload)', () => {
    const messageEvent = { data: '' } as unknown as MessageEvent;
    expect(isServerSentErrorEvent(messageEvent)).toBe(true);
  });

  it('does NOT treat a native EventSource connection-failure event (no `data` property at all) as server-sent', () => {
    // A native `error` Event (network drop, server restart, etc.) is a
    // plain Event, not a MessageEvent - it has no `data` property.
    const nativeErrorEvent = new Event('error');
    expect(isServerSentErrorEvent(nativeErrorEvent)).toBe(false);
  });

  it('does not misclassify a MessageEvent-shaped object whose data is not a string', () => {
    const weird = { data: 12345 } as unknown as MessageEvent;
    expect(isServerSentErrorEvent(weird)).toBe(false);
  });
});
