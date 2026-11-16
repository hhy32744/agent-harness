/**
 * CLI 总入口：解析子命令 → 装配配置 → 分派到具体实现。
 *
 * 这里只做"粘合"，不写业务逻辑：每种模式的实现都在各自的文件里，
 * 所以 main 读起来就是一串 case，测试也只需要测被分派到的那一层。
 */
import type { LLMClient } from "../llm/types";
import type { Scope } from "../scope";
import type { ToolDefinition } from "../tools/types";
import { HELP_TEXT, UsageError, parseArgv, version, type Command, type RunOptions } from "./args";
import { MissingApiKeyError, createLLM, createScope, createTools, resolveConfig, type CliConfig } from "./config";
import { createReadlineIO, runChat } from "./chat";
import { formatRead, readUrl } from "./read";
import { formatOutcome, runPromptTask, toJson } from "./prompt";
import { formatDoctor, runDoctor } from "./doctor";
import { buildRemoteCommand, buildSshArgv, runSsh } from "./remote";

export interface CliIO {
  out(line?: string): void;
  err(line: string): void;
}

export interface CliOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  io?: Partial<CliIO>;
}

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

export async function main(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io: CliIO = {
    out: options.io?.out ?? ((line = "") => process.stdout.write(`${line}\n`)),
    err: options.io?.err ?? ((line) => process.stderr.write(`${line}\n`)),
  };

  let command: Command;
  try {
    command = parseArgv(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`dsh: ${err.message}`);
      if (err.hint) io.err(`提示：${err.hint}`);
      io.err("");
      io.err("运行 dsh help 查看用法");
      return EXIT_USAGE;
    }
    throw err;
  }

  switch (command.kind) {
    case "help":
      io.out(HELP_TEXT);
      return EXIT_OK;

    case "version":
      io.out(`dsh ${version()}`);
      return EXIT_OK;

    case "doctor":
      return runDoctorCommand(command, env, io);

    case "chat":
      return runChatCommand(command.options, env, io);

    case "prompt":
      return runPromptCommand(command.task, command.options, env, io);

    case "read":
      return runReadCommand(command, env, io);

    case "remote":
      return runRemoteCommand(command, env, io);
  }
}

interface Assembled {
  config: CliConfig;
  tools: ToolDefinition[];
  scope: Scope;
  llm: LLMClient;
}

/** 装配运行所需的一切；失败时把原因翻成人话，返回退出码而不是抛栈 */
function assemble(options: RunOptions, env: NodeJS.ProcessEnv, io: CliIO): Assembled | number {
  try {
    const config = resolveConfig(options, env);
    return { config, tools: createTools(config), scope: createScope(config), llm: createLLM(config) };
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      io.err(`dsh: ${err.message}`);
      io.err("提示：先跑 dsh doctor 看环境，或 export DSH_API_KEY=sk-...");
      return EXIT_USAGE;
    }
    io.err(`dsh: 配置有误：${err instanceof Error ? err.message : String(err)}`);
    return EXIT_USAGE;
  }
}

function describeTarget(config: CliConfig): string {
  const hosts = config.hosts.length > 0 ? config.hosts.join(",") : "未限制";
  return `dsh ${version()} | model=${config.model} | endpoint=${config.baseUrl} | 主机=${hosts} | 工具=${config.tools.length}`;
}

async function runChatCommand(options: RunOptions, env: NodeJS.ProcessEnv, io: CliIO): Promise<number> {
  const ready = assemble(options, env, io);
  if (typeof ready === "number") return ready;

  if (!options.quiet) {
    io.out(describeTarget(ready.config));
    io.out("");
  }

  const { io: chatIO, close } = createReadlineIO();
  try {
    await runChat({
      llm: ready.llm,
      tools: ready.tools,
      scope: ready.scope,
      role: ready.config.role,
      io: chatIO,
      verbose: !options.quiet,
      name: "dsh",
    });
  } finally {
    close();
  }
  return EXIT_OK;
}

async function runPromptCommand(
  task: string,
  options: RunOptions,
  env: NodeJS.ProcessEnv,
  io: CliIO,
): Promise<number> {
  const ready = assemble(options, env, io);
  if (typeof ready === "number") return ready;

  const outcome = await runPromptTask(task, {
    llm: ready.llm,
    tools: ready.tools,
    scope: ready.scope,
    role: ready.config.role,
    io: { print: (line?: string) => io.out(line) },
    verbose: !options.quiet && !options.json,
    name: "dsh",
  });

  if (options.json) {
    io.out(toJson(outcome));
  } else {
    for (const line of formatOutcome(outcome)) io.out(line);
  }

  return outcome.result.status === "completed" ? EXIT_OK : EXIT_FAIL;
}

/**
 * `dsh read` 不装配 LLM —— 网络读取是内核能力，跟有没有 key 无关。
 * 主机白名单仍走同一份配置，所以 --allow-host 在这里和 agent 里含义一致。
 */
async function runReadCommand(
  command: Extract<Command, { kind: "read" }>,
  env: NodeJS.ProcessEnv,
  io: CliIO,
): Promise<number> {
  const config = resolveConfig(command.options, env);
  const result = await readUrl({
    url: command.url,
    hosts: config.hosts,
    maxBytes: command.maxBytes,
    raw: command.raw,
  });

  if (command.options.json) {
    io.out(JSON.stringify(result, null, 2));
  } else {
    for (const line of formatRead(result, { full: command.full })) io.out(line);
  }

  return result.ok ? EXIT_OK : EXIT_FAIL;
}

async function runDoctorCommand(
  command: Extract<Command, { kind: "doctor" }>,
  env: NodeJS.ProcessEnv,
  io: CliIO,
): Promise<number> {
  const report = await runDoctor({ env, options: command.options });

  if (command.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatDoctor(report)) io.out(line);
  }

  if (report.failed > 0) return EXIT_FAIL;
  if (command.strict && report.warned > 0) return EXIT_FAIL;
  return EXIT_OK;
}

async function runRemoteCommand(
  command: Extract<Command, { kind: "remote" }>,
  env: NodeJS.ProcessEnv,
  io: CliIO,
): Promise<number> {
  const config = resolveConfig(command.options, env);

  let remoteCommand: string;
  try {
    remoteCommand = buildRemoteCommand(
      command.prompt ? { kind: "prompt", task: command.prompt } : { kind: "chat" },
      {
        bin: config.remoteBin,
        hosts: config.hosts,
        model: command.options.model,
        baseUrl: command.options.baseUrl,
        maxTurns: command.options.maxTurns,
        maxToolCalls: command.options.maxToolCalls,
        json: command.options.json,
      },
    );
  } catch (err) {
    io.err(`dsh: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_USAGE;
  }

  if (!command.options.quiet) {
    io.out(`ssh ${command.host} -> ${remoteCommand}`);
    io.out("");
  }

  try {
    const { code } = await runSsh(buildSshArgv(command.host, remoteCommand, { interactive: !command.prompt }));
    return code;
  } catch (err) {
    io.err(`dsh: ${err instanceof Error ? err.message : String(err)}`);
    io.err("提示：dsh doctor 会列出 ~/.ssh/config 里可用的 Host 别名");
    return EXIT_FAIL;
  }
}
