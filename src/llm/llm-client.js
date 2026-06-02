import { createLlmClient as createChatLlmClient } from "../chat/llm-client.js";

export function createLlmClient(options = {}) {
  return createChatLlmClient(options);
}
