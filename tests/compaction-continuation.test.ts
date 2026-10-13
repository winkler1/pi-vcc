import { expect, test } from "bun:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerBeforeCompactHook } from "../src/hooks/before-compact";

for (const toolTurn of [false, true]) {
  test(`percentage compaction resumes ${toolTurn ? "a tool workflow without an extra turn" : "an unfinished response"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "vcc-continuation-"));
    const previousConfig = process.env.PI_VCC_CONFIG_PATH;
    process.env.PI_VCC_CONFIG_PATH = join(dir, "config.json");
    writeFileSync(process.env.PI_VCC_CONFIG_PATH, JSON.stringify({ autoCompactionPercentage: 50, smartKeepTail: false }));
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 100 }, retry: { enabled: false } });
    const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: "http://localhost", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1024 } as any;
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
    await runtime.setRuntimeApiKey("openai", "fixture");
    let requests = 0;
    const assistant = (first: boolean) => ({
      role: "assistant", content: first && toolTurn ? [{ type: "toolCall", id: "task", name: "complete_task", arguments: {} }] : [{ type: "text", text: first ? "WORK_IN_PROGRESS" : "TASK_COMPLETE" }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: first && toolTurn ? "toolUse" : "stop",
      usage: { input: first ? 120_000 : 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: first ? 120_010 : 1010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    runtime.streamSimple = (async (_model: unknown, _context: unknown, options: any) => {
      const message = assistant(++requests === 1);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: message };
          await new Promise(resolve => setTimeout(resolve, 5));
          if (options.signal?.aborted) {
            Object.assign(message, { stopReason: "aborted", errorMessage: "Request aborted" });
            yield { type: "error", reason: "aborted", error: message };
          } else {
            yield { type: "done", reason: message.stopReason, message };
          }
        },
        result: async () => message,
      };
    }) as any;
    const manager = SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "Earlier task " + "history ".repeat(2000), timestamp: 0 });
    manager.appendMessage(assistant(false) as any);
    manager.appendMessage({ role: "user", content: "Prior follow-up " + "history ".repeat(500), timestamp: 0 });
    manager.appendMessage(assistant(false) as any);
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [registerBeforeCompactHook] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime, settingsManager, sessionManager: manager, resourceLoader: loader, tools: [], customTools: [{ name: "complete_task", label: "Complete task", description: "Complete task", parameters: { type: "object", properties: {} } as any, execute: async () => ({ content: [{ type: "text", text: "TOOL_COMPLETE" }], details: undefined }) }] });
    try {
      await session.bindExtensions({});
      await session.prompt("Complete task then report TASK_COMPLETE.");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(manager.getEntries().filter(e => e.type === "compaction")).toHaveLength(1);
      expect(session.getLastAssistantText()).toBe("TASK_COMPLETE");
      expect(requests).toBe(2);
    } finally {
      session.dispose();
      if (previousConfig === undefined) delete process.env.PI_VCC_CONFIG_PATH;
      else process.env.PI_VCC_CONFIG_PATH = previousConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
