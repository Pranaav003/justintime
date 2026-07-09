import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn, SdkMessage } from './claude-bridge';

/**
 * Adapts the real Claude Agent SDK `query()` to the QueryFn shape the provider
 * expects. This is the single boundary where the SDK's types meet ours; the
 * cast is contained here so claude-bridge stays SDK-agnostic and hermetically
 * testable.
 */
export function makeClaudeQuery(): QueryFn {
  return ({ prompt, options }) => {
    const iterable = sdkQuery({ prompt, options } as Parameters<typeof sdkQuery>[0]);
    return (async function* (): AsyncIterable<SdkMessage> {
      for await (const message of iterable) {
        yield message as unknown as SdkMessage;
      }
    })();
  };
}
