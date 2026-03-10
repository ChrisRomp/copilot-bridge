import { describe, it, expect } from 'vitest';
import type { CheckResult } from './output.js';

// output.ts functions write to console — we just verify the types and interfaces
describe('output', () => {
  it('CheckResult type accepts pass/warn/fail status', () => {
    const pass: CheckResult = { status: 'pass', label: 'test' };
    const warn: CheckResult = { status: 'warn', label: 'test', detail: 'something' };
    const fail: CheckResult = { status: 'fail', label: 'test' };

    expect(pass.status).toBe('pass');
    expect(warn.detail).toBe('something');
    expect(fail.status).toBe('fail');
  });
});
