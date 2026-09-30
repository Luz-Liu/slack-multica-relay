import { describe, expect, it, vi } from 'vitest';
import {
  addSlackReaction,
  ensureSlackReaction,
  reactionErrorDetails,
} from '../src/reaction.js';
import { MemoryThreadStore } from '../src/thread-store.js';

describe('addSlackReaction', () => {
  it('calls Slack reactions.add with the message identity', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await addSlackReaction('xoxp-test', 'C123', '1700000000.000100', 'lark_onesecond', fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/reactions.add',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer xoxp-test' }),
        body: JSON.stringify({ channel: 'C123', timestamp: '1700000000.000100', name: 'lark_onesecond' }),
      }),
    );
  });

  it('treats an existing reaction as success for Slack retries', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'already_reacted' }), { status: 200 }));

    await expect(addSlackReaction('xoxp-test', 'C123', '1700000000.000100', 'lark_onesecond', fetchMock)).resolves.toBeUndefined();
  });
});

describe('ensureSlackReaction', () => {
  it('keeps a failed attempted marker so a replay cannot add a late reaction', async () => {
    const store = new MemoryThreadStore();
    const failed = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: false, error: 'ratelimited' }),
    );
    await expect(
      ensureSlackReaction('reaction-key', 'token', 'C1', '1.1', 'eyes', store, failed),
    ).rejects.toThrow();

    const replay = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: true }),
    );
    await expect(
      ensureSlackReaction('reaction-key', 'token', 'C1', '1.1', 'eyes', store, replay),
    ).resolves.toBe('skipped');
    expect(replay).not.toHaveBeenCalled();
  });

  it('caps a competing delivery wait to its own remaining attempt budget', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const store = {
        setIfAbsent: async () => false,
        get: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 740));
          return JSON.stringify({ attemptedAtMs: 700 });
        },
        set: async () => {},
        releaseIfOwner: async () => {},
      };
      const fetchMock = vi.fn<typeof fetch>();
      let completed = false;
      const attempt = ensureSlackReaction(
        'reaction-key', 'token', 'C1', '1.1', 'eyes', store, fetchMock,
      ).then(() => { completed = true; });

      await vi.advanceTimersByTimeAsync(740);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await attempt;
      expect(completed).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('reaction diagnostics', () => {
  it.each([
    [{ ok: false, error: 'invalid_name' }, 'invalid_name'],
    [{ ok: false, error: 'missing_scope' }, 'missing_scope'],
    [{ ok: false, error: 'xoxb-secret-value' }, 'unknown_error'],
    [null, 'invalid_response'],
  ])('reports safe Slack error codes', async (body, code) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    const error = await addSlackReaction('secret', 'C1', '1.1', 'cats', fetchMock).catch(e => e);
    expect(reactionErrorDetails(error)).toEqual({ errorCode: code, httpStatus: 200 });
  });

  it('reports HTTP failures without response contents', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret', { status: 429 }));
    const error = await addSlackReaction('secret', 'C1', '1.1', 'cats', fetchMock).catch(e => e);
    expect(reactionErrorDetails(error)).toEqual({ errorCode: 'http_error', httpStatus: 429 });
  });

  it('does not expose network error messages', () => {
    expect(reactionErrorDetails(new Error('secret'))).toEqual({ errorCode: 'network_error' });
    expect(reactionErrorDetails(new DOMException('secret', 'TimeoutError'))).toEqual({ errorCode: 'request_timeout' });
  });
});
