/**
 * Unit tests for Phase D gpu-dispatch.ts.
 *
 * Pins the contract that bridges the fold's operator handlers to the GPU
 * buffer infrastructure:
 *
 *   1. Formula eligibility — which formulas are GPU-dispatchable.
 *   2. Formula parsing — correct extraction of op, field, comparator, threshold.
 *   3. Field sync — DEF numeric values flow into GPU field buffers.
 *   4. Eval dispatch — GPU-eligible formulas dispatch and register with
 *      gpuInFlight; ineligible formulas return null.
 *   5. Progressive enhancement — everything is a no-op when GPU is unavailable.
 *
 * WebGPU is not available in Vitest/Node.js. Tests that exercise dispatch
 * logic inject a mock GpuFieldBuffers via _setGpuBuffersForTest.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isGpuEligible,
  parseGpuFormula,
  syncNumericField,
  syncDefToGpu,
  dispatchEvalGpu,
  isGpuAvailable,
  resetGpuDispatch,
  _setGpuBuffersForTest,
} from '../gpu-dispatch';
import type { GpuEvalResult } from '../gpu-dispatch';
import { GpuInFlightTracker } from '../gpu-in-flight';
import {
  initGpuBuffers,
  uploadNumericField,
  writeFieldValue,
} from '../gpu-buffers';
import type { GpuFieldBuffers } from '../gpu-buffers';
import type { EvaRegistration } from '../types';

// ─── Mock GPUDevice (same pattern as gpu-buffers.test.ts) ────────────────────

function createMockDevice() {
  const writtenBuffers: Array<{ buffer: unknown; offset: number; data: ArrayBuffer }> = [];

  const mockDevice = {
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      return {
        desc,
        destroy: vi.fn(),
        mapAsync: vi.fn().mockResolvedValue(undefined),
        getMappedRange: vi.fn(() => new ArrayBuffer(desc.size)),
        unmap: vi.fn(),
      } as unknown as GPUBuffer;
    },
    queue: {
      writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBufferLike): void {
        writtenBuffers.push({ buffer, offset, data: data as ArrayBuffer });
      },
      submit: vi.fn(),
    },
    createShaderModule: vi.fn().mockReturnValue({}),
    createComputePipelineAsync: vi.fn().mockResolvedValue({
      getBindGroupLayout: vi.fn().mockReturnValue({}),
    }),
    createBindGroup: vi.fn().mockReturnValue({}),
    createCommandEncoder: vi.fn().mockReturnValue({
      beginComputePass: vi.fn().mockReturnValue({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      }),
      copyBufferToBuffer: vi.fn(),
      finish: vi.fn().mockReturnValue({}),
    }),
    _writtenBuffers: writtenBuffers,
  } as unknown as GPUDevice & { _writtenBuffers: typeof writtenBuffers };

  return mockDevice;
}

function createMockBuffers(): GpuFieldBuffers {
  const device = createMockDevice();
  return initGpuBuffers(device as unknown as GPUDevice);
}

// ─── Tests ───────────────────────────────────────────────────────────────���───

describe('gpu-dispatch', () => {
  beforeEach(() => {
    resetGpuDispatch();
  });

  // ─── Progressive enhancement ───────────────────────��─────────────────────

  describe('progressive enhancement (GPU unavailable)', () => {
    it('isGpuAvailable returns false when not initialised', () => {
      expect(isGpuAvailable()).toBe(false);
    });

    it('syncNumericField is a no-op when GPU unavailable', () => {
      // Should not throw — silently returns.
      expect(() => syncNumericField('target', 'field', 42)).not.toThrow();
    });

    it('syncDefToGpu is a no-op when GPU unavailable', () => {
      expect(() => syncDefToGpu('target', { price: 99 })).not.toThrow();
    });

    it('dispatchEvalGpu returns null when GPU unavailable', async () => {
      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'SUM(score)' },
        mode: 'fold',
        dependencies: ['a', 'b'],
      };
      expect(await dispatchEvalGpu(reg)).toBeNull();
    });
  });

  // ─── Formula eligibility ─────────────────────────────────────────────────

  describe('isGpuEligible', () => {
    it('accepts SUM(field)', () => {
      expect(isGpuEligible({ formula: 'SUM(score)' })).toBe(true);
    });

    it('accepts AVG(field)', () => {
      expect(isGpuEligible({ formula: 'AVG(price)' })).toBe(true);
    });

    it('accepts MIN(field)', () => {
      expect(isGpuEligible({ formula: 'MIN(age)' })).toBe(true);
    });

    it('accepts MAX(field)', () => {
      expect(isGpuEligible({ formula: 'MAX(revenue)' })).toBe(true);
    });

    it('accepts COUNT(field)', () => {
      expect(isGpuEligible({ formula: 'COUNT(items)' })).toBe(true);
    });

    it('accepts FILTER(field > 100)', () => {
      expect(isGpuEligible({ formula: 'FILTER(score > 100)' })).toBe(true);
    });

    it('accepts COSINE(target)', () => {
      expect(isGpuEligible({ formula: 'COSINE(focal:item)' })).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isGpuEligible({ formula: 'sum(score)' })).toBe(true);
      expect(isGpuEligible({ formula: 'Sum(Score)' })).toBe(true);
    });

    it('rejects non-formula operand', () => {
      expect(isGpuEligible({ value: 42 })).toBe(false);
    });

    it('rejects formula with external references', () => {
      expect(isGpuEligible({ formula: 'NOW()' })).toBe(false);
    });

    it('rejects plain string formula', () => {
      expect(isGpuEligible({ formula: 'just some text' })).toBe(false);
    });

    it('rejects null/undefined', () => {
      expect(isGpuEligible(null)).toBe(false);
      expect(isGpuEligible(undefined)).toBe(false);
    });

    it('rejects non-object', () => {
      expect(isGpuEligible('SUM(score)')).toBe(false);
      expect(isGpuEligible(42)).toBe(false);
    });
  });

  // ─── Formula parsing ─────────────────────────────────────────────────────

  describe('parseGpuFormula', () => {
    it('parses SUM(field)', () => {
      const parsed = parseGpuFormula('SUM(score)');
      expect(parsed).toEqual({ op: 'SUM', field: 'score' });
    });

    it('parses AVG(field)', () => {
      const parsed = parseGpuFormula('AVG(price)');
      expect(parsed).toEqual({ op: 'AVG', field: 'price' });
    });

    it('parses MIN(field)', () => {
      const parsed = parseGpuFormula('MIN(age)');
      expect(parsed).toEqual({ op: 'MIN', field: 'age' });
    });

    it('parses MAX(field)', () => {
      const parsed = parseGpuFormula('MAX(revenue)');
      expect(parsed).toEqual({ op: 'MAX', field: 'revenue' });
    });

    it('parses COUNT(field)', () => {
      const parsed = parseGpuFormula('COUNT(items)');
      expect(parsed).toEqual({ op: 'COUNT', field: 'items' });
    });

    it('parses FILTER(field > threshold)', () => {
      const parsed = parseGpuFormula('FILTER(score > 100)');
      expect(parsed).toEqual({ op: 'FILTER', field: 'score', cmp: '>', threshold: 100 });
    });

    it('parses FILTER(field >= threshold)', () => {
      const parsed = parseGpuFormula('FILTER(price >= 9.99)');
      expect(parsed).toEqual({ op: 'FILTER', field: 'price', cmp: '>=', threshold: 9.99 });
    });

    it('parses FILTER(field < threshold)', () => {
      const parsed = parseGpuFormula('FILTER(age < 30)');
      expect(parsed).toEqual({ op: 'FILTER', field: 'age', cmp: '<', threshold: 30 });
    });

    it('parses FILTER(field <= threshold)', () => {
      const parsed = parseGpuFormula('FILTER(rank <= 5)');
      expect(parsed).toEqual({ op: 'FILTER', field: 'rank', cmp: '<=', threshold: 5 });
    });

    it('parses FILTER(field = threshold)', () => {
      const parsed = parseGpuFormula('FILTER(status = 1)');
      expect(parsed).toEqual({ op: 'FILTER', field: 'status', cmp: '=', threshold: 1 });
    });

    it('parses COSINE(target)', () => {
      const parsed = parseGpuFormula('COSINE(item:focal)');
      expect(parsed).toEqual({ op: 'COSINE', field: 'item:focal' });
    });

    it('is case-insensitive', () => {
      expect(parseGpuFormula('sum(score)')).toEqual({ op: 'SUM', field: 'score' });
      expect(parseGpuFormula('filter(x > 5)')).toEqual({ op: 'FILTER', field: 'x', cmp: '>', threshold: 5 });
    });

    it('returns null for unrecognised patterns', () => {
      expect(parseGpuFormula('UNKNOWN(x)')).toBeNull();
      expect(parseGpuFormula('just text')).toBeNull();
      expect(parseGpuFormula('')).toBeNull();
    });

    it('handles whitespace', () => {
      expect(parseGpuFormula('  SUM( score )  ')).toEqual({ op: 'SUM', field: 'score' });
      expect(parseGpuFormula('FILTER( price >= 10 )')).toEqual({
        op: 'FILTER', field: 'price', cmp: '>=', threshold: 10,
      });
    });
  });

  // ─── Field sync with mock GPU ─────────────────────────────────────────────

  describe('syncNumericField (with mock GPU)', () => {
    it('creates a field buffer on first sync', () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      syncNumericField('alice', 'score', 42);

      expect(buffers.targetToSlot.has('alice')).toBe(true);
      expect(buffers.numericFields.has('score')).toBe(true);
      const { cpu } = buffers.numericFields.get('score')!;
      expect(cpu[buffers.targetToSlot.get('alice')!]).toBe(42);
    });

    it('uses O(1) writeFieldValue for existing target+field', () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      // Bootstrap
      syncNumericField('alice', 'score', 10);
      const cpuBefore = buffers.numericFields.get('score')!.cpu;

      // Update — should modify in place (same Float32Array object)
      syncNumericField('alice', 'score', 99);
      const cpuAfter = buffers.numericFields.get('score')!.cpu;

      // O(1) path keeps the same cpu array (writeFieldValue modifies in place)
      expect(cpuAfter).toBe(cpuBefore);
      expect(cpuAfter[buffers.targetToSlot.get('alice')!]).toBe(99);
    });

    it('preserves existing values when adding a new target to an existing field', () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      syncNumericField('alice', 'score', 42);
      syncNumericField('bob', 'score', 77);

      const { cpu } = buffers.numericFields.get('score')!;
      expect(cpu[buffers.targetToSlot.get('alice')!]).toBe(42);
      expect(cpu[buffers.targetToSlot.get('bob')!]).toBe(77);
    });

    it('handles new field for existing target', () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      syncNumericField('alice', 'score', 42);
      syncNumericField('alice', 'age', 30);

      expect(buffers.numericFields.has('score')).toBe(true);
      expect(buffers.numericFields.has('age')).toBe(true);
      expect(buffers.numericFields.get('age')!.cpu[buffers.targetToSlot.get('alice')!]).toBe(30);
    });
  });

  describe('syncDefToGpu', () => {
    it('syncs all numeric keys from an operand', () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      syncDefToGpu('item:1', { price: 9.99, quantity: 5, name: 'Widget' });

      expect(buffers.numericFields.has('price')).toBe(true);
      expect(buffers.numericFields.has('quantity')).toBe(true);
      // 'name' is a string — should not create a numeric field
      expect(buffers.numericFields.has('name')).toBe(false);
    });

    it('skips underscore-prefixed internal keys', () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      syncDefToGpu('item:1', { price: 10, _internal: 42 });

      expect(buffers.numericFields.has('price')).toBe(true);
      expect(buffers.numericFields.has('_internal')).toBe(false);
    });

    it('skips non-finite numbers (NaN, Infinity)', () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      syncDefToGpu('item:1', { valid: 10, nan: NaN, inf: Infinity });

      expect(buffers.numericFields.has('valid')).toBe(true);
      expect(buffers.numericFields.has('nan')).toBe(false);
      expect(buffers.numericFields.has('inf')).toBe(false);
    });

    it('is a no-op for non-object operands', () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      expect(() => syncDefToGpu('x', null)).not.toThrow();
      expect(() => syncDefToGpu('x', 'string')).not.toThrow();
      expect(() => syncDefToGpu('x', 42)).not.toThrow();
      expect(() => syncDefToGpu('x', [1, 2, 3])).not.toThrow();
    });
  });

  // ─── Eval dispatch ────────────────────────────���──────────────────────────

  describe('dispatchEvalGpu (with mock GPU)', () => {
    it('returns null for non-GPU-eligible formula', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'some arbitrary expression' },
        mode: 'fold',
        dependencies: ['a'],
      };
      expect(await dispatchEvalGpu(reg)).toBeNull();
    });

    it('returns null when formula field is not in GPU buffers', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'SUM(nonexistent)' },
        mode: 'fold',
        dependencies: ['a', 'b'],
      };
      expect(await dispatchEvalGpu(reg)).toBeNull();
    });

    it('computes SUM over dependencies', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      // Populate field data
      uploadNumericField(buffers, 'score', new Map([
        ['a', 10],
        ['b', 20],
        ['c', 30],
      ]));

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'SUM(score)' },
        mode: 'fold',
        dependencies: ['a', 'b', 'c'],
      };

      const result = await dispatchEvalGpu(reg);
      expect(result).not.toBeNull();
      expect((result!.result as any).value).toBe(60);
      expect((result!.result as any).op).toBe('SUM');
      expect((result!.result as any).gpu_accelerated).toBe(true);
    });

    it('computes AVG over dependencies', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      uploadNumericField(buffers, 'price', new Map([
        ['a', 10],
        ['b', 30],
      ]));

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'AVG(price)' },
        mode: 'fold',
        dependencies: ['a', 'b'],
      };

      const result = await dispatchEvalGpu(reg);
      expect(result).not.toBeNull();
      expect((result!.result as any).value).toBe(20);
    });

    it('computes MIN over dependencies', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      uploadNumericField(buffers, 'rank', new Map([
        ['a', 5],
        ['b', 2],
        ['c', 8],
      ]));

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'MIN(rank)' },
        mode: 'fold',
        dependencies: ['a', 'b', 'c'],
      };

      const result = await dispatchEvalGpu(reg);
      expect((result!.result as any).value).toBe(2);
    });

    it('computes MAX over dependencies', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      uploadNumericField(buffers, 'rank', new Map([
        ['a', 5],
        ['b', 2],
        ['c', 8],
      ]));

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'MAX(rank)' },
        mode: 'fold',
        dependencies: ['a', 'b', 'c'],
      };

      const result = await dispatchEvalGpu(reg);
      expect((result!.result as any).value).toBe(8);
    });

    it('computes COUNT (non-zero values) over dependencies', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      uploadNumericField(buffers, 'active', new Map([
        ['a', 1],
        ['b', 0],
        ['c', 1],
      ]));

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'COUNT(active)' },
        mode: 'fold',
        dependencies: ['a', 'b', 'c'],
      };

      const result = await dispatchEvalGpu(reg);
      expect((result!.result as any).value).toBe(2);
    });

    it('scopes aggregation to registration dependencies only', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      // 'c' is in the field buffer but NOT in the registration's dependencies
      uploadNumericField(buffers, 'score', new Map([
        ['a', 10],
        ['b', 20],
        ['c', 100],
      ]));

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'SUM(score)' },
        mode: 'fold',
        dependencies: ['a', 'b'],  // only a and b
      };

      const result = await dispatchEvalGpu(reg);
      expect((result!.result as any).value).toBe(30);  // 10+20, not 130
    });

    it('returns null when no dependencies have slots', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      uploadNumericField(buffers, 'score', new Map([['a', 10]]));

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'SUM(score)' },
        mode: 'fold',
        dependencies: ['unknown1', 'unknown2'],  // no slots
      };

      expect(await dispatchEvalGpu(reg)).toBeNull();
    });
  });

  // ─── gpuInFlight integration ────────────────────────────────���────────────

  describe('gpuInFlight registration contract', () => {
    it('aggregation dispatch registers work with gpuInFlight', async () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);

      uploadNumericField(buffers, 'val', new Map([['a', 1]]));

      // Import the singleton — same module instance as gpu-dispatch uses.
      const { gpuInFlight } = await import('../gpu-in-flight');

      const reg: EvaRegistration = {
        target: 'x',
        formula: { formula: 'SUM(val)' },
        mode: 'fold',
        dependencies: ['a'],
      };

      // Dispatch registers a (resolved) promise. After it completes and
      // a microtask fires, the count should return to 0.
      await dispatchEvalGpu(reg);
      // Give the cleanup .then a chance to fire.
      await Promise.resolve();
      await Promise.resolve();
      expect(gpuInFlight.inFlightCount()).toBe(0);
    });
  });

  // ─── Singleton lifecycle ─────────────────────────────────────────────────

  describe('singleton lifecycle', () => {
    it('isGpuAvailable reflects _setGpuBuffersForTest', () => {
      expect(isGpuAvailable()).toBe(false);

      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);
      expect(isGpuAvailable()).toBe(true);

      resetGpuDispatch();
      expect(isGpuAvailable()).toBe(false);
    });

    it('resetGpuDispatch allows re-init', () => {
      const buffers = createMockBuffers();
      _setGpuBuffersForTest(buffers);
      expect(isGpuAvailable()).toBe(true);

      resetGpuDispatch();
      expect(isGpuAvailable()).toBe(false);

      // Can set again after reset
      _setGpuBuffersForTest(createMockBuffers());
      expect(isGpuAvailable()).toBe(true);
    });
  });
});
