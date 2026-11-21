export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  // anthropic_content: Claude's original reply blocks, sent back unchanged while its tool round continues.
  | { role: 'assistant'; content: string | null; tool_calls?: LlmToolCall[]; anthropic_content?: unknown[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type LlmToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
