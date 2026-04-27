#!/usr/bin/env bun
/**
 * fake-event.ts — dev 工具，模拟 lark-cli NDJSON 事件流
 *
 * 用法：
 *   1. 以 fake 模式启动 bridge：
 *        FCB_OWNER_OPEN_IDS=ou_test FCB_LARK_CLI="$(pwd)/fake-event.ts" bun run bridge.ts
 *      bridge 会把本脚本当成 lark-cli 跑，不实际连飞书。
 *
 *   2. 或者手动喂事件到 stdin：
 *        bun run fake-event.ts
 *      脚本会一秒喂一条测试事件到 stdout，结合 pipe 测试 bridge 的事件路由。
 *
 * 测试用例（自动模式）：
 *   - 白名单命中（ou_test） → bridge 应该调 claude
 *   - 白名单不命中（ou_intruder）→ bridge 应该忽略
 *   - 非 text 消息类型 → bridge 应该回"只识别纯文本"
 *   - /new 元指令 → bridge 应该重置 session
 */

// 与 bridge.ts 的 LarkEventEnvelope 保持同 shape（经 Step 1 实测确认）
type LarkFakeEvent = {
  schema: string;
  header: {
    event_type: string;
    event_id: string;
    app_id: string;
    create_time: string;
  };
  event: {
    sender: { sender_id: { open_id: string }; sender_type: string };
    message: {
      chat_id: string;
      chat_type: string;
      content: string; // JSON-encoded
      message_id: string;
      message_type: string;
      create_time: string;
    };
  };
};

function mkHeader(): LarkFakeEvent["header"] {
  return {
    event_type: "im.message.receive_v1",
    event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    app_id: "cli_fake",
    create_time: String(Date.now()),
  };
}

function mkTextEvent(openId: string, chatId: string, text: string): LarkFakeEvent {
  return {
    schema: "2.0",
    header: mkHeader(),
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: {
        chat_id: chatId,
        chat_type: "p2p",
        content: JSON.stringify({ text }),
        message_id: `om_${Math.random().toString(36).slice(2, 10)}`,
        message_type: "text",
        create_time: String(Date.now()),
      },
    },
  };
}

function mkImageEvent(openId: string, chatId: string): LarkFakeEvent {
  return {
    schema: "2.0",
    header: mkHeader(),
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: {
        chat_id: chatId,
        chat_type: "p2p",
        content: JSON.stringify({ image_key: "img_xxx" }),
        message_id: `om_${Math.random().toString(36).slice(2, 10)}`,
        message_type: "image",
        create_time: String(Date.now()),
      },
    },
  };
}

const WHITELIST_SENDER = "ou_test";
const INTRUDER_SENDER = "ou_intruder";
const MY_CHAT = "ou_test"; // 私聊时 chat_id = 对方 open_id

// intervalMs = 上一个 case 之后等多久；所有间隔加起来 ~3s，留充足时间给 bridge 处理
const testCases: Array<{ name: string; event: LarkFakeEvent; intervalMs: number }> = [
  {
    name: "whitelisted text msg",
    event: mkTextEvent(WHITELIST_SENDER, MY_CHAT, "你好"),
    intervalMs: 500,
  },
  {
    name: "intruder text msg (should be silently dropped)",
    event: mkTextEvent(INTRUDER_SENDER, MY_CHAT, "rm -rf /"),
    intervalMs: 600,
  },
  {
    name: "whitelisted image msg (should get 'only text' reply)",
    event: mkImageEvent(WHITELIST_SENDER, MY_CHAT),
    intervalMs: 600,
  },
  {
    name: "whitelisted /new meta command",
    event: mkTextEvent(WHITELIST_SENDER, MY_CHAT, "/new"),
    intervalMs: 600,
  },
  {
    name: "whitelisted /model (no arg, query current)",
    event: mkTextEvent(WHITELIST_SENDER, MY_CHAT, "/model"),
    intervalMs: 600,
  },
  {
    name: "whitelisted /model sonnet (set override)",
    event: mkTextEvent(WHITELIST_SENDER, MY_CHAT, "/model sonnet"),
    intervalMs: 600,
  },
  {
    name: "whitelisted text after /model (should spawn claude with model=sonnet)",
    event: mkTextEvent(WHITELIST_SENDER, MY_CHAT, "继续刚才的话题"),
    intervalMs: 600,
  },
  {
    name: "whitelisted /model reset (clear override)",
    event: mkTextEvent(WHITELIST_SENDER, MY_CHAT, "/model reset"),
    intervalMs: 600,
  },
];

async function main() {
  // 伪装成 "lark-cli event +subscribe" 的行为：argv 含 "event" 时进入流模式
  const isFakeLarkMode = process.argv.some((a) => a === "event") ||
                         process.argv.some((a) => a === "+subscribe");

  if (isFakeLarkMode) {
    // 模拟 lark-cli：间隔输出事件，然后停留（bridge 的 watchdog 不会重启，因为我们不 exit）
    for (const tc of testCases) {
      await new Promise((r) => setTimeout(r, tc.intervalMs));
      process.stderr.write(`[fake-lark] case: ${tc.name}\n`);
      process.stdout.write(JSON.stringify(tc.event) + "\n");
    }
    process.stderr.write("[fake-lark] all cases sent, idling (Ctrl+C to stop)\n");
    // 保持进程活跃，模拟 long-running lark-cli
    setInterval(() => {}, 1 << 30);
  } else {
    // 纯独立模式：直接打印到 stdout（可以 pipe 到 bridge stdin 测试）
    console.log("# fake-event.ts standalone mode");
    console.log("# pipe this to bridge for testing, or use FCB_LARK_CLI mode");
    for (const tc of testCases) {
      console.log(`# case: ${tc.name}`);
      console.log(JSON.stringify(tc.event));
    }
  }
}

main().catch((err) => {
  console.error("fake-event error:", err);
  process.exit(1);
});
