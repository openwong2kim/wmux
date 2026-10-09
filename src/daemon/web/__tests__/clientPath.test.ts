import { describe, it, expect } from 'vitest';
import { isLocalClientPath } from '../clientPath';

describe('isLocalClientPath (#1976)', () => {
  describe('win32', () => {
    const local = (raw: string) => isLocalClientPath(raw, 'win32');

    it('accepts a drive-absolute path with either separator', () => {
      expect(local('C:\\Users\\me\\shot.png')).toBe(true);
      expect(local('C:/Users/me/shot.png')).toBe(true);
      expect(local('d:\\x.png')).toBe(true);
      expect(local('C:\\Users/me\\mixed.png')).toBe(true);
    });

    it('refuses a UNC path spelled with backslashes', () => {
      expect(local('\\\\192.0.2.1\\share\\x.png')).toBe(false);
      expect(local('\\\\host\\share')).toBe(false);
    });

    it('refuses a UNC path spelled with forward slashes', () => {
      expect(local('//192.0.2.1/share/x.png')).toBe(false);
    });

    it('refuses a UNC path with mixed leading separators', () => {
      expect(local('\\/192.0.2.1/share/x.png')).toBe(false);
      expect(local('/\\192.0.2.1\\share\\x.png')).toBe(false);
      expect(local('\\\\192.0.2.1/share\\x.png')).toBe(false);
    });

    it('refuses the extended-length prefix, local or UNC', () => {
      expect(local('\\\\?\\C:\\x.png')).toBe(false);
      expect(local('\\\\?\\UNC\\192.0.2.1\\share\\x.png')).toBe(false);
      expect(local('//?/UNC/192.0.2.1/share/x.png')).toBe(false);
    });

    it('refuses the device prefix', () => {
      expect(local('\\\\.\\pipe\\x')).toBe(false);
      expect(local('\\\\.\\C:\\x.png')).toBe(false);
      expect(local('//./C:/x.png')).toBe(false);
    });

    it('refuses the NT object-namespace prefix, which starts with one separator', () => {
      expect(local('\\??\\UNC\\192.0.2.1\\share\\x.png')).toBe(false);
      expect(local('\\??\\C:\\x.png')).toBe(false);
      expect(local('/??/UNC/192.0.2.1/share/x.png')).toBe(false);
    });

    it('refuses a rooted path with no drive and a drive-relative path', () => {
      expect(local('\\x.png')).toBe(false);
      expect(local('/x.png')).toBe(false);
      expect(local('C:x.png')).toBe(false);
    });

    it('refuses anything before the drive letter', () => {
      expect(local(' C:\\x.png')).toBe(false);
      expect(local('1:\\x.png')).toBe(false);
      expect(local('')).toBe(false);
    });
  });

  it('adds nothing on other platforms: each route keeps its own checks there', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(isLocalClientPath('/home/me/shot.png', platform)).toBe(true);
      expect(isLocalClientPath('//192.0.2.1/share/x.png', platform)).toBe(true);
    }
  });
});
