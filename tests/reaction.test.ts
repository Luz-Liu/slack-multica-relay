import { describe, expect, it, vi } from 'vitest';
import { addSlackReaction, reactionErrorDetails } from '../src/reaction.js';

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
