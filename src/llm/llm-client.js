export function createLlmClient({ tools = [], llmCaller = null, llm = null, baseURL = null, apiKey = null, model = null } = {}) {
  let chatClient = null;
  let chatModel = null;

  async function call(messages, options = {}) {
    const llmConfig = llm ?? {};
    const resolvedBaseURL = llmConfig.baseURL ?? baseURL ?? process.env.LITELLM_BASE_URL ?? "https://llm.bears.disi.unitn.it/v1";
    const resolvedApiKey = llmConfig.apiKey ?? apiKey ?? process.env.LITELLM_API_KEY;
    const resolvedModel = llmConfig.model ?? model ?? process.env.LOCAL_MODEL ?? "llama-3.3-70b-lmstudio";
    const startedAt = Date.now();

    if (!resolvedApiKey && !llmCaller) {
      throw new Error("missing LITELLM_API_KEY in .env file");
    }

    if (llmCaller) {
      const custom = await llmCaller({
        model: resolvedModel,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        toolChoice: options.toolChoice ?? "auto",
        temperature: options.temperature ?? 0
      });
      const message = custom?.message ?? custom?.choices?.[0]?.message ?? custom ?? {};
      return {
        message,
        llmLatencyMs: Number(custom?.llmLatencyMs ?? Date.now() - startedAt) || 0
      };
    }

    if (!chatClient) {
      const { default: OpenAI } = await import("openai");
      chatClient = new OpenAI({ baseURL: resolvedBaseURL, apiKey: resolvedApiKey });
      chatModel = resolvedModel;
    }

    const request = {
      model: chatModel,
      messages,
      temperature: options.temperature ?? 0
    };
    if (tools.length > 0) {
      request.tools = tools;
      request.tool_choice = options.toolChoice ?? "auto";
    }

    const response = await chatClient.chat.completions.create(request);

    return {
      message: response.choices?.[0]?.message ?? {},
      llmLatencyMs: Date.now() - startedAt
    };
  }

  return { call };
}
