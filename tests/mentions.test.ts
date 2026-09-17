import { describe, expect, it } from 'vitest';
import { findTargetMention, isSupportedMessage } from '../src/mentions.js';

describe('findTargetMention', () => {
  it('matches a target user mention', () => {
    expect(findTargetMention('请看 <@U123|Alice>', new Set(['U123']), new Set())).toEqual({ type: 'user', id: 'U123' });
  });

  it('matches a target subteam mention', () => {
    expect(findTargetMention('<!subteam^S123|team> 处理一下', new Set(), new Set(['S123']))).toEqual({ type: 'subteam', id: 'S123' });
  });

  it('ignores non-target mentions', () => {
    expect(findTargetMention('<@U999>', new Set(['U123']), new Set())).toBeUndefined();
  });
});

describe('isSupportedMessage', () => {
  const base = {
    channel: 'C123',
    ts: '100.000001',
    text: '<@U123> please help',
    user: 'U456',
  };

  it('accepts a human app_mention event', () => {
    expect(isSupportedMessage({ ...base, type: 'app_mention' })).toBe(true);
  });

  it.each([
    { subtype: 'message_changed' },
    { subtype: 'message_deleted' },
  ])('rejects a mutated event %j', (change) => {
    expect(isSupportedMessage({ ...base, type: 'app_mention', ...change })).toBe(false);
  });

  it.each([
    { bot_id: 'B123' },
    { app_id: 'A123' },
    { subtype: 'bot_message' },
  ])('accepts source metadata for author lookup %j', (change) => {
    expect(isSupportedMessage({ ...base, type: 'app_mention', ...change })).toBe(true);
  });

  it('rejects unsupported event types', () => {
    expect(isSupportedMessage({ ...base, type: 'reaction_added' })).toBe(false);
  });
});
