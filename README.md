# feishu-claude-bridge

> Co-author：Claude Opus 4.7

把 **飞书** 变成 **Claude Code CLI** 的远程对讲机。人在外面、机器在家里：飞书 @bot 发消息 → 家里的 Mac 跑 Claude Code → 结果推回飞书。

**能干什么**：

- 远程调度家里/公司 Mac 的 Claude Code，做文件操作、跑脚本、审 diff、查日志
- 每个飞书频道保持独立上下文（长对话不断线）
- per-频道切模型（`/model haiku` 省钱、`/model opus` 认真活）
- 定时任务："每天 9 点扫 `/var/log` 里的 ERROR 发我飞书摘要"

**不是什么**：不是通用聊天机器人；不是多租户 SaaS；是**单人单机自用**的 personal remote。

**架构**：

```
lark-cli event +subscribe              # 长连接接飞书事件（NDJSON stdout）
        ↓
bridge.ts (本项目)                     # 路由 + 白名单 + session 管理 + cron
        ↓
claude -p --session-id <uuid>          # Claude Code 干活
        ↓
lark-cli im +messages-send             # Claude 用 skill 发消息回飞书
```

**目录**：[安全前置](#-装之前读完这段) · [前置条件](#前置条件) · [Step 0 飞书应用](#step-0飞书应用--lark-cli-配置一次性-30-分钟) · [Step 1 克隆](#step-1克隆--装依赖) · [Step 2 跑起来](#step-2跑起来) · [飞书里能发什么](#飞书里能发什么) · [故障排查](#故障排查) · [进阶（tmux / 自启 / 定时任务）](#进阶长期运行--定时任务)

---

## ⚠️ 装之前读完这段

本 bridge 默认开 `--dangerously-skip-permissions`，Claude Code **不会问你"要跑这个 `rm -rf` 吗"**。唯一防线是 `FCB_OWNER_OPEN_IDS` 白名单 + 你飞书账号本身的安全。

威胁清单：

- 你的飞书账号被盗 → 攻击者能在这台 Mac 上跑任意命令（`rm -rf ~`、读 `~/.aws/credentials`、`git push --force`、读写任何 Claude 能读写的文件）
- 因此 **强烈建议：飞书账号开启 2FA**
- **只适合单机、单人、自用场景**。多人共用 = 共享 sudo，不要这么干
- plist 里存 `ANTHROPIC_API_KEY` 是 plaintext-at-rest。在意的话用 `launchctl setenv` 或 Keychain 注入（文档里有写）

觉得 bypass 太冒险？见仓库 Issue 区 "分层审批 / 飞书卡片审批" 的 Future Work 讨论。

---

## 前置条件

1. **macOS**（只在进阶 LaunchAgent 用到；bridge 代码本身 Linux 也跑，自启机制自己换）
2. **Bun** `>= 1.0` — `curl -fsSL https://bun.sh/install | bash`
3. **Claude Code CLI** —  `claude --version` 在你 shell 里能跑
   - 下载：https://claude.com/claude-code
   - `claude` 不在 PATH 里 → 用 `FCB_CLAUDE_CLI=/absolute/path/to/claude` 覆盖
4. **Claude API 凭证** 二选一：
   - Anthropic 官方：在 `.env`（Step 2 会建）里填 `ANTHROPIC_API_KEY=sk-ant-xxx`
   - 第三方 Anthropic-compatible provider：`.env` 里再填 `ANTHROPIC_BASE_URL=https://...` + 对应 model 映射
5. **飞书自建应用** 已注册 + **lark-cli** 已装并 OAuth 登录（下面 Step 0 教）

---

## Step 0：飞书应用 + lark-cli 配置（一次性 ~30 分钟）

### 0.1 在飞书开放平台创建企业自建应用

1. 打开 https://open.feishu.cn/app
2. 创建 → "企业自建应用"
3. 能力启用：
   - [x] 机器人
   - [x] 消息订阅
4. 事件订阅 → 订阅方式选 **「长连接模式」**（不是回调 URL！）
5. 订阅事件：`im.message.receive_v1`（接收消息）
6. 权限（「权限管理」→ 申请下面几个）：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:chat`
7. 发布应用（企业内部发布即可）
8. 记下 **App ID** 和 **App Secret**

### 0.2 本地装 lark-cli

```bash
npm install -g @larksuite/cli
```

### 0.3 登录并拿到你的 open_id

```bash
lark-cli config init            # 交互式输入 App ID + Secret
lark-cli auth login --recommend # 走 OAuth
lark-cli auth login status      # 验证

# 用你的邮箱或姓名搜自己的 open_id，形如 ou_xxxxxxxxxxxxxxxxxxxx
lark-cli contact +users-search --query "你的邮箱或姓名"
```

### 0.4 验证能发消息

```bash
lark-cli im +messages-send --as bot --user-id ou_YOUR_OPEN_ID --text "hi from cli"
```

自己的飞书应该收到。收不到说明应用权限 / App Secret / 白名单有一项没配对。

---

## Step 1：克隆 + 装依赖

```bash
git clone https://github.com/amber-ai-sketch/feishu-claude-bridge.git
cd feishu-claude-bridge
bun install
```

---

## Step 2：跑起来

```bash
# 1. 填 env（.env 在 .gitignore 里，不会入 repo）
cp .env.example .env
vim .env
# 必填：FCB_OWNER_OPEN_IDS=你的 ou_xxx（Step 0.3 拿到的）
# 必填：ANTHROPIC_API_KEY=sk-ant-xxx（或 Anthropic-compatible provider 的凭证组合）

# 2. 跑（Bun 自动读项目根 .env，不用 source）
bun run bridge.ts
```

终端应该看到：

```
[fcb] bridge started | whitelist=1 chats=0 crons=0 model=opus
[fcb] starting lark-cli event +subscribe
[lark-cli] Connected. Waiting for events...
```

`whitelist=1` + `Connected.` = OK。飞书私聊 bot 发"pwd"，30 秒内应收到当前目录。

**到这里主流程跑通**。长期运行（tmux / 自启 / 定时任务）见文末[进阶](#进阶长期运行--定时任务)章节。

---

## 飞书里能发什么

### 普通消息
直接发文本，bridge 转给 Claude Code，Claude 干完把结果回发。每个飞书频道维持一个长 Claude session，下一条消息自动续接上下文。

### 元指令

| 指令 | 作用 |
|---|---|
| `/new` | 重置当前频道的 Claude session（下一条消息开新对话） |
| `/model` | 查当前频道用的模型 |
| `/model opus` | 切到 opus 别名（Claude Code 会解析成 `ANTHROPIC_DEFAULT_OPUS_MODEL`） |
| `/model sonnet` | 切 sonnet |
| `/model haiku` | 切 haiku，省 token |
| `/model claude-opus-4-7` | 直接写完整 model id |
| `/model reset` | 清除覆盖，回到全局默认（`FCB_CLAUDE_MODEL`） |

---

## 配置项速查

所有配置都走环境变量。完整列表见 `.env.example`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `FCB_OWNER_OPEN_IDS` | **必填** | 逗号分隔的 open_id 白名单。未设置 bridge 拒绝启动。 |
| `ANTHROPIC_API_KEY` | 无 | Claude Code 用 |
| `FCB_CLAUDE_MODEL` | `opus` | 默认模型 alias，可被 `/model` 覆盖 |
| `FCB_STATE_DIR` | `~/.local/state/fcb` | sessions.json / crontab.json / chat-models.json 存放位置 |
| `FCB_LARK_CLI` | `lark-cli` | lark-cli 可执行路径（测试时可指 fake-event.ts） |
| `FCB_CLAUDE_CLI` | `claude` | claude 可执行路径 |
| `ANTHROPIC_BASE_URL` | 无 | 走第三方 provider 时用 |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` | 无 | 走第三方 provider 时的 alias→实际 id 映射 |

---

## 故障排查

### bridge 启动后几秒就退出

看 log：

```bash
tail -f ~/.local/state/fcb/bridge.log
tail -f ~/.local/state/fcb/bridge.err.log
```

常见两种：
1. `FATAL: FCB_OWNER_OPEN_IDS 未配置` → env 没设
2. `lark-cli exited code=...` → lark-cli 没装 / 没登录 / 应用凭证失效

### 飞书发消息没反应

顺着链路查：

```bash
# 1. bridge 有没有收到事件？
tail -f ~/.local/state/fcb/bridge.log | grep -E "new interactive|reject|event parse"

# 2. 裸跑 lark-cli 确认事件订阅正常
lark-cli event +subscribe --as bot --filter "im.message.receive_v1"
# 然后飞书发消息，看终端有没有 NDJSON 打出来

# 3. 手动验证 lark-cli 发消息能不能工作
lark-cli im +messages-send --as bot --user-id ou_YOUR_OPEN_ID --text "manual test"
```

### `claude` CLI 报错 / 找不到

如果你只在 VSCode 里用过 Claude Code，`/opt/homebrew/bin/claude` 可能 symlink 到 `.exe`（Windows binary，没执行权限）。修法：

```bash
# 重新指向 darwin binary（版本号按实际的改）
rm -f /opt/homebrew/bin/claude
ln -s ~/.vscode/extensions/anthropic.claude-code-<VERSION>-darwin-arm64/resources/native-binary/claude /opt/homebrew/bin/claude
claude --version   # 验证
```

VSCode extension 升级后版本号会变，旧目录被清理，symlink 又坏。届时要么重 ln，要么用 `FCB_CLAUDE_CLI=/absolute/path/to/claude` 环境变量跳开。

### 走第三方 Anthropic-compatible provider 报 `Param Incorrect: Not supported model`

默认 `ANTHROPIC_MODEL` 可能是 provider 不认的 id（比如 `claude-opus-4-6-thinking`）。bridge 默认传 `--model opus` 别名，Claude Code 会按 `ANTHROPIC_DEFAULT_OPUS_MODEL` 解析成 provider 支持的实际 id。省成本改 `FCB_CLAUDE_MODEL=sonnet` 或 `haiku`。

### `lark-cli event +subscribe` 被 validation 拒绝

必须加 `--as bot`（bridge 内部已加）。user token 会被拒。

### 非白名单的人能触发 bridge？

**永远不应该**。log 里 `reject non-whitelisted sender=...` 说白名单工作正常。如果陌生 sender 真触发了 claude：

1. `launchctl stop com.yourname.fcb` 停 bridge（或直接 `pkill -f "bun run bridge.ts"`）
2. 看 log 找原因
3. 把 bridge 的 `handleIncomingEvent` 逻辑贴给人审一遍
4. 提 issue

---

## 进阶：长期运行 + 定时任务

主流程 Step 0–2 让 bridge 在前台跑起来。下面三节让它 **脱离终端活着** / **崩了自己拉** / **按时钟自己触发任务**。**都是可选的，不做也能正常用。**

**选型建议：**
- 代码还在迭代、随时想改代码重启 → 用 **A. tmux**
- 功能稳了、想当工具 7×24 挂着 → 用 **B. LaunchAgent**
- 想定点触发任务（每天 9 点汇总日志等）→ **C** 和 A/B 可叠加

### A. tmux 后台跑（推荐，迭代期用）

目的：bridge 活到你主动 kill 为止（包括你关掉当前终端），想看实时 log 随时 `tmux attach` 进去。代价：Mac 重启后 tmux session 会丢，需要手动重起。

**首次装 + 起**：

```bash
brew install tmux   # 没装过的话

# 前提：Step 2 里已经 cp .env.example .env 并填了 FCB_OWNER_OPEN_IDS
# bun 跑 bridge.ts 时会自动读项目根的 .env，所以 tmux 命令里不用再塞 env var
tmux new-session -d -s fcb -c ~/Projects/feishu-claude-bridge \
  "bun run bridge.ts 2>&1 | tee -a ~/.local/state/fcb/bridge.log"
```

**强烈推荐把这段 alias 塞到 `~/.zshrc`**，以后一个词搞定：

```bash
# fcb = feishu-claude-bridge 简写
alias fcb-start='tmux new-session -d -s fcb -c ~/Projects/feishu-claude-bridge "bun run bridge.ts 2>&1 | tee -a ~/.local/state/fcb/bridge.log"'
alias fcb-stop='tmux kill-session -t fcb'
alias fcb-restart='fcb-stop 2>/dev/null; fcb-start'
alias fcb-log='tail -f ~/.local/state/fcb/bridge.log'
alias fcb-attach='tmux attach -t fcb'
```

装完 `source ~/.zshrc` 生效。日常就这五个：

| 命令 | 作用 |
|---|---|
| `fcb-start` | 在 tmux session 里起 bridge |
| `fcb-log` | 不进 tmux，实时看 log |
| `fcb-attach` | 进 tmux session（Ctrl-b 再按 d 脱离、不杀 bridge） |
| `fcb-restart` | 改了代码后重启 bridge |
| `fcb-stop` | 停 bridge |

判活一眼：`tmux list-sessions` 看到 `fcb:` 就是还活着。

### B. LaunchAgent 自启（macOS，稳定期用）

目的：登录自动起、崩了自动拉、Mac 重启不丢。

```bash
# 1. 复制 plist 模板到 LaunchAgents 目录
cp com.example.fcb.plist.template ~/Library/LaunchAgents/com.yourname.fcb.plist

# 2. 替换模板变量（注意 launchd 不展开 ~，必须绝对路径）
sed -i '' "s|{{HOME}}|$HOME|g" ~/Library/LaunchAgents/com.yourname.fcb.plist
sed -i '' "s|{{FCB_OWNER_OPEN_IDS}}|ou_YOUR_OPEN_ID|g" ~/Library/LaunchAgents/com.yourname.fcb.plist
sed -i '' "s|{{ANTHROPIC_API_KEY}}|sk-ant-xxxxx|g" ~/Library/LaunchAgents/com.yourname.fcb.plist
# （也可以把 Label 从 com.example.fcb 改成 com.yourname.fcb 保持一致）

# 3. 加载
launchctl load ~/Library/LaunchAgents/com.yourname.fcb.plist
launchctl start com.yourname.fcb

# 4. 看 log
mkdir -p ~/.local/state/fcb
tail -f ~/.local/state/fcb/bridge.log

# 5. 重启 Mac 验证自启
```

更安全的 API key 注入方式（不明文落盘到 plist）：

```bash
# 从 plist 里删掉 ANTHROPIC_API_KEY 那对 key/string，然后：
launchctl setenv ANTHROPIC_API_KEY sk-ant-xxxxx
launchctl unload ~/Library/LaunchAgents/com.yourname.fcb.plist
launchctl load ~/Library/LaunchAgents/com.yourname.fcb.plist
```

卸载：

```bash
launchctl unload ~/Library/LaunchAgents/com.yourname.fcb.plist
```

### C. 定时任务（可选）

目的：按 cron 表达式触发 Claude（比如"每天 9 点扫一遍日志，结果发我飞书"）。**走独立 session**，不污染你在飞书里的交互对话上下文。

手改 `~/.local/state/fcb/crontab.json`（bridge 启动时读取）：

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

保存后重启 bridge 让 cron 表生效：

```bash
# 如果用 tmux（A）：
fcb-restart   # 如果配了 alias；或展开成：
# tmux kill-session -t fcb; tmux new-session -d -s fcb -c ~/Projects/feishu-claude-bridge \
#   "bun run bridge.ts 2>&1 | tee -a ~/.local/state/fcb/bridge.log"

# 如果用 LaunchAgent（B）：
launchctl stop com.yourname.fcb && launchctl start com.yourname.fcb

# 如果前台跑：Ctrl+C 后重新 bun run bridge.ts
```

**注意**：飞书里动态管 cron（`/cron add ...`）还没实现，目前只能改这个 JSON 文件。见 `TODO.md`（仓库 Issue 区欢迎讨论）。

---

## 开发 / 调试

**不连飞书，本地测路由逻辑**（改 bridge.ts 时用）：

```bash
FCB_OWNER_OPEN_IDS=ou_test \
FCB_LARK_CLI="$(pwd)/fake-event.ts" \
bun run bridge.ts
```

bridge 会 spawn `fake-event.ts` 当假 lark-cli，依次喂几条测试事件：白名单命中的 text、白名单外的消息、image 类型、`/new` 等。log 里看 bridge 行为。

**preflight 失败**：bridge 启动时会 spawnSync `claude --version` 和 `lark-cli --version`，任一失败 FATAL exit 1。典型触发：VSCode Claude Code 插件升级后 `/opt/homebrew/bin/claude` symlink 指向已删除目录 —— 按故障排查那节重建 symlink。

---

## 给 AI Agent 的部署指引

如果你是 AI agent 被要求"帮我把这个装到机器上"，流程拆成两段：

**第一段（必须人工 + 浏览器）**：Step 0.1 在飞书开放平台创建应用、配权限、发布 —— 向人要 App ID + App Secret 再继续。

**第二段（你可以全自动）**：

```bash
# 装 lark-cli + 登录（lark-cli config init 是交互式，需要让用户把 App ID/Secret 贴到你的 prompt）
npm install -g @larksuite/cli
# 或者把 App ID/Secret 直接写到 ~/.lark-cli/config.json（schema 见 lark-cli 文档）

lark-cli auth login --recommend    # 这步会开浏览器 OAuth，需要人配合
lark-cli contact +users-search --query "用户提供的邮箱或姓名"   # 拿 open_id

# clone + install
git clone https://github.com/amber-ai-sketch/feishu-claude-bridge.git ~/Projects/feishu-claude-bridge
cd ~/Projects/feishu-claude-bridge
bun install

# 填 .env
cp .env.example .env
sed -i '' "s|^FCB_OWNER_OPEN_IDS=$|FCB_OWNER_OPEN_IDS=ou_XXX|" .env
sed -i '' "s|^ANTHROPIC_API_KEY=$|ANTHROPIC_API_KEY=sk-ant-XXX|" .env

# 前台跑一次自测 + 让用户飞书发 "pwd" 验证
bun run bridge.ts
# 看到 `whitelist=1` + `Connected.` 就 OK
# 用户验证通过 Ctrl+C 后，按 README 进阶 A 装 tmux alias
```

自测必做：每次改完或重启前 `claude --version` / `lark-cli --version` 各跑一次，验证外部 CLI 活着；bridge 启动日志里 `whitelist=N` 的 N 应等于 `FCB_OWNER_OPEN_IDS` 逗号分隔的个数。

---

## License

MIT，见 `LICENSE`。

## 鸣谢

- [Claude Code](https://claude.com/claude-code) — Anthropic 官方 CLI
- [@larksuite/cli](https://github.com/larksuite/cli) — 飞书官方 CLI
- 初始架构 review 由 [Codex CLI](https://github.com/openai/codex) consult 模式出力
