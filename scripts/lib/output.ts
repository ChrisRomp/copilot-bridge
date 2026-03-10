/**
 * Colored terminal output helpers for init/check CLI commands.
 * No dependencies — uses ANSI escape codes directly.
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

export function success(msg: string): void {
  console.log(`${GREEN}✅${RESET} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${YELLOW}⚠️${RESET}  ${msg}`);
}

export function fail(msg: string): void {
  console.log(`${RED}❌${RESET} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${CYAN}ℹ️${RESET}  ${msg}`);
}

export function heading(msg: string): void {
  console.log(`\n${BOLD}${msg}${RESET}`);
}

export function dim(msg: string): void {
  console.log(`${DIM}${msg}${RESET}`);
}

export function blank(): void {
  console.log();
}

export interface CheckResult {
  status: 'pass' | 'warn' | 'fail';
  label: string;
  detail?: string;
}

export function printCheck(result: CheckResult): void {
  const fn = result.status === 'pass' ? success
    : result.status === 'warn' ? warn
    : fail;
  const detail = result.detail ? ` ${DIM}(${result.detail})${RESET}` : '';
  fn(`${result.label}${detail}`);
}

export function printSummary(results: CheckResult[]): void {
  const passes = results.filter(r => r.status === 'pass').length;
  const warns = results.filter(r => r.status === 'warn').length;
  const fails = results.filter(r => r.status === 'fail').length;

  blank();
  if (fails === 0 && warns === 0) {
    console.log(`${GREEN}${BOLD}All ${passes} checks passed!${RESET}`);
  } else if (fails === 0) {
    console.log(`${YELLOW}${BOLD}${passes} passed, ${warns} warning(s)${RESET}`);
  } else {
    console.log(`${RED}${BOLD}${passes} passed, ${warns} warning(s), ${fails} failed${RESET}`);
  }
}
