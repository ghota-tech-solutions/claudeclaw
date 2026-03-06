/**
 * Agent Pool v2 — Persistent parallel Claude agents.
 *
 * Agents survive across tasks. After completing a task, they go "idle"
 * and can be resumed with a new task via `--resume <sessionId>`.
 * Stop an agent explicitly when you're done with it.
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
  status: "running" | "idle" | "done" | "error" | "stopped";
  pid: number | null;
  sessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  output: string[];
  building: string;
  taskHistory: string[];
}

const agents = new Map<string, AgentInfo & { proc: ReturnType<typeof Bun.spawn> | null }>();
let agentCounter = 0;

const AGENT_NAMES = ["Pixel", "Spark", "Echo", "Drift", "Neon", "Pulse", "Volt", "Flux", "Byte", "Zinc"];

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

async function buildAppendPrompt(name: string, task: string): Promise<string> {
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

  const { security } = getSettings();
  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);

  return appendParts.join("\n\n");
}

function buildClockPrefix(): string {
  try {
    const settings = getSettings();
    return buildClockPromptPrefix(new Date(), settings.timezoneOffsetMinutes);
  } catch {
    return "";
  }
}

function getCleanEnv(): Record<string, string> {
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const childEnv: Record<string, string> = { ...cleanEnv } as Record<string, string>;
  const { api, model } = getSettings();
  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();
  if (model.trim().toLowerCase() === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  }
  return childEnv;
}

function streamOutput(proc: ReturnType<typeof Bun.spawn>, agent: AgentInfo & { proc: any }) {
  // Stream stdout
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (line.trim()) {
            agent.output.push(line);
            if (agent.output.length > 500) {
              agent.output.splice(0, agent.output.length - 400);
            }
          }
        }
      }
    } catch {}
  })();

  // Stream stderr
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
}

/**
 * Spawn a new persistent agent with an initial task.
 */
export async function spawnAgent(task: string, building?: string): Promise<AgentInfo> {
  const runningCount = Array.from(agents.values()).filter(a => a.status === "running").length;
  if (runningCount >= MAX_AGENTS) {
    throw new Error(`Max ${MAX_AGENTS} running agents reached`);
  }

  await mkdir(LOGS_DIR, { recursive: true });

  const idx = agentCounter++;
  const id = `agent-${Date.now()}-${idx}`;
  const name = AGENT_NAMES[idx % AGENT_NAMES.length];

  const { security, model } = getSettings();
  const securityArgs = buildSecurityArgs(security);
  const appendPrompt = await buildAppendPrompt(name, task);
  const clockPrefix = buildClockPrefix();
  const fullPrompt = clockPrefix ? `${clockPrefix}\n${task}` : task;

  // Use --output-format json to capture session_id from the response
  const args = ["claude", "-p", fullPrompt, "--output-format", "json", ...securityArgs];

  if (model.trim() && model.trim().toLowerCase() !== "glm") {
    args.push("--model", model.trim());
  }
  if (appendPrompt) {
    args.push("--append-system-prompt", appendPrompt);
  }

  const agent: AgentInfo & { proc: ReturnType<typeof Bun.spawn> | null } = {
    id,
    name,
    task,
    status: "running",
    pid: null,
    sessionId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: [],
    building: building || "claudeclaw",
    taskHistory: [task],
    proc: null,
  };

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: getCleanEnv(),
  });

  agent.proc = proc;
  agent.pid = proc.pid;
  agents.set(id, agent);

  console.log(`[${new Date().toLocaleTimeString()}] Agent "${name}" (${id}) spawned for: ${task.slice(0, 80)}`);
  notifyListeners(toInfo(agent));

  // Capture full stdout to extract session_id from JSON
  const stdoutChunks: string[] = [];
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stdoutChunks.push(text);
        // Also push readable lines to output
        for (const line of text.split("\n")) {
          if (line.trim()) {
            // Try to parse JSON to extract result text
            try {
              const json = JSON.parse(line);
              if (json.result) {
                // Push the actual result text, not raw JSON
                for (const rl of json.result.split("\n")) {
                  if (rl.trim()) agent.output.push(rl);
                }
              }
              if (json.session_id) {
                agent.sessionId = json.session_id;
              }
            } catch {
              // Not JSON, push as-is
              agent.output.push(line);
            }
            if (agent.output.length > 500) {
              agent.output.splice(0, agent.output.length - 400);
            }
          }
        }
      }
    } catch {}
  })();

  // Stream stderr
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

  // When process finishes — agent goes IDLE, not done
  proc.exited.then(async (exitCode) => {
    // Try to extract session_id from JSON output
    const fullOutput = stdoutChunks.join("");
    try {
      const json = JSON.parse(fullOutput);
      if (json.session_id) {
        agent.sessionId = json.session_id;
      }
    } catch {
      // May have been streamed in chunks, try line by line
      for (const line of fullOutput.split("\n")) {
        try {
          const json = JSON.parse(line);
          if (json.session_id) agent.sessionId = json.session_id;
        } catch {}
      }
    }

    if (exitCode === 0 && agent.status === "running") {
      // Task done — agent goes idle, ready for next task
      agent.status = "idle";
      agent.exitCode = exitCode;
      agent.finishedAt = new Date().toISOString();
      agent.proc = null;
      console.log(`[${new Date().toLocaleTimeString()}] Agent "${name}" (${id}) idle — session: ${agent.sessionId || "unknown"}`);
    } else if (agent.status === "running") {
      agent.status = "error";
      agent.exitCode = exitCode;
      agent.finishedAt = new Date().toISOString();
      agent.proc = null;
      console.log(`[${new Date().toLocaleTimeString()}] Agent "${name}" (${id}) error — exit code ${exitCode}`);
    }

    // Write log
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = join(LOGS_DIR, `agent-${name}-${timestamp}.log`);
    const logContent = [
      `# agent-${name}`,
      `Date: ${new Date().toISOString()}`,
      `Session: ${agent.sessionId || "unknown"}`,
      `Task: ${task}`,
      `Exit code: ${exitCode}`,
      "",
      "## Output",
      agent.output.join("\n"),
    ].join("\n");
    await Bun.write(logFile, logContent);

    notifyListeners(toInfo(agent));
  });

  return toInfo(agent);
}

/**
 * Resume an idle agent with a new task.
 * Uses `claude -p --resume <sessionId>` to continue the conversation.
 */
export async function resumeAgent(id: string, task: string): Promise<AgentInfo> {
  const agent = agents.get(id);
  if (!agent) throw new Error(`Agent ${id} not found`);
  if (agent.status !== "idle") throw new Error(`Agent ${agent.name} is ${agent.status}, not idle`);
  if (!agent.sessionId) throw new Error(`Agent ${agent.name} has no session ID — cannot resume`);

  const { security, model } = getSettings();
  const securityArgs = buildSecurityArgs(security);
  const clockPrefix = buildClockPrefix();
  const fullPrompt = clockPrefix ? `${clockPrefix}\n${task}` : task;

  const args = [
    "claude", "-p", fullPrompt,
    "--resume", agent.sessionId,
    "--output-format", "json",
    ...securityArgs,
  ];

  if (model.trim() && model.trim().toLowerCase() !== "glm") {
    args.push("--model", model.trim());
  }

  // Update agent state
  agent.task = task;
  agent.status = "running";
  agent.finishedAt = null;
  agent.exitCode = null;
  agent.taskHistory.push(task);
  agent.output.push(`\n── New task: ${task} ──`);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: getCleanEnv(),
  });

  agent.proc = proc;
  agent.pid = proc.pid;

  console.log(`[${new Date().toLocaleTimeString()}] Agent "${agent.name}" (${id}) resumed for: ${task.slice(0, 80)}`);
  notifyListeners(toInfo(agent));

  // Capture stdout
  const stdoutChunks: string[] = [];
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stdoutChunks.push(text);
        for (const line of text.split("\n")) {
          if (line.trim()) {
            try {
              const json = JSON.parse(line);
              if (json.result) {
                for (const rl of json.result.split("\n")) {
                  if (rl.trim()) agent.output.push(rl);
                }
              }
            } catch {
              agent.output.push(line);
            }
            if (agent.output.length > 500) {
              agent.output.splice(0, agent.output.length - 400);
            }
          }
        }
      }
    } catch {}
  })();

  // Stream stderr
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

  // When finished — idle again
  proc.exited.then(async (exitCode) => {
    if (exitCode === 0 && agent.status === "running") {
      agent.status = "idle";
      agent.exitCode = exitCode;
      agent.finishedAt = new Date().toISOString();
      agent.proc = null;
      console.log(`[${new Date().toLocaleTimeString()}] Agent "${agent.name}" (${id}) idle again — tasks completed: ${agent.taskHistory.length}`);
    } else if (agent.status === "running") {
      agent.status = "error";
      agent.exitCode = exitCode;
      agent.finishedAt = new Date().toISOString();
      agent.proc = null;
    }
    notifyListeners(toInfo(agent));
  });

  return toInfo(agent);
}

function toInfo(agent: AgentInfo & { proc: any }): AgentInfo {
  const { proc, ...info } = agent;
  return info;
}

/** Stop an agent — kills process if running, removes from pool */
export function stopAgent(id: string): boolean {
  const agent = agents.get(id);
  if (!agent) return false;

  if (agent.proc) {
    try { agent.proc.kill(); } catch {}
  }

  agent.status = "stopped";
  agent.finishedAt = new Date().toISOString();
  agent.exitCode = -1;
  agent.output.push("[stopped by user]");
  agent.proc = null;

  console.log(`[${new Date().toLocaleTimeString()}] Agent "${agent.name}" (${id}) stopped`);
  notifyListeners(toInfo(agent));
  return true;
}

/** Kill a running agent (alias for backward compat) */
export function killAgent(id: string): boolean {
  return stopAgent(id);
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

/** Clean up stopped/error agents older than 30 minutes */
export function cleanupAgents() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, agent] of agents) {
    if ((agent.status === "stopped" || agent.status === "error") && agent.finishedAt) {
      const finishedTime = new Date(agent.finishedAt).getTime();
      if (finishedTime < cutoff) {
        agents.delete(id);
      }
    }
  }
}

setInterval(cleanupAgents, 5 * 60 * 1000);
