import { describe, expect, it } from 'vitest';
import { isBridgePermissionMode } from './types.js';

describe('isBridgePermissionMode', () => {
  it.each(['interactive', 'assisted', 'autopilot'])('accepts internal preference %s', value => {
    expect(isBridgePermissionMode(value)).toBe(true);
  });

  it.each([
    'manual', 'yolo', 'allow-all', 'ASSISTED', ' assisted ', '',
    undefined, null, true, false, 0, 1, [], {}, ['assisted'],
  ])('rejects non-preference value %j', value => {
    expect(isBridgePermissionMode(value)).toBe(false);
  });
});
