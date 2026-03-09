/**
 * Readline-based interactive prompts. No external dependencies.
 */

import * as readline from 'node:readline';

let rl: readline.Interface | null = null;

function getRL(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

export function closePrompts(): void {
  rl?.close();
  rl = null;
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    getRL().question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

export async function askRequired(question: string): Promise<string> {
  let answer = '';
  while (!answer) {
    answer = await ask(question);
    if (!answer) console.log('  This field is required.');
  }
  return answer;
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(`${question} (${hint})`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

export async function choose(question: string, options: string[], defaultIndex = 0): Promise<number> {
  console.log(`\n${question}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? '>' : ' ';
    console.log(`  ${marker} ${i + 1}. ${options[i]}`);
  }
  const answer = await ask('Choose', String(defaultIndex + 1));
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) return idx;
  return defaultIndex;
}

export async function askSecret(question: string): Promise<string> {
  // For tokens — we don't mask input because readline doesn't support it
  // without raw mode, but we label it clearly
  return askRequired(question);
}
