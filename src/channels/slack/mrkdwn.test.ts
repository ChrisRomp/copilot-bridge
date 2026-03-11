import { describe, it, expect } from 'vitest';
import { markdownToMrkdwn } from './mrkdwn.js';

describe('markdownToMrkdwn', () => {
  it('converts **bold** to *bold*', () => {
    expect(markdownToMrkdwn('This is **bold** text')).toBe('This is *bold* text');
  });

  it('converts __bold__ to *bold*', () => {
    expect(markdownToMrkdwn('This is __bold__ text')).toBe('This is *bold* text');
  });

  it('leaves _italic_ untouched', () => {
    expect(markdownToMrkdwn('This is _italic_ text')).toBe('This is _italic_ text');
  });

  it('converts [text](url) to <url|text>', () => {
    expect(markdownToMrkdwn('See [docs](https://example.com)')).toBe('See <https://example.com|docs>');
  });

  it('converts images ![alt](url) to <url|alt>', () => {
    expect(markdownToMrkdwn('![logo](https://example.com/img.png)')).toBe('<https://example.com/img.png|logo>');
  });

  it('converts ~~strikethrough~~ to ~strikethrough~', () => {
    expect(markdownToMrkdwn('This is ~~deleted~~ text')).toBe('This is ~deleted~ text');
  });

  it('converts headers to bold', () => {
    expect(markdownToMrkdwn('## Section Title')).toBe('*Section Title*');
    expect(markdownToMrkdwn('### Subsection')).toBe('*Subsection*');
  });

  it('leaves inline code untouched', () => {
    expect(markdownToMrkdwn('Use `**not bold**` here')).toBe('Use `**not bold**` here');
  });

  it('leaves code blocks untouched', () => {
    const input = 'Before\n```\n**not bold**\n[not a link](url)\n```\nAfter **bold**';
    const result = markdownToMrkdwn(input);
    expect(result).toContain('```\n**not bold**\n[not a link](url)\n```');
    expect(result).toContain('After *bold*');
  });

  it('converts markdown tables to code blocks', () => {
    const input = '| Name | Value |\n| --- | --- |\n| foo | 42 |\n| bar | 99 |';
    const result = markdownToMrkdwn(input);
    expect(result).toContain('```\n');
    expect(result).toContain('Name');
    expect(result).toContain('foo');
    expect(result).toContain('bar');
    expect(result).toContain('```');
    // Should NOT contain pipe characters
    expect(result).not.toMatch(/\|/);
  });

  it('handles mixed content with tables', () => {
    const input = '## Models\n\n| Model | Status |\n|---|---|\n| opus | active |\n\nDone.';
    const result = markdownToMrkdwn(input);
    expect(result).toContain('*Models*');
    expect(result).toContain('```\n');
    expect(result).toContain('Done.');
  });

  it('passes through plain text unchanged', () => {
    expect(markdownToMrkdwn('Hello world')).toBe('Hello world');
  });

  it('handles multiple bold segments', () => {
    expect(markdownToMrkdwn('**a** and **b**')).toBe('*a* and *b*');
  });
});
