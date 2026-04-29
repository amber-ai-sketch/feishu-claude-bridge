/**
 * feishu-claude-bridge — 飞书 ↔ Claude Code CLI bridge
 *
 * 架构（来自 ~/.gstack/projects/Projects/ym-feishu-claude-bridge-design-*.md）：
 *   lark-cli event +subscribe (长连接, NDJSON stdout)
 *     → 本进程 (路由 + 鉴权 + session 映射 + cron)
 *       → claude -p --session-id <uuid> --dangerously-skip-permissions ...
 *         → Claude 内部通过 lark-cli skill 发消息回飞书
 *
 * 安全模型（重要）：
 *   - 默认 --dangerously-skip-permissions （bypass 所有权限提示）
 *   - 唯一防线：FCB_OWNER_OPEN_IDS 环境变量白名单
 *   - 飞书账号必须开 2FA，否则账号被盗 = 公司 Mac root 沦陷
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import cron from "node-cron";

// ─── config ─────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.FCB_STATE_DIR ?? join(homedir(), ".local/state/fcb");
const SESSIONS_FILE = join(STATE_DIR, "sessions.json");
const CRONTAB_FILE = join(STATE_DIR, "crontab.json");
const CHAT_MODELS_FILE = join(STATE_DIR, "chat-models.json");
const LARK_CLI = process.env.FCB_LARK_CLI ?? "lark-cli";
const CLAUDE_CLI = process.env.FCB_CLAUDE_CLI ?? "claude";
// 默认 opus alias（Claude Code 会解析到 ANTHROPIC_DEFAULT_OPUS_MODEL 配置的实际 id）
// 显式传 --model 可以覆盖外部 ANTHROPIC_MODEL 环境变量。
// 省成本可改 haiku / sonnet；用 Anthropic 官方 API 也能写完整 id（claude-sonnet-4-6 等）
const CLAUDE_MODEL = process.env.FCB_CLAUDE_MODEL ?? "opus";

const OWNER_OPEN_IDS = new Set(
  (process.env.FCB_OWNER_OPEN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

if (OWNER_OPEN_IDS.size === 0) {
  console.error(
    "[fcb] FATAL: FCB_OWNER_OPEN_IDS 未配置。拒绝启动以防止任意人触发 Claude Code。"
  );
  console.error(
    "[fcb] 示例: FCB_OWNER_OPEN_IDS=ou_xxxxxxxx bun run bridge.ts"
  );
  process.exit(1);
}

mkdirSync(STATE_DIR, { recursive: true });

// 启动前做外部 CLI 存在性 + 可执行性检查，别等 spawn 才 ENOENT
// 背景：VSCode Claude Code 插件升级时会清老版本目录，/opt/homebrew/bin/claude 的
// symlink 经常烂掉。以前这种情况要等用户发消息、bridge spawn claude 失败才发现；
// 现在启动就 fail fast + 清晰报错。
import { spawnSync } from "node:child_process";

function preflightCLI(cli: string, envVarName: string) {
  const probe = spawnSync(cli, ["--version"], { stdio: "pipe" });
  if (probe.error || probe.status !== 0) {
    console.error(
      `[fcb] FATAL: 外部 CLI "${cli}" 不可用（${envVarName} 环境变量可覆盖）`
    );
    if (probe.error) console.error(`[fcb]        error: ${probe.error.message}`);
    if (probe.stderr?.length) console.error(`[fcb]        stderr: ${probe.stderr.toString().trim()}`);
    console.error(
      `[fcb] 常见原因：PATH 不含安装目录；或 symlink 指向已删除的 binary`
    );
    console.error(
      `[fcb] 修法：确认 \`${cli} --version\` 在你的 shell 里能跑；或把 ${envVarName} 指到绝对路径`
    );
    process.exit(1);
  }
}

preflightCLI(LARK_CLI, "FCB_LARK_CLI");
preflightCLI(CLAUDE_CLI, "FCB_CLAUDE_CLI");

// ─── persistence ────────────────────────────────────────────────────────────

type Sessions = Record<string, string>; // chat_id -> session_id (交互式)
type CronJob = { id: string; cron: string; prompt: string; chat_id: string };

function loadJSON<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch (err) {
    console.error(`[fcb] failed to load ${file}:`, err);
    return fallback;
  }
}

const sessions: Sessions = loadJSON(SESSIONS_FILE, {});
const cronJobs: CronJob[] = loadJSON(CRONTAB_FILE, []);
// 每个 chat 的 model 覆盖。key=chat_id, value=model alias 或完整 id
// 空 = 用全局 CLAUDE_MODEL 默认
const chatModels: Record<string, string> = loadJSON(CHAT_MODELS_FILE, {});

// 追踪哪些 session 已经被 claude spawn 过 —— 决定用 --session-id 还是 --resume
// 首次 spawn 用 --session-id 新建；已 started 的用 --resume 续传（否则 claude 会报 "already in use"）
// 从持久化 sessions 加载的 chat 都视为 started（Claude Code 自己的 session 存储已登记）
const startedSessions = new Set<string>(Object.keys(sessions));

function saveSessions() {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error("[fcb] saveSessions failed:", err);
  }
}

function saveChatModels() {
  try {
    writeFileSync(CHAT_MODELS_FILE, JSON.stringify(chatModels, null, 2));
  } catch (err) {
    console.error("[fcb] saveChatModels failed:", err);
  }
}

function getChatModel(chatId: string): string {
  return chatModels[chatId] ?? CLAUDE_MODEL;
}

function getOrCreateInteractiveSession(chatId: string): { id: string; started: boolean } {
  if (!sessions[chatId]) {
    sessions[chatId] = randomUUID();
    saveSessions();
    console.log(`[fcb] new interactive session for chat=${chatId} sid=${sessions[chatId]}`);
    return { id: sessions[chatId], started: false };
  }
  return { id: sessions[chatId], started: startedSessions.has(chatId) };
}

function markSessionStarted(chatId: string) {
  startedSessions.add(chatId);
}

function resetInteractiveSession(chatId: string) {
  delete sessions[chatId];
  startedSessions.delete(chatId);
  saveSessions();
}

// ─── markdown 预处理：表格 → 代码块 ──────────────────────────────────────────
// 飞书 post 富文本格式 **不支持表格**（CHANGELOG 里也从未出现 table 支持）。
// lark-cli --markdown 遇到 GFM 表格会把它吞掉或退化成一堆 | 字符的散行。
// 处理：
//   1. 把检测到的表格整段用 ``` 代码块包起来 —— 代码块飞书原生支持
//   2. 按"视觉宽度"（CJK 全角 = 2 cells, ASCII = 1 cell）重新 pad 每格，让等宽字体下列真的对齐
//   3. 剥掉 **bold** 标记（在代码块里会以字面量显示，徒增噪音）
// 不处理：已经在 ``` 内的块（避免嵌套）；落在行中的单个 | 字符（不是表格）。

// 视觉宽度计算：East Asian Wide/Fullwidth 记 2 格，其余记 1 格
// 注意：把 Unicode EAW="Ambiguous" 的常见字符（—、└、┌、●、→ 等）也当作宽字符
//       处理，因为在中文等宽字体上下文下它们实际就是 2 cells。v8 版本漏了这一层，
//       带 └ 的子项列右侧 pipe 会往右偏 1 格。
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2010 && cp <= 0x201f) || // general punctuation: —（em-dash）– … 等
      (cp >= 0x2020 && cp <= 0x205f) || // 更多 general punctuation（†‡•…‰ 等）
      (cp >= 0x2190 && cp <= 0x21ff) || // Arrows（← → ↑ ↓）
      (cp >= 0x2200 && cp <= 0x22ff) || // Mathematical Operators（∑ ∏ √ 等）
      (cp >= 0x2460 && cp <= 0x24ff) || // Enclosed Alphanumerics（① ② …）
      (cp >= 0x2500 && cp <= 0x257f) || // Box Drawing（└ ─ │ ├ ┌ 等）
      (cp >= 0x2580 && cp <= 0x259f) || // Block Elements
      (cp >= 0x25a0 && cp <= 0x25ff) || // Geometric Shapes（● ○ ■ □）
      (cp >= 0x2600 && cp <= 0x26ff) || // Miscellaneous Symbols（☀ ☂ ✓）
      (cp >= 0x2700 && cp <= 0x27bf) || // Dingbats（✔ ✗ ✈）
      (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals / Kangxi / CJK Unified
      (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2ffff) // CJK Extension B-F
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padVisual(s: string, target: number): string {
  const diff = target - visualWidth(s);
  return diff > 0 ? s + " ".repeat(diff) : s;
}

function parseRowCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.replace(/\*\*([^*]+)\*\*/g, "$1").trim());
}

const isSepCell = (c: string) => /^:?-{3,}:?$/.test(c.trim());

function formatTablesAsCodeBlocks(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  const sepLineRE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }
    const cur = line.trimStart();
    const nxt = (lines[i + 1] ?? "").trimStart();
    if (cur.startsWith("|") && sepLineRE.test(nxt)) {
      // 收集整段表格
      const block: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        block.push(lines[i]);
        i++;
      }
      const rows = block.map((l) => {
        const cells = parseRowCells(l);
        return { cells, isSep: cells.length > 0 && cells.every(isSepCell) };
      });
      const colCount = Math.max(...rows.map((r) => r.cells.length));
      const widths = new Array(colCount).fill(0);
      for (const r of rows) {
        if (r.isSep) continue;
        for (let c = 0; c < r.cells.length; c++) {
          widths[c] = Math.max(widths[c], visualWidth(r.cells[c]));
        }
      }
      out.push("```");
      for (const r of rows) {
        const cells: string[] = [];
        for (let c = 0; c < colCount; c++) {
          cells.push(r.isSep ? "-".repeat(Math.max(3, widths[c])) : padVisual(r.cells[c] ?? "", widths[c]));
        }
        out.push("| " + cells.join(" | ") + " |");
      }
      out.push("```");
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// ─── feishu send queue (per-chat) ────────────────────────────────────────────
// Codex consult 指出：sendToFeishu fire-and-forget 在高吞吐下会丢消息/乱序/触发频控。
// MVP 只发最终 result 时其实一次就够，但仍加一个最小 per-chat 队列：
//   1. 保证同一 chat 内消息串行
//   2. 发送间隔 ≥ 200ms （飞书 API 频控下限保守值）
//   3. 记录失败（含 stderr），至少让用户能从 log 发现"为什么没收到"

const sendQueues = new Map<string, Promise<void>>();
const MIN_SEND_INTERVAL_MS = 200;

function sendToFeishu(chatId: string, text: string) {
  const prev = sendQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(() => sendOneToFeishu(chatId, text));
  sendQueues.set(chatId, next);
  // cleanup so map doesn't grow
  next.finally(() => {
    if (sendQueues.get(chatId) === next) sendQueues.delete(chatId);
  });
}

function sendOneToFeishu(chatId: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    // 发前把 markdown 表格转成 ``` 代码块（飞书 post 格式不支持表格）
    const payload = formatTablesAsCodeBlocks(text);
    let proc: ChildProcess;
    try {
      // 用 --markdown 而不是 --text：lark-cli 会自动转成 post 富文本格式
      // 好处：飞书 App（尤其手机）会渲染 **加粗** / # 标题 / ``` 代码块 / 列表，不再是一坨裸字符
      // 兜底：纯文本塞进 --markdown 也没问题，lark-cli 会当普通段落处理
      proc = spawn(LARK_CLI, [
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--chat-id",
        chatId,
        "--markdown",
        payload,
      ]);
    } catch (err) {
      // binary not found 会同步 throw
      console.error(`[fcb] sendToFeishu spawn threw (binary missing?):`, err);
      setTimeout(resolve, MIN_SEND_INTERVAL_MS);
      return;
    }
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("exit", (code) => {
      if (code !== 0) {
        console.error(
          `[fcb] sendToFeishu failed chat=${chatId} code=${code} stderr=${stderr.trim()}`
        );
      }
      // 节流：固定间隔后再 resolve，保证下一条消息不会立刻打出去
      setTimeout(resolve, MIN_SEND_INTERVAL_MS);
    });
    proc.on("error", (err) => {
      console.error(`[fcb] sendToFeishu spawn error:`, err);
      setTimeout(resolve, MIN_SEND_INTERVAL_MS);
    });
  });
}

// ─── per-chat claude run queue ───────────────────────────────────────────────
// 同一 chat_id 快速发两条消息时，Claude Code 的 --resume session 不能并发写。
// 方案：per-chat 串行化，第二条等第一条跑完再开始。

const claudeQueues = new Map<string, Promise<void>>();

function enqueueClaudeRun(
  chatId: string,
  sessionId: string,
  prompt: string,
  opts: { isFreshSession: boolean }
) {
  const prev = claudeQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(() => runClaude(sessionId, chatId, prompt, opts));
  claudeQueues.set(chatId, next);
  next.finally(() => {
    if (claudeQueues.get(chatId) === next) claudeQueues.delete(chatId);
  });
}

function runClaude(
  sessionId: string,
  chatId: string,
  prompt: string,
  opts: { isFreshSession: boolean }
): Promise<void> {
  return new Promise((resolve) => {
    const model = getChatModel(chatId);
    // 首次用 --session-id 新建；之后必须用 --resume，否则 claude 报 "session ... already in use"
    const sessionFlag = opts.isFreshSession ? "--session-id" : "--resume";
    console.log(
      `[fcb] spawning claude chat=${chatId} sid=${sessionId} model=${model} flag=${sessionFlag} prompt_preview="${prompt.slice(0, 60)}..."`
    );

    let claude: ChildProcess;
    try {
      claude = spawn(
        CLAUDE_CLI,
        [
          "-p",
          sessionFlag,
          sessionId,
          "--model",
          model,
          "--dangerously-skip-permissions",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          prompt,
        ],
        {
          // 关掉 stdin：否则 Claude Code 会等 3 秒 stdin 数据，然后 exit 1
          // (prompt 是通过 argv 传的，不需要 stdin)
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      // spawn 的那一刻即标记 started —— 不管后续成败，session id 都被 claude 登记了
      markSessionStarted(chatId);
    } catch (err) {
      console.error(`[fcb] claude spawn threw (binary missing?):`, err);
      sendToFeishu(chatId, `❌ 无法启动 Claude Code: ${(err as Error).message}`);
      resolve();
      return;
    }

    let finalText = "";
    let sawResult = false;
    let resultIsError = false;
    let errorDetails = ""; // 组装好的错误信息（给飞书回发用）
    let stderrTail = "";

    if (!claude.stdout || !claude.stderr) {
      console.error("[fcb] claude spawn missing stdio");
      sendToFeishu(chatId, "❌ Claude Code 进程 stdio 异常");
      resolve();
      return;
    }

    // 用 readline 按真实行边界切，避免 chunk 跨 JSON 的解析失败
    createInterface({ input: claude.stdout }).on("line", (line) => {
      if (!line) return;
      try {
        const msg = JSON.parse(line) as StreamJsonMessage;
        if (msg.type === "result") {
          sawResult = true;
          // result message 除了 "result" 字段，还有 is_error / subtype / errors 等诊断字段
          const r = msg as {
            is_error?: boolean;
            subtype?: string;
            result?: unknown;
            errors?: unknown[];
            stop_reason?: string;
            api_error_status?: number | null;
          };
          if (r.is_error) {
            resultIsError = true;
            // 注意：subtype 在 result 消息里是 "Claude Code 流程完成度"的标志
            // （success / interrupted / error_during_execution），不是 "请求成功"
            // 容易被误读成 "既然 type=success 为什么还报错"，所以不往飞书发
            const parts: string[] = [];
            if (r.stop_reason) parts.push(`stop=${r.stop_reason}`);
            if (r.api_error_status != null) parts.push(`api_status=${r.api_error_status}`);
            if (Array.isArray(r.errors) && r.errors.length > 0) {
              parts.push(`errors=${r.errors.map(String).join(" / ")}`);
            }
            if (typeof r.result === "string" && r.result) {
              parts.push(`result=${r.result}`);
            }
            errorDetails = parts.join(" | ") || "(no details in result message)";
          } else if (typeof r.result === "string") {
            finalText = r.result;
          }
        }
        // O2: 进度流式 —— MVP 暂不转发 assistant partial / tool_use 事件。
        //     启用前必须先做 rate limit + 队列（见 design doc 7.2 "O2 前置条件"）。
      } catch {
        /* 忽略非 JSON 行 */
      }
    });

    claude.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) {
        console.error(`[claude] ${msg}`);
        // 保留最后 500 字符，兜底给飞书（如果 result 没给错误细节）
        stderrTail = (stderrTail + "\n" + msg).slice(-500);
      }
    });

    claude.on("exit", (code) => {
      console.log(
        `[fcb] claude exited chat=${chatId} code=${code} sawResult=${sawResult} isError=${resultIsError}`
      );
      // 优先级：happy path → result.is_error 细节 → stderr 兜底 → 裸退出码
      if (code === 0 && finalText && !resultIsError) {
        sendToFeishu(chatId, finalText);
      } else if (resultIsError && errorDetails) {
        sendToFeishu(chatId, `❌ Claude Code 出错 (code=${code})\n${errorDetails}`);
      } else if (code === 0 && !sawResult) {
        sendToFeishu(chatId, "⚠️ Claude Code 正常退出但未产生 result 消息");
      } else if (stderrTail) {
        sendToFeishu(chatId, `❌ Claude Code 退出码 ${code}\nstderr: ${stderrTail.trim()}`);
      } else {
        sendToFeishu(chatId, `❌ Claude Code 退出码 ${code}`);
      }
      resolve();
    });

    claude.on("error", (err) => {
      console.error(`[fcb] claude spawn error:`, err);
      sendToFeishu(chatId, `❌ 无法启动 Claude Code: ${err.message}`);
      resolve();
    });
  });
}

// Claude Code --output-format stream-json 的事件类型（按需扩展）
type StreamJsonMessage =
  | { type: "system"; subtype: string; session_id?: string; [k: string]: unknown }
  | { type: "assistant"; message?: { content?: unknown }; [k: string]: unknown }
  | { type: "user"; [k: string]: unknown }
  | { type: "result"; result?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

// ─── feishu event routing ────────────────────────────────────────────────────

// 飞书开平事件 envelope（经 Step 1 裸跑 lark-cli event +subscribe 实测确认）：
//   { schema: "2.0", header: { event_type, event_id, app_id, ... }, event: { message, sender } }
// 其中 event.message.message_type 是字段名（不是 msg_type）
type LarkEventEnvelope = {
  schema?: string;
  header?: {
    event_type?: string;
    event_id?: string;
    app_id?: string;
    tenant_key?: string;
    create_time?: string;
  };
  event?: {
    sender?: {
      sender_id?: { open_id?: string; union_id?: string; user_id?: string | null };
      sender_type?: string; // "user" | "bot" | ...
      tenant_key?: string;
    };
    message?: {
      chat_id?: string;
      chat_type?: string; // "p2p" | "group"
      content?: string; // JSON string; schema depends on message_type
      create_time?: string;
      message_id?: string;
      message_type?: string; // "text" | "image" | "file" | "post" | ...
      update_time?: string;
    };
  };
};

function extractText(message: NonNullable<LarkEventEnvelope["event"]>["message"]): string | null {
  if (!message || message.message_type !== "text") return null;
  if (!message.content) return null;
  try {
    const parsed = JSON.parse(message.content) as { text?: string };
    return parsed.text?.trim() || null;
  } catch {
    return null;
  }
}

function handleIncomingEvent(envelope: LarkEventEnvelope) {
  const inner = envelope.event;
  const senderId = inner?.sender?.sender_id?.open_id;
  const chatId = inner?.message?.chat_id;

  if (!senderId || !OWNER_OPEN_IDS.has(senderId)) {
    if (senderId) {
      console.log(`[fcb] reject non-whitelisted sender=${senderId}`);
    }
    return;
  }
  if (!chatId) {
    console.log(`[fcb] event missing chat_id`);
    return;
  }

  const text = extractText(inner?.message);
  if (!text) {
    sendToFeishu(chatId, "暂不支持该消息类型，只识别纯文本");
    return;
  }

  // 元指令路由
  if (text === "/new" || text.startsWith("/new ")) {
    resetInteractiveSession(chatId);
    sendToFeishu(chatId, "✅ 已重置会话，下一条消息开新 session");
    return;
  }

  if (text === "/model" || text.startsWith("/model ")) {
    handleModelCommand(chatId, text.slice("/model".length).trim());
    return;
  }

  const { id: sessionId, started } = getOrCreateInteractiveSession(chatId);
  enqueueClaudeRun(chatId, sessionId, text, { isFreshSession: !started });
}

function handleModelCommand(chatId: string, arg: string) {
  // 无参数：查询当前模型
  if (!arg) {
    const current = getChatModel(chatId);
    const isOverride = chatModels[chatId] !== undefined;
    sendToFeishu(
      chatId,
      `当前频道模型: ${current}${isOverride ? " (覆盖)" : " (默认)"}\n` +
        `用法:\n` +
        `  /model opus       切换到 opus 别名（→ ANTHROPIC_DEFAULT_OPUS_MODEL）\n` +
        `  /model sonnet     切换到 sonnet 别名（→ ANTHROPIC_DEFAULT_SONNET_MODEL）\n` +
        `  /model haiku      切换到 haiku 别名（→ ANTHROPIC_DEFAULT_HAIKU_MODEL）\n` +
        `  /model <完整 id>  例如 claude-opus-4-7\n` +
        `  /model reset      清除覆盖，回到全局默认 (${CLAUDE_MODEL})\n` +
        `\n` +
        `注意：切换模型会重置当前频道的对话上下文（跨 model family 的 thinking block\n` +
        `签名不兼容，续传会被 API 拒绝）。如需保留上下文请别切换，或在 TODO.md 里\n` +
        `跟踪 per-(chat,model) session 隔离的改进。`
    );
    return;
  }

  // 目标 model：要么是 arg，要么是全局默认（reset 场景）
  const nextModel =
    arg === "reset" || arg === "default" ? CLAUDE_MODEL : arg;
  const prevModel = getChatModel(chatId);

  // reset：清除覆盖
  if (arg === "reset" || arg === "default") {
    delete chatModels[chatId];
    saveChatModels();
  } else {
    // 简单校验：限长 + 拒绝控制字符
    if (arg.length > 100 || /[\n\r\t]/.test(arg)) {
      sendToFeishu(chatId, "❌ 模型名称非法（过长或含控制字符）");
      return;
    }
    chatModels[chatId] = arg;
    saveChatModels();
  }

  // 关键：model 真的变了时必须重置 session。
  // 跨 model family 续传会触发 Anthropic API 的 "Invalid signature in thinking
  // block" 400（opus 的 extended thinking 历史 haiku 验证不过，反之亦然）。
  const modelChanged = prevModel !== nextModel;
  if (modelChanged) {
    resetInteractiveSession(chatId);
  }

  const hint =
    arg === "opus" || arg === "sonnet" || arg === "haiku"
      ? `（Claude Code 会解析为 ANTHROPIC_DEFAULT_${arg.toUpperCase()}_MODEL 配置的实际 id）`
      : "";
  const resetNote = modelChanged
    ? "\n⚠️ 由于切换了模型，已重置对话上下文（下条消息开新 session）"
    : "";

  if (arg === "reset" || arg === "default") {
    sendToFeishu(
      chatId,
      `✅ 已清除覆盖，回到全局默认模型: ${CLAUDE_MODEL}${resetNote}`
    );
  } else {
    sendToFeishu(
      chatId,
      `✅ 当前频道模型已切换到: ${arg}${hint}${resetNote}`
    );
  }
}

// ─── lark-cli event subscription daemon (with watchdog) ──────────────────────

let larkProc: ChildProcess | null = null;
let larkRetryMs = 1000;
let shuttingDown = false;

let larkRetryScheduled = false;

function scheduleLarkRetry() {
  if (shuttingDown) return;
  if (larkRetryScheduled) return; // error + exit 双 trigger 时只 schedule 一次
  larkRetryScheduled = true;
  console.error(`[fcb] will retry lark-cli in ${larkRetryMs}ms`);
  setTimeout(() => {
    larkRetryScheduled = false;
    startLarkSubscribe();
  }, larkRetryMs);
  larkRetryMs = Math.min(larkRetryMs * 2, 60_000);
}

function startLarkSubscribe() {
  if (shuttingDown) return;
  console.log(`[fcb] starting ${LARK_CLI} event +subscribe`);

  try {
    larkProc = spawn(LARK_CLI, [
      "event",
      "+subscribe",
      "--as",
      "bot", // bot-only（lark-cli event skill 的要求；user token 会被 validation 拒绝）
      "--filter",
      "im.message.receive_v1",
    ]);
  } catch (err) {
    // spawn 在 binary 不存在时会 synchronously throw（Bun 行为），watchdog 必须接住
    console.error(`[fcb] lark-cli spawn threw synchronously:`, err);
    larkProc = null;
    scheduleLarkRetry();
    return;
  }

  if (!larkProc.stdout || !larkProc.stderr) {
    console.error("[fcb] lark-cli spawn missing stdio");
    scheduleLarkRetry();
    return;
  }

  createInterface({ input: larkProc.stdout }).on("line", (line) => {
    if (!line) return;
    try {
      const envelope = JSON.parse(line) as LarkEventEnvelope;
      handleIncomingEvent(envelope);
    } catch (err) {
      console.error(`[fcb] event parse error:`, err, `line=${line.slice(0, 200)}`);
    }
  });

  larkProc.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[lark-cli] ${msg}`);
  });

  larkProc.on("error", (err) => {
    console.error(`[fcb] lark-cli spawn error:`, err);
    scheduleLarkRetry();
  });

  larkProc.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[fcb] lark-cli exited code=${code} signal=${signal}`);
    scheduleLarkRetry();
  });

  // 稳定运行 30 秒后重置退避
  setTimeout(() => {
    if (larkProc && !larkProc.killed) larkRetryMs = 1000;
  }, 30_000);
}

// ─── cron scheduling ─────────────────────────────────────────────────────────
// 关键：cron 每次独立 session（Codex consult 指出的架构修正）
// 定时任务不能复用 chat 的交互 session，否则跨 run 上下文会污染

for (const job of cronJobs) {
  if (!cron.validate(job.cron)) {
    console.error(`[fcb] skipping cron job "${job.id}": invalid expr "${job.cron}"`);
    continue;
  }
  if (!job.chat_id || !OWNER_OPEN_IDS.has(job.chat_id)) {
    // 注意：cron 的 chat_id 通常是用户自己的 open_id 作为"私聊频道 id"
    // 这里校验只是 sanity check；实际飞书 chat_id 格式 ou_xxx（p2p）或 oc_xxx（群）
    // 如果是群 id，会走 OWNER_OPEN_IDS.has 失败 —— 但私聊场景下 chat_id 就是对方 open_id
    // MVP 只支持私聊，所以 chat_id 应该在白名单里
    console.warn(`[fcb] cron job "${job.id}" chat_id=${job.chat_id} not in owner whitelist`);
  }
  cron.schedule(job.cron, () => {
    // cron 每次全新 session_id（Codex consult 指出的架构修正 —— 不复用聊天 session）
    // 既然是全新 uuid，永远是 fresh（用 --session-id 新建）
    const freshSessionId = randomUUID();
    console.log(`[fcb] cron fire job=${job.id} sid=${freshSessionId}`);
    enqueueClaudeRun(job.chat_id, freshSessionId, job.prompt, { isFreshSession: true });
    // ↑ 注意：cron 也走 enqueueClaudeRun 做串行化
    //   per-chat 队列 key 是 chat_id，不是 session_id —— 所以同 chat_id 的 cron trigger
    //   和交互消息仍会互等。这是刻意的，避免并发打到飞书上让用户困惑。
  });
  console.log(`[fcb] cron scheduled id=${job.id} cron="${job.cron}"`);
}

// ─── graceful shutdown ───────────────────────────────────────────────────────

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[fcb] received ${sig}, shutting down`);
    shuttingDown = true;
    larkProc?.kill();
    // 给 in-flight claude 进程一点时间自然退出，然后强制退出
    setTimeout(() => process.exit(0), 2000);
  });
}

// ─── go ──────────────────────────────────────────────────────────────────────

console.log(
  `[fcb] bridge started | whitelist=${OWNER_OPEN_IDS.size} chats=${Object.keys(sessions).length} crons=${cronJobs.length} model=${CLAUDE_MODEL}`
);
startLarkSubscribe();
