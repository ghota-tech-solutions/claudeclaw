/**
 * Agent Pool — manages parallel Claude processes.
 *
 * Each agent is an independent `claude -p` process with its own session.
 * Agents run in parallel (no serial queue) and stream output in real-time.
 */

import { mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getSettings, type SecurityConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";

const LOGS_DIR = join(process.cwd(), ".claude/claudeclaw/logs");
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const PROJECT_CLAUDE_MD = join(process.cwd(), "CLAUDE.md");
const PROJECT_DIR = process.cwd();
const MAX_AGENTS = 8;

export interface AgentInfo {
  id: string;
  name: string;
  task: string;
  status: "running" | "done" | "error";
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  output: string[];
  building: string;
}

const agents = new Map<string, AgentInfo & { proc: ReturnType<typeof Bun.spawn> | null }>();
let agentCounter = 0;

const AGENT_NAMES = ["Pixel", "Spark", "Echo", "Drift", "Neon", "Pulse", "Volt", "Flux", "Byte", "Zinc"];
const AGENT_COLORS = ["#ff7043", "#66bb6a", "#ab47bc", "#ffa726", "#26c6da", "#ef5350", "#9ccc65", "#7e57c2", "#ffca28", "#78909c"];

// Event listeners for state changes
type AgentEventListener = (agent: AgentInfo) => void;
const listeners: AgentEventListener[] = [];

export function onAgentChange(fn: AgentEventListener) {
  listeners.push(fn);
}

function notifyListeners(agent: AgentInfo) {
  for (const fn of listeners) {
    try { fn(agent); } catch {}
  }
}

function buildSecurityArgs(security: SecurityConfig): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  switch (security.level) {
    case "locked":
      args.push("--tools", "Read,Grep,Glob");
      break;
    case "strict":
      args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
      break;
    case "moderate":
    case "unrestricted":
      break;
  }

  if (security.allowedTools.length > 0) {
    args.push("--allowedTools", security.allowedTools.join(" "));
  }
  if (security.disallowedTools.length > 0) {
    args.push("--disallowedTools", security.disallowedTools.join(" "));
  }

  return args;
}

async function loadPrompts(): Promise<string> {
  const files = [
    join(PROMPTS_DIR, "IDENTITY.md"),
    join(PROMPTS_DIR, "USER.md"),
    join(PROMPTS_DIR, "SOUL.md"),
  ];
  const parts: string[] = [];
  for (const file of files) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch {}
  }
  return parts.join("\n\n");
}

const DIR_SCOPE_PROMPT = [
  `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${PROJECT_DIR}`,
  "You MUST NOT read, write, edit, or delete any file outside this directory.",
  "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
  "If a request requires accessing files outside the project, refuse and explain why.",
].join("\n");

/**
 * Spawn a new parallel agent. Does NOT use the global session —
 * each agent gets its own fresh session via `--output-format json`.
 */
export async function spawnAgent(task: string, building?: string): Promise<AgentInfo> {
  if (agents.size >= MAX_AGENTS) {
    throw new Error(`Max ${MAX_AGENTS} parallel agents reached`);
  }

  await mkdir(LOGS_DIR, { recursive: true });

  const idx = agentCounter++;
  const id = `agent-${Date.now()}-${idx}`;
  const name = AGENT_NAMES[idx % AGENT_NAMES.length];

  const { security, model, api } = getSettings();
  const securityArgs = buildSecurityArgs(security);

  // Build system prompt
  const promptContent = await loadPrompts();
  const appendParts: string[] = [
    `You are agent "${name}" running inside ClaudeClaw (parallel agent pool).`,
    `Your task: ${task}`,
    "Work on this task until completion. Be thorough and report your results.",
  ];
  if (promptContent) appendParts.push(promptContent);

  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch {}
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);

  // Build clock prefix
  let clockPrefix = "";
  try {
    const settings = getSettings();
    clockPrefix = buildClockPromptPrefix(new Date(), settings.timezoneOffsetMinutes);
  } catch {}

  const fullPrompt = clockPrefix ? `${clockPrefix}\n${task}` : task;

  // Build args — new session (json output to capture session_id)
  const args = ["claude", "-p", fullPrompt, "--output-format", "text", ...securityArgs];

  if (model.trim() && model.trim().toLowerCase() !== "glm") {
    args.push("--model", model.trim());
  }

  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  // Clean env
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const childEnv: Record<string, string> = { ...cleanEnv } as Record<string, string>;
  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();
  if (model.trim().toLowerCase() === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  }

  const agent: AgentInfo & { proc: ReturnType<typeof Bun.spawn> | null } = {
    id,
    name,
    task,
    status: "running",
    pid: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: [],
    building: building || "claudeclaw",
    proc: null,
  };

  // Spawn process
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });

  agent.proc = proc;
  agent.pid = proc.pid;
  agents.set(id, agent);

  console.log(`[${new Date().toLocaleTimeString()}] Agent "${name}" (${id}) spawned for: ${task.slice(0, 80)}`);
  notifyListeners(toInfo(agent));

  // Stream stdout in background
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            agent.output.push(line);
            // Keep output buffer reasonable
            if (agent.output.length > 500) {
              agent.output.splice(0, agent.output.length - 400);
            }
          }
        }
      }
    } catch {}
  })();

  // Stream stderr in background
  (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          agent.output.push(`[stderr] ${text.trim()}`);
        }
      }
    } catch {}
  })();

  // Wait for process to finish
  proc.exited.then(async (exitCode) => {
    agent.status = exitCode === 0 ? "done" : "error";
    agent.exitCode = exitCode;
    agent.finishedAt = new Date().toISOString();

    // Write log file
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = join(LOGS_DIR, `agent-${name}-${timestamp}.log`);
    const logContent = [
      `# agent-${name}`,
      `Date: ${agent.finishedAt}`,
      `Task: ${task}`,
      `Exit code: ${exitCode}`,
      "",
      "## Output",
      agent.output.join("\n"),
    ].join("\n");
    await Bun.write(logFile, logContent);

    console.log(`[${new Date().toLocaleTimeString()}] Agent "${name}" (${id}) finished with exit code ${exitCode}`);
    notifyListeners(toInfo(agent));
  });

  return toInfo(agent);
}

function toInfo(agent: AgentInfo & { proc: any }): AgentInfo {
  const { proc, ...info } = agent;
  return info;
}

/** Kill a running agent */
export function killAgent(id: string): boolean {
  const agent = agents.get(id);
  if (!agent || !agent.proc) return false;

  try {
    agent.proc.kill();
    agent.status = "error";
    agent.finishedAt = new Date().toISOString();
    agent.exitCode = -1;
    agent.output.push("[killed by user]");
    notifyListeners(toInfo(agent));
    return true;
  } catch {
    return false;
  }
}

/** Get all agents */
export function getActiveAgents(): AgentInfo[] {
  return Array.from(agents.values()).map(toInfo);
}

/** Get a specific agent */
export function getAgent(id: string): AgentInfo | null {
  const agent = agents.get(id);
  return agent ? toInfo(agent) : null;
}

/** Get agent output (last N lines) */
export function getAgentOutput(id: string, tail = 100): string[] {
  const agent = agents.get(id);
  if (!agent) return [];
  return agent.output.slice(-tail);
}

/** Clean up finished agents older than 30 minutes */
export function cleanupAgents() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, agent] of agents) {
    if (agent.status !== "running" && agent.finishedAt) {
      const finishedTime = new Date(agent.finishedAt).getTime();
      if (finishedTime < cutoff) {
        agents.delete(id);
      }
    }
  }
}

// Cleanup every 5 minutes
setInterval(cleanupAgents, 5 * 60 * 1000);
