import { describe, it, expect } from 'vitest';
import { isHardDeny } from './config.js';

/** Helper: test a shell command against isHardDeny. */
function denied(command: string): boolean {
  const shellCmd = command.trim().split(/\s+/)[0];
  return isHardDeny('shell', command, shellCmd);
}

describe('isHardDeny', () => {
  // --- Non-shell requests are never hard-denied ---
  it('ignores non-shell kinds', () => {
    expect(isHardDeny('read', 'rm -rf /', 'rm')).toBe(false);
    expect(isHardDeny('write', 'mkfs /dev/sda', 'mkfs')).toBe(false);
    expect(isHardDeny('mcp', 'rm -rf /', undefined)).toBe(false);
  });

  // --- launchctl unload ---
  it('denies launchctl unload', () => {
    expect(denied('launchctl unload com.example.service')).toBe(true);
  });
  it('allows launchctl load', () => {
    expect(denied('launchctl load com.example.service')).toBe(false);
  });

  // --- rm -rf / ---
  describe('rm -rf', () => {
    it('denies rm -rf /', () => {
      expect(denied('rm -rf /')).toBe(true);
    });
    it('denies rm -rf /*', () => {
      expect(denied('rm -rf /*')).toBe(true);
    });
    it('denies rm -rf ~', () => {
      expect(denied('rm -rf ~')).toBe(true);
    });
    it('denies rm -rf ~/', () => {
      expect(denied('rm -rf ~/')).toBe(true);
    });
    it('denies rm -rf $HOME', () => {
      expect(denied('rm -rf $HOME')).toBe(true);
    });
    it('denies rm -fr /', () => {
      expect(denied('rm -fr /')).toBe(true);
    });
    it('denies split flags: rm -r -f /', () => {
      expect(denied('rm -r -f /')).toBe(true);
    });
    it('denies --recursive --force', () => {
      expect(denied('rm --recursive --force /')).toBe(true);
    });
    it('allows rm -rf on a normal path', () => {
      expect(denied('rm -rf ./build')).toBe(false);
    });
    it('allows rm (no -rf)', () => {
      expect(denied('rm file.txt')).toBe(false);
    });
    it('allows rm -r (no -f) on /', () => {
      expect(denied('rm -r /')).toBe(false);
    });
  });

  // --- mkfs ---
  describe('mkfs', () => {
    it('denies mkfs', () => {
      expect(denied('mkfs /dev/sda')).toBe(true);
    });
    it('denies mkfs.ext4', () => {
      expect(denied('mkfs.ext4 /dev/sda1')).toBe(true);
    });
  });

  // --- dd to block devices ---
  describe('dd', () => {
    it('denies dd to /dev/', () => {
      expect(denied('dd if=/dev/zero of=/dev/sda bs=1M')).toBe(true);
    });
    it('allows dd to a file', () => {
      expect(denied('dd if=/dev/zero of=./disk.img bs=1M count=100')).toBe(false);
    });
  });

  // --- Fork bomb ---
  describe('fork bomb', () => {
    it('denies :(){ :|:& };:', () => {
      expect(denied(':(){ :|:& };:')).toBe(true);
    });
    it('denies spaced variant', () => {
      expect(denied(':() { :|:& }; :')).toBe(true);
    });
  });

  // --- chmod/chown -R on system paths ---
  describe('chmod/chown -R', () => {
    it('denies chmod -R 777 /', () => {
      expect(denied('chmod -R 777 /')).toBe(true);
    });
    it('denies chown -R root /', () => {
      expect(denied('chown -R root /')).toBe(true);
    });
    it('denies chmod -R on /etc', () => {
      expect(denied('chmod -R 755 /etc')).toBe(true);
    });
    it('denies chown -R on /usr', () => {
      expect(denied('chown -R nobody /usr')).toBe(true);
    });
    it('denies chmod -R on /var', () => {
      expect(denied('chmod -R 777 /var')).toBe(true);
    });
    it('denies chmod -R on ~', () => {
      expect(denied('chmod -R 777 ~')).toBe(true);
    });
    it('allows chmod -R on a normal path', () => {
      expect(denied('chmod -R 755 ./dist')).toBe(false);
    });
    it('allows chmod (no -R) on /', () => {
      expect(denied('chmod 755 /')).toBe(false);
    });
  });

  // --- Shell wrappers ---
  describe('shell wrappers', () => {
    it('denies sudo rm -rf /', () => {
      expect(denied('sudo rm -rf /')).toBe(true);
    });
    it('denies sudo mkfs /dev/sda', () => {
      expect(denied('sudo mkfs /dev/sda')).toBe(true);
    });
    it('denies sudo chmod -R 777 /', () => {
      expect(denied('sudo chmod -R 777 /')).toBe(true);
    });
    it('denies env rm -rf /', () => {
      expect(denied('env rm -rf /')).toBe(true);
    });
    it('denies /usr/bin/rm -rf /', () => {
      expect(denied('/usr/bin/rm -rf /')).toBe(true);
    });
    it('denies bash -c "rm -rf /"', () => {
      expect(denied('bash -c "rm -rf /"')).toBe(true);
    });
    it('denies sudo bash -c "rm -rf /"', () => {
      expect(denied('sudo bash -c "rm -rf /"')).toBe(true);
    });
    it('denies sh -c "mkfs /dev/sda"', () => {
      expect(denied('sh -c "mkfs /dev/sda"')).toBe(true);
    });
    it('denies sudo -u root rm -rf /', () => {
      expect(denied('sudo -u root rm -rf /')).toBe(true);
    });
    it('denies sudo -i rm -rf /', () => {
      expect(denied('sudo -i rm -rf /')).toBe(true);
    });
    it('denies env FOO=bar rm -rf /', () => {
      expect(denied('env FOO=bar rm -rf /')).toBe(true);
    });
    it('denies sudo env bash -c "rm -rf /"', () => {
      expect(denied('sudo env bash -c "rm -rf /"')).toBe(true);
    });
  });

  // --- Safe commands should not be denied ---
  describe('safe commands', () => {
    it('allows ls', () => {
      expect(denied('ls -la')).toBe(false);
    });
    it('allows git push', () => {
      expect(denied('git push origin main')).toBe(false);
    });
    it('allows npm install', () => {
      expect(denied('npm install')).toBe(false);
    });
    it('allows cat', () => {
      expect(denied('cat /etc/hosts')).toBe(false);
    });
    it('allows sudo apt install', () => {
      expect(denied('sudo apt install curl')).toBe(false);
    });
  });
});
