export function createModelClient({ config, llmCaller = null, tools }) {
  let chatClient = null;
  let chatModel = null;

  return {
    async callModel(messages) {
      const startedAt = Date.now();
      const llmConfig = config?.llm ?? {};

      if (!llmConfig.apiKey && !llmCaller) {
        throw new Error("missing LITELLM_API_KEY in .env file");
      }

      if (llmCaller) {
        const custom = await llmCaller({
          model: llmConfig.model,
          messages,
          tools,
          toolChoice: "auto",
          temperature: 0
        });
        const message = custom?.message ?? custom?.choices?.[0]?.message ?? custom ?? {};
        const llmLatencyMs = Number(custom?.llmLatencyMs ?? Date.now() - startedAt) || 0;
        return { message, llmLatencyMs };
      }

      if (!chatClient) {
        const { default: OpenAI } = await import("openai");
        chatClient = new OpenAI({ baseURL: llmConfig.baseUrl, apiKey: llmConfig.apiKey });
        chatModel = llmConfig.model;
      }

      const response = await chatClient.chat.completions.create({
        model: chatModel,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0
      });

      return {
        message: response.choices?.[0]?.message ?? {},
        llmLatencyMs: Date.now() - startedAt
      };
    }
  };
}
