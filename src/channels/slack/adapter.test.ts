import { describe, it, expect } from 'vitest';
import { chunkMessage } from './adapter.js';

describe('chunkMessage', () => {
  it('returns single chunk for short messages', () => {
    const result = chunkMessage('Hello world');
    expect(result).toEqual(['Hello world']);
  });

  it('returns single chunk for exactly max length', () => {
    const msg = 'x'.repeat(100);
    const result = chunkMessage(msg, 100);
    expect(result).toEqual([msg]);
  });

  it('splits on newline when possible', () => {
    const line1 = 'a'.repeat(50);
    const line2 = 'b'.repeat(50);
    const msg = `${line1}\n${line2}`;
    const result = chunkMessage(msg, 60);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  it('splits on space when no newline available', () => {
    const msg = 'word '.repeat(20).trim(); // 99 chars
    const result = chunkMessage(msg, 50);
    expect(result.length).toBeGreaterThan(1);
    // Each chunk should be within limit
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    // Joined content should match (accounting for split whitespace)
    expect(result.join(' ').replace(/\s+/g, ' ')).toBe(msg.replace(/\s+/g, ' '));
  });

  it('hard splits when no good break point', () => {
    const msg = 'x'.repeat(200);
    const result = chunkMessage(msg, 80);
    expect(result.length).toBe(3); // 80 + 80 + 40
    expect(result[0].length).toBe(80);
    expect(result[1].length).toBe(80);
    expect(result[2].length).toBe(40);
  });

  it('handles empty string', () => {
    const result = chunkMessage('');
    expect(result).toEqual(['']);
  });

  it('preserves content across chunks', () => {
    const msg = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join('\n');
    const result = chunkMessage(msg, 100);
    const rejoined = result.join('\n');
    // All original lines should be present
    for (let i = 0; i < 50; i++) {
      expect(rejoined).toContain(`Line ${i}`);
    }
  });

  it('uses default max length when not specified', () => {
    const msg = 'x'.repeat(3900);
    const result = chunkMessage(msg);
    expect(result).toHaveLength(1);

    const longMsg = 'x'.repeat(3901);
    const longResult = chunkMessage(longMsg);
    expect(longResult.length).toBeGreaterThan(1);
  });
});
