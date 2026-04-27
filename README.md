# feishu-claude-bridge

> Co-author：Claude Opus 4.7

把 **飞书** 变成 **Claude Code CLI** 的远程对讲机。

人在外面、机器在公司内网：飞书 @bot 发消息触发 Claude Code，Claude 跑完把结果推回飞书。支持定时任务（"每天 9 点汇总错误日志"），支持续接对话上下文（每个飞书频道对应一个长期 Claude session）。

完整设计文档见 `~/.gstack/projects/Projects/ym-feishu-claude-bridge-design-*.md`。

---

## 架构

```
lark-cli event +subscribe              # 长连接接飞书事件（NDJSON stdout）
        ↓
bridge.ts (本项目)                     # 路由 + 白名单 + session 管理 + cron
        ↓
claude -p --session-id <uuid>          # Claude Code 干活
        ↓
lark-cli im +messages-send             # Claude 用 skill 发消息回飞书
```

Session 模型：
- **交互式消息**（你在飞书发的）→ 每个 `chat_id` 对应一个长 session，支持续传上下文
- **cron 定时任务** → 每次独立 session（不污染你的聊天上下文）
- **`/new` 元指令** → 在飞书里发 `/new` 手动重置当前 chat 的 session

---

## ⚠️ 安全模型 —— 读了再装

本 bridge 默认开 `--dangerously-skip-permissions`，Claude Code **不会问你"要跑这个 rm -rf 吗"**。唯一防线是 `FCB_OWNER_OPEN_IDS` 白名单 + 你飞书账号。

威胁清单：
- 你的飞书账号被盗 → 攻击者能在这台 Mac 上跑任意命令（`rm -rf ~`、读 AWS 凭证、`git push --force`）
- 因此 **飞书账号必须开 2FA，不能有第二种**

如果觉得 bypass 太冒险，看设计文档 Section 12「Future Work」里"分层审批 + 飞书卡片"的升级方案。

---

## 前置条件

1. **macOS**（LaunchAgent 部分）
2. **Bun** `>= 1.0`（`curl -fsSL https://bun.sh/install | bash`）
3. **Claude Code CLI** 可通过 `claude` 命令直接调用（见"已知踩坑"段关于 symlink 的注意事项）
4. `ANTHROPIC_API_KEY` 配好（env 或 `~/.claude/settings.json`）
5. **飞书自建应用** 已在飞书开放平台注册（见"Step 0"）
6. **lark-cli** 已装并 OAuth 登录（见"Step 0"）

### 已知踩坑（第一次 setup 必读）

- **`claude` CLI 不在 PATH**：如果你只通过 VSCode extension 用 Claude Code，`/opt/homebrew/bin/claude` 的 symlink 可能指向一个 `.exe` Windows binary（没执行权限）。修法：
  ```bash
  # 重新指向 VSCode extension 里的 darwin binary（版本号按实际的改）
  rm -f /opt/homebrew/bin/claude
  ln -s ~/.vscode/extensions/anthropic.claude-code-2.1.120-darwin-arm64/resources/native-binary/claude /opt/homebrew/bin/claude
  claude --version   # 验证
  ```
  注意：VSCode extension 升级后版本号会变，旧目录会被清理，symlink 会坏。届时需要重新 ln。或者用 `FCB_CLAUDE_CLI=/absolute/path/to/claude` 环境变量显式指定。

- **Model ID 不兼容**：如果你的 `ANTHROPIC_BASE_URL` 走第三方 provider（例如内网 `http://model.mify.ai.srv/anthropic`），Claude Code 默认的 `claude-opus-4-6-thinking` 可能被拒（`Param Incorrect: Not supported model`）。bridge 默认传 `--model opus` 别名，让 Claude Code 根据 `ANTHROPIC_DEFAULT_OPUS_MODEL` 解析到 provider 支持的实际 id。想换 sonnet/haiku 省成本，用 `FCB_CLAUDE_MODEL=sonnet` 环境变量。

- **`lark-cli event +subscribe` 必须 `--as bot`**：默认 identity 走 user token 会被 validation 拒绝。bridge 内部已加这个 flag，手动裸跑时别忘了。

---

## Step 0：飞书应用 + lark-cli 配置（30 分钟，一次性）

### 0.1 在飞书开放平台创建企业自建应用

1. 打开 https://open.feishu.cn/app
2. 创建 → "企业自建应用"
3. 能力启用：
   - [x] 机器人
   - [x] 消息订阅
4. 事件订阅 → 订阅方式选 **「长连接模式」**（不是回调 URL！）
5. 订阅事件：`im.message.receive_v1`（接收消息）
6. 权限：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:chat`
7. 发布应用（企业内部发布即可）
8. 记下 **App ID** 和 **App Secret**

### 0.2 本地装 lark-cli

```bash
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g   # 装 skill 到 ~/.claude/skills/（Claude Code 自动加载）
```

### 0.3 登录

```bash
lark-cli config init   # 交互式输入 App ID + Secret
lark-cli auth login --recommend
lark-cli auth login status   # 验证
```

### 0.4 拿到你自己的 open_id

```bash
# 把你的邮箱/姓名换进去
lark-cli contact +users-search --query "你的邮箱或姓名"
# 找到自己的 open_id，形如 ou_xxxxxxxxxxxxxxxxxxxx
```

### 0.5 验证能发消息

```bash
lark-cli im +messages-send --as bot --user-id ou_YOUR_OPEN_ID --text "hi from cli"
```

自己的飞书应该收到。

---

## Step 0.5：Claude session 稳定性 spike（30 分钟，Codex consult 建议）

**这一步是"写 bridge 之前先验 Claude Code 的 session/resume 没坑"。** 不做就开工可能埋暗雷。

```bash
SID=$(uuidgen)
echo "test session: $SID"

# 先记个事
claude -p --session-id "$SID" --dangerously-skip-permissions "记住 FOO=42"

# 续传验证
claude -p --session-id "$SID" --dangerously-skip-permissions "重复 FOO 的值"
# 应该回 42

# 读文件验证
echo "hello world" > /tmp/fcb-test.txt
claude -p --session-id "$SID" --dangerously-skip-permissions "读 /tmp/fcb-test.txt"

# 显式重置语义
claude -p --session-id "$SID" --dangerously-skip-permissions "忽略上文，从零开始。2+2 等于几？"

# 最终结果格式验证
claude -p --session-id "$SID" --dangerously-skip-permissions \
  --output-format stream-json --include-partial-messages "hi" \
  | head -20
# 看 type === "result" 的 message 长什么样，记下字段名（当前骨架假设是 msg.result）
```

判据：
- FOO=42 能续传回 ✓
- 文件读成功 ✓
- 重置指令让 Claude 真的"重新开始"（不坚持用 42）
- stream-json 里 `type === "result"` 有 `.result` 字段

如果全部正常，进 Step 1。如果哪个翻车，在 bridge.ts 里对应调整或停下来找原因。

---

## Step 1：裸跑 lark-cli 长连接（15 分钟）

> **本仓库初始开发时此步已跑过**。真实 NDJSON 事件 envelope 是：
> ```
> {
>   "schema": "2.0",
>   "header": {"event_type":"im.message.receive_v1", "event_id":..., "app_id":..., ...},
>   "event": {
>     "sender": {"sender_id": {"open_id":"ou_xxx", "union_id":"on_xxx"}, "sender_type":"user"},
>     "message": {"chat_id":"oc_xxx", "chat_type":"p2p", "content":"{\"text\":\"...\"}",
>                 "message_id":"om_xxx", "message_type":"text"}
>   }
> }
> ```
> 注意字段名是 **`message_type`**（不是 `msg_type`），而且所有字段都在 **顶层 `.event.*`** 下。`bridge.ts` 的 `LarkEventEnvelope` type 已对齐。如果飞书 schema 有变或你换了事件类型，重跑本步对齐。
> 另外 `lark-cli event +subscribe` 要加 `--as bot`（user 身份会被 validation 拒绝）。


```bash
lark-cli event +subscribe --filter "im.message.receive_v1"
```

在另一个飞书窗口给 bot 私聊 "test"。观察：
1. 终端是否打印 NDJSON（一行一个 JSON 事件）
2. 事件结构里真实字段名是什么（bridge 假设的是 `event.sender.sender_id.open_id` 和 `event.message.chat_id` / `event.message.msg_type` / `event.message.content`）
3. **如果字段名不一致** → 改 `bridge.ts` 里 `handleIncomingEvent` 和 `extractText` 的字段路径
4. **验证 3 秒 ack**：让 lark-cli 输出一条事件之后，别处理立刻按 Ctrl+Z 暂停这个进程 10 秒，然后再发第二条消息。观察：
   - 飞书会不会因为超时而重推第一条消息？
   - 如果会 → bridge 需要在收到事件立刻给 lark-cli 反馈（当前 bridge 没做这个，因为假设 lark-cli 内部自动 ack 了）

把真实的事件 JSON 存一份到 `reference/sample-event.json`（方便以后回忆字段名）。

---

## Step 2：装依赖 + 跑起来

```bash
cd ~/Projects/feishu-claude-bridge
bun install
```

### 本地 dev 模式

```bash
# 必须先 export 你的 open_id
export FCB_OWNER_OPEN_IDS=ou_YOUR_OPEN_ID

# 跑 bridge（自动起 lark-cli）
bun run bridge.ts
```

飞书私聊 bot："pwd"，观察日志。

### 不连飞书的本地测试（fake-event 模式）

把 fake-event.ts 当成 lark-cli：

```bash
export FCB_OWNER_OPEN_IDS=ou_test
export FCB_LARK_CLI="$(pwd)/fake-event.ts"
bun run bridge.ts
```

bridge 会 spawn fake-event.ts 做"假 lark-cli"，它会依次喂几条测试事件进来：
- 白名单命中的 text 消息 → bridge 应该调 claude（实际没 API 会失败，但路由逻辑能看）
- 白名单不命中的消息 → bridge 应该忽略
- image 类型 → bridge 应该回"只识别纯文本"
- `/new` → bridge 应该重置 session

看 bridge log 确认行为符合预期。

---

## Step 3：LaunchAgent 自启

```bash
# 1. 改 plist 里的路径和 env
cp com.ym.fcb.plist ~/Library/LaunchAgents/
vim ~/Library/LaunchAgents/com.ym.fcb.plist
# 把 FCB_OWNER_OPEN_IDS、ANTHROPIC_API_KEY 改成真的

# 2. 加载
launchctl load ~/Library/LaunchAgents/com.ym.fcb.plist
launchctl start com.ym.fcb

# 3. 看 log
mkdir -p ~/.local/state/fcb
tail -f ~/.local/state/fcb/bridge.log

# 4. 重启 Mac 验证自启
```

卸载：
```bash
launchctl unload ~/Library/LaunchAgents/com.ym.fcb.plist
```

---

## Step 4：定时任务

手改 `~/.local/state/fcb/crontab.json`：

```json
[
  {
    "id": "daily-error-log-summary",
    "cron": "0 9 * * *",
    "prompt": "扫一下 /var/log/app/ 下过去 24h 的 ERROR 级别日志，按 10 条以上聚合，给我一个中文摘要",
    "chat_id": "ou_YOUR_OPEN_ID"
  }
]
```

然后 restart bridge（LaunchAgent：`launchctl stop com.ym.fcb && launchctl start com.ym.fcb`）。

动态管理（飞书里 `/cron add ...`）是 Future Work，现阶段改配置文件。

---

## 配置项速查

| 环境变量 | 默认 | 说明 |
|---------|------|-----|
| `FCB_OWNER_OPEN_IDS` | **必填** | 逗号分隔的 open_id 白名单。未设置 bridge 拒绝启动。 |
| `FCB_STATE_DIR` | `~/.local/state/fcb` | sessions.json / crontab.json 存放位置 |
| `FCB_LARK_CLI` | `lark-cli` | lark-cli 可执行路径（测试时可指 fake-event.ts） |
| `FCB_CLAUDE_CLI` | `claude` | claude 可执行路径 |
| `ANTHROPIC_API_KEY` | 无 | claude 会用（不在 bridge 里直接读） |

---

## 故障排查

### bridge 启动后 flick 几秒就退出

看 log，最常见两种：
1. `FATAL: FCB_OWNER_OPEN_IDS 未配置` → env 没设
2. `lark-cli exited code=...` → lark-cli 本身没装 / 没登录 / 应用凭证失效

### 飞书发消息没反应

顺着链路查：

```bash
# 1. bridge 有没有收到事件？
tail -f ~/.local/state/fcb/bridge.log | grep -E "new interactive|reject|event parse"

# 2. 裸跑一下 lark-cli 确认事件订阅正常
lark-cli event +subscribe --filter "im.message.receive_v1"
# 然后飞书发消息，看终端有没有 NDJSON

# 3. 手动验证 lark-cli 发消息能不能工作
lark-cli im +messages-send --as bot --user-id ou_YOUR_OPEN_ID --text "manual test"
```

### claude 报错 "session not found"

第一次用某个 session_id，Claude Code 应该自动创建。如果报错可能是：
- Claude Code 版本太老不支持 `--session-id` flag
- session_id 不是合法 UUID（bridge 用 `randomUUID()` 所以应该没问题）

跑 `claude --version` 确认版本 ≥ 最近几个月。

### 非白名单的人能触发 bridge？

**永远不应该**。如果 log 里 `reject non-whitelisted sender=...` 说白名单工作正常。如果没有这条 log 但陌生 sender 真触发了 claude，立刻：
1. `launchctl stop com.ym.fcb` 停 bridge
2. 看 log 找原因
3. 把 bridge 的事件处理逻辑贴给人审一遍

---

## Future Work

见 design doc Section 12。关键的几项：
- **分层审批**：用 `--permission-prompt-tool` + MCP server 把危险 Bash 转飞书卡片审批
- **进度流式**：Claude Code 跑长任务时实时把 tool_use 推到飞书（需要先做 sendToFeishu 队列背压保护）
- **`/cron add`** 等元指令，从飞书动态管定时任务
- **长结果附件**：超过 N 字符上传飞书文件
- **群 @bot 触发**（当前 MVP 只支持私聊）

---

## 许可

自用，无许可。想搬走 fork 随意。
