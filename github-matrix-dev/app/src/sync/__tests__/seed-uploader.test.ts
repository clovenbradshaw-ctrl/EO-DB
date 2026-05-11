/**
 * seed-uploader tests — the minimal seed-upload contract.
 *
 * `uploadSeedFile` reads the head state, hands the file bytes to
 * `sealBlockFromPayload`, and returns the resulting block-event id +
 * byte count. The actual upload + Megolm-encrypted-room-event flow is
 * exercised by the block-sealer / block-hydration tests and the manual
 * e2e checks in the plan. Here we cover the input-validation surface
 * and the contract that the seed bytes flow through unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import { uploadSeedFile } from '../seed-uploader';

describe('uploadSeedFile', () => {
  it('rejects an empty payload', async () => {
    const client = {
      getDeviceId: () => 'd',
      getRoom: () => null,
    } as any;
    await expect(
      uploadSeedFile(client, '!room', new Uint8Array(0)),
    ).rejects.toThrow(/empty/i);
  });

  it('passes the bytes through to sealBlockFromPayload verbatim', async () => {
    // Capture the payload that sealBlockFromPayload would receive.
    // We do this by mocking the matrix client's media + send calls.
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    let uploadedPayloadSize: number | null = null;
    const sendEventCalls: any[] = [];
    const sendStateEventCalls: any[] = [];

    const client = {
      getUserId: () => '@u:t',
      getDeviceId: () => 'd',
      getRoom: () => null, // empty head
      uploadContent: vi.fn(async (blob: Blob) => {
        uploadedPayloadSize = blob.size;
        return { content_uri: 'mxc://t/x' };
      }),
      sendEvent: vi.fn(async (_rid: string, _type: string, body: any) => {
        sendEventCalls.push(body);
        return { event_id: '$block0' };
      }),
      sendStateEvent: vi.fn(async (_rid: string, _type: string, body: any) => {
        sendStateEventCalls.push(body);
      }),
    } as any;

    const result = await uploadSeedFile(client, '!room', bytes);

    // AES-CTR is 1:1 byte length with input → uploaded blob is the same
    // size as the input bytes.
    expect(uploadedPayloadSize).toBe(bytes.byteLength);

    // One m.eo.block event, one m.eo.head state event.
    expect(sendEventCalls.length).toBe(1);
    expect(sendStateEventCalls.length).toBe(1);

    // Block message references the uploaded attachment.
    expect(sendEventCalls[0].block_index).toBe(0);
    expect(sendEventCalls[0].prior_block_event_id).toBeNull();
    expect(sendEventCalls[0].file.url).toBe('mxc://t/x');

    // Head pointer advanced.
    expect(sendStateEventCalls[0].latest_block_event_id).toBe('$block0');
    expect(sendStateEventCalls[0].block_count).toBe(1);

    expect(result.blockEventId).toBe('$block0');
    expect(result.blockIndex).toBe(0);
    expect(result.byteCount).toBe(bytes.byteLength);
  });
});
