export const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh', 'dash', 'fish', 'env', 'sudo', 'nohup', 'xargs', 'exec', 'eval',
]);

export const ADMIN_SHELL_ALLOW: ReadonlySet<string> = new Set([
  'cp', 'mkdir', 'curl', 'launchctl', 'mv', 'touch', 'chmod',
]);
