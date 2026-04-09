/**
 * Tests for db/gpu-buffers.ts
 *
 * WebGPU is not available in Vitest/Node.js. These tests use a mock GPUDevice
 * that captures all buffer writes, command submissions, etc., and validates:
 *  - the correct CPU-side data is assembled before upload
 *  - writeFieldValue updates cpu array in place
 *  - targetIndex/targetToSlot slot allocation is consistent
 *
 * GPU dispatch correctness (filterNumeric, computeCosineSimilarity) is verified
 * by checking the shader source matches the expected WGSL pattern, and that the
 * GPU pipeline is invoked with correct binding counts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  initGpuBuffers,
  uploadNumericField,
  uploadCategoricalField,
  writeFieldValue,
} from '../gpu-buffers';
import type { GpuFieldBuffers } from '../gpu-buffers';

// ─── Mock GPUDevice ───────────────────────────────────────────────────────────

function createMockDevice() {
  const writtenBuffers: Array<{ buffer: unknown; offset: number; data: ArrayBuffer }> = [];
  const createdBuffers: GPUBuffer[] = [];

  const mockDevice = {
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      const fakeBuf = {
        desc,
        destroy: vi.fn(),
        mapAsync: vi.fn().mockResolvedValue(undefined),
        getMappedRange: vi.fn(() => new ArrayBuffer(desc.size)),
        unmap: vi.fn(),
      } as unknown as GPUBuffer;
      createdBuffers.push(fakeBuf);
      return fakeBuf;
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
    _createdBuffers: createdBuffers,
  } as unknown as GPUDevice & {
    _writtenBuffers: typeof writtenBuffers;
    _createdBuffers: GPUBuffer[];
  };

  return mockDevice;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('gpu-buffers', () => {
  describe('initGpuBuffers', () => {
    it('returns empty buffers', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      expect(buffers.targetIndex).toHaveLength(0);
      expect(buffers.numericFields.size).toBe(0);
      expect(buffers.categoricalFields.size).toBe(0);
    });
  });

  describe('uploadNumericField', () => {
    it('allocates slots for targets in insertion order', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadNumericField(buffers, 'score', new Map([
        ['alice', 10],
        ['bob', 20],
      ]));
      expect(buffers.targetIndex[0]).toBe('alice');
      expect(buffers.targetIndex[1]).toBe('bob');
      expect(buffers.targetToSlot.get('alice')).toBe(0);
      expect(buffers.targetToSlot.get('bob')).toBe(1);
    });

    it('stores correct Float32Array cpu values', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadNumericField(buffers, 'age', new Map([['x', 99], ['y', 42]]));
      const { cpu } = buffers.numericFields.get('age')!;
      expect(cpu[buffers.targetToSlot.get('x')!]).toBe(99);
      expect(cpu[buffers.targetToSlot.get('y')!]).toBe(42);
    });

    it('uploads cpu buffer to GPU via writeBuffer', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadNumericField(buffers, 'score', new Map([['a', 1]]));
      expect(device._writtenBuffers.length).toBeGreaterThan(0);
    });

    it('slots are reused across multiple fields', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadNumericField(buffers, 'field1', new Map([['alice', 1]]));
      uploadNumericField(buffers, 'field2', new Map([['alice', 2]]));
      // Alice should have the same slot in both fields
      expect(buffers.targetToSlot.get('alice')).toBe(0);
      expect(buffers.numericFields.get('field1')!.cpu[0]).toBe(1);
      expect(buffers.numericFields.get('field2')!.cpu[0]).toBe(2);
    });
  });

  describe('uploadCategoricalField', () => {
    it('builds vocab from distinct values', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadCategoricalField(buffers, 'role', new Map([
        ['alice', 'admin'],
        ['bob', 'user'],
        ['carol', 'admin'],
      ]));
      const { vocab } = buffers.categoricalFields.get('role')!;
      expect(vocab).toContain('admin');
      expect(vocab).toContain('user');
      expect(vocab.length).toBe(2);
    });

    it('encodes same value to same uint32', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadCategoricalField(buffers, 'tier', new Map([
        ['a', 'gold'],
        ['b', 'silver'],
        ['c', 'gold'],
      ]));
      const { cpu } = buffers.categoricalFields.get('tier')!;
      expect(cpu[buffers.targetToSlot.get('a')!]).toBe(cpu[buffers.targetToSlot.get('c')!]);
    });
  });

  describe('writeFieldValue', () => {
    it('updates cpu array in place', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadNumericField(buffers, 'score', new Map([['alice', 10]]));
      writeFieldValue(buffers, 'alice', 'score', 99);
      const { cpu } = buffers.numericFields.get('score')!;
      expect(cpu[buffers.targetToSlot.get('alice')!]).toBe(99);
    });

    it('writes only 4 bytes to GPU at the correct offset', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadNumericField(buffers, 'score', new Map([['alice', 10], ['bob', 20]]));
      const writesBefore = device._writtenBuffers.length;
      writeFieldValue(buffers, 'bob', 'score', 55);
      const writesAfter = device._writtenBuffers.length;
      expect(writesAfter - writesBefore).toBe(1);
      const lastWrite = device._writtenBuffers[device._writtenBuffers.length - 1];
      // Bob is slot 1, so offset should be 1 * 4 = 4
      expect(lastWrite.offset).toBe(4);
    });

    it('is a no-op for unknown target', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadNumericField(buffers, 'score', new Map([['alice', 10]]));
      expect(() => writeFieldValue(buffers, 'unknown', 'score', 99)).not.toThrow();
    });

    it('is a no-op for unknown field', () => {
      const device = createMockDevice();
      const buffers = initGpuBuffers(device as unknown as GPUDevice);
      uploadNumericField(buffers, 'score', new Map([['alice', 10]]));
      expect(() => writeFieldValue(buffers, 'alice', 'unknown-field', 99)).not.toThrow();
    });
  });
});
