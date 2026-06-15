export function createModelClient({ config, llmCaller = null, tools, logger = null }) {
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
        try {
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
        } catch (error) {
          if (logger) logger.error("llmCaller failed", { error: error.message, stack: error.stack });
          throw error;
        }
      }

      if (!chatClient) {
        const { default: OpenAI } = await import("openai");
        chatClient = new OpenAI({ baseURL: llmConfig.baseUrl, apiKey: llmConfig.apiKey });
        chatModel = llmConfig.model;
      }

      try {
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
      } catch (error) {
        if (logger) logger.error("openai api call failed", { error: error.message, stack: error.stack, model: chatModel, baseUrl: llmConfig.baseUrl });
        throw error;
      }
    }
  };
}
