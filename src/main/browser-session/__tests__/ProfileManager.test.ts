import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileManager } from '../ProfileManager';

describe('ProfileManager', () => {
  let manager: ProfileManager;

  beforeEach(() => {
    manager = new ProfileManager();
  });

  it('should have 2 default profiles (default, login) on creation', () => {
    const profiles = manager.listProfiles();
    expect(profiles).toHaveLength(2);
    const names = profiles.map((p) => p.name);
    expect(names).toContain('default');
    expect(names).toContain('login');
  });

  it('should create a new profile via createProfile()', () => {
    const profile = manager.createProfile('work');
    expect(profile.name).toBe('work');
    expect(profile.persistent).toBe(true);
    expect(profile.createdAt).toBeInstanceOf(Date);
    expect(manager.listProfiles()).toHaveLength(3);
  });

  it('should throw when creating a profile with an existing name', () => {
    expect(() => manager.createProfile('default')).toThrow(
      'Profile "default" already exists'
    );
  });

  it('should reject unsafe profile names before creating partitions', () => {
    expect(() => manager.createProfile('../login\ncontrol-char')).toThrow(
      'Browser profile names must be 1-64 characters'
    );
    expect(() => manager.createProfile('a'.repeat(65))).toThrow(
      'Browser profile names must be 1-64 characters'
    );
    expect(manager.listProfiles()).toHaveLength(2);
  });

  it('should retrieve a profile via getProfile()', () => {
    const profile = manager.getProfile('default');
    expect(profile).toBeDefined();
    expect(profile!.name).toBe('default');
  });

  it('should return undefined for non-existent profile via getProfile()', () => {
    expect(manager.getProfile('nonexistent')).toBeUndefined();
  });

  it('should return all profiles via listProfiles()', () => {
    manager.createProfile('extra');
    const profiles = manager.listProfiles();
    expect(profiles).toHaveLength(3);
  });

  it('should delete a non-default profile via deleteProfile()', () => {
    manager.createProfile('temp');
    expect(manager.listProfiles()).toHaveLength(3);
    const deleted = manager.deleteProfile('temp');
    expect(deleted).toBe(true);
    expect(manager.listProfiles()).toHaveLength(2);
  });

  it('should not delete default profiles', () => {
    const result1 = manager.deleteProfile('default');
    const result2 = manager.deleteProfile('login');
    expect(result1).toBe(false);
    expect(result2).toBe(false);
    expect(manager.listProfiles()).toHaveLength(2);
  });

  it('should set and get active profile', () => {
    const active = manager.getActiveProfile();
    expect(active.name).toBe('default');

    manager.setActiveProfile('login');
    expect(manager.getActiveProfile().name).toBe('login');
  });

  it('should throw when setting a non-existent profile as active', () => {
    expect(() => manager.setActiveProfile('nonexistent')).toThrow(
      'Profile "nonexistent" does not exist'
    );
  });

  it('should return correct partition string via getPartition()', () => {
    const partition = manager.getPartition('default');
    expect(partition).toBe('persist:wmux-default');
  });

  it('should return partition for active profile when no name given', () => {
    const partition = manager.getPartition();
    expect(partition).toBe('persist:wmux-default');
  });

  it('should use persist: prefix for persistent profiles', () => {
    const profile = manager.createProfile('persistent-test', true);
    expect(profile.partition).toBe('persist:wmux-persistent-test');
  });

  it('should not use persist: prefix for non-persistent profiles', () => {
    const profile = manager.createProfile('temp-test', false);
    expect(profile.partition).toBe('wmux-temp-test');
  });

  it('should throw when getting partition for non-existent profile', () => {
    expect(() => manager.getPartition('nonexistent')).toThrow(
      'Profile "nonexistent" does not exist'
    );
  });
});
