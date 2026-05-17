jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
  })),
}));

import { normalizePriority } from '../src/core/priority-queue';

describe('normalizePriority', () => {
  describe('Turing-format inputs', () => {
    it('accepts P0–P3 verbatim', () => {
      expect(normalizePriority('P0')).toBe('P0');
      expect(normalizePriority('P1')).toBe('P1');
      expect(normalizePriority('P2')).toBe('P2');
      expect(normalizePriority('P3')).toBe('P3');
    });

    it('is case-insensitive for Turing slugs', () => {
      expect(normalizePriority('p0')).toBe('P0');
      expect(normalizePriority('p3')).toBe('P3');
    });
  });

  describe('Plane-format inputs', () => {
    it('maps urgent → P0', () => {
      expect(normalizePriority('urgent')).toBe('P0');
      expect(normalizePriority('URGENT')).toBe('P0');
    });

    it('maps high → P1', () => {
      expect(normalizePriority('high')).toBe('P1');
    });

    it('maps medium → P2', () => {
      expect(normalizePriority('medium')).toBe('P2');
    });

    it('maps low and none → P3', () => {
      expect(normalizePriority('low')).toBe('P3');
      expect(normalizePriority('none')).toBe('P3');
    });
  });

  describe('Fallbacks', () => {
    it('falls back to P2 on unknown string', () => {
      expect(normalizePriority('critical')).toBe('P2');
      expect(normalizePriority('xyz')).toBe('P2');
    });

    it('falls back to P2 on non-string', () => {
      expect(normalizePriority(undefined)).toBe('P2');
      expect(normalizePriority(null)).toBe('P2');
      expect(normalizePriority(5)).toBe('P2');
      expect(normalizePriority({})).toBe('P2');
    });

    it('falls back to P2 on empty / whitespace string', () => {
      expect(normalizePriority('')).toBe('P2');
      expect(normalizePriority('   ')).toBe('P2');
    });
  });
});
