import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function createChatDiagnostics({ logger, config }) {
  let chatLogReady = false;
  const enabled = Boolean(config?.llm?.diagnosticsEnabled);
  const diagnosticsFile = resolve(config?.llm?.diagnosticsFile || "logs/chat-diagnostics.jsonl");

  return async function writeChatDiagnostics(entry) {
    if (!enabled) return;
    try {
      if (!chatLogReady) {
        await mkdir(dirname(diagnosticsFile), { recursive: true });
        chatLogReady = true;
      }
      await appendFile(
        diagnosticsFile,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          ...entry
        })}\n`,
        "utf8"
      );
    } catch (error) {
      logger.warn("chat diagnostics write failed", { error: error.message });
    }
  };
}
