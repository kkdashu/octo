# 清理 Session / 清理会话 功能

## 问题描述

用户需要一种方式来清理某个群的 AI session，让 AI 从新的 session 开始后续对话。

Claude Agent SDK 支持 `/clear` slash command，用于清除对话历史并开启新 session。

## 需求

1. 只有主群可以执行清理 session 操作
2. 主群可以说"清理 xxx 群的 session"或"清理 xxx 群的会话"
3. 被清理 session 的群会丢失之前的 session 历史，下次消息会启动新 session

## 对现有项目的影响

### 需要修改的文件

- `src/tools.ts` - 添加 `clear_context` 工具（主群专用）
- `src/group-queue.ts` - 添加关闭指定群 active session 的方法
- `src/db.ts` - 已有 `deleteSessionId`，无需修改

### 实现方案

#### 1. 添加 `clear_context` 工具

在 `tools.ts` 的 `mainOnlyTools` 中添加新工具：

```typescript
{
  name: "clear_context",
  description: "Clear conversation context for a target group. This will delete the session and start fresh on next message.",
  schema: {
    type: "object",
    properties: {
      targetGroupFolder: { type: "string", description: "Target group folder name" },
    },
    required: ["targetGroupFolder"],
  },
  handler: async (args) => {
    // 1. 验证目标群是否存在
    // 2. 删除数据库中的 session ID
    // 3. 如果有 active session，通知 GroupQueue 关闭
    // 4. 返回成功消息
  },
}
```

#### 2. GroupQueue 添加关闭 session 的方法

在 `GroupQueue` 中添加：

```typescript
/** Clear session for a group (called by clear_context tool) */
async clearGroupSession(groupFolder: string): Promise<boolean> {
  // 1. 删除数据库中的 session ID
  // 2. 如果有 active session，关闭它
  // 3. 返回是否成功
}
```

#### 3. 工具如何访问 GroupQueue

当前 `tools.ts` 中的 handler 无法直接访问 `GroupQueue` 实例。需要修改：

方案：通过 `MessageSender` 接口扩展，添加 `clearSession` 方法：

```typescript
export interface MessageSender {
  send(chatJid: string, text: string): Promise<void>;
  sendImage(chatJid: string, filePath: string): Promise<void>;
  refreshGroupMetadata(): Promise<{ count: number }>;
  clearSession?(groupFolder: string): Promise<boolean>; // 新增
}
```

然后在 `group-queue.ts` 中实现此方法，并在创建 tools 时传入。

## 交互流程

```
主群用户: @octo 清空 test-group 的上下文

AI 识别意图 → 调用 clear_context 工具
clear_context:
  1. 验证 test-group 存在
  2. 调用 sender.clearSession("test-group")
  3. 返回 "test-group 的 session 已清理"

sender.clearSession:
  1. deleteSessionId(db, "test-group")
  2. 如果有 active session，调用 session.close()
  3. 从 activeSessions Map 中删除

test-group 下次发消息:
  → 没有 resumeSessionId，启动新 session
  → 对话历史从零开始
```

## Todo List

- [ ] 扩展 `MessageSender` 接口，添加 `clearSession` 方法
- [ ] 在 `GroupQueue` 中实现 `clearSession` 方法
- [ ] 在 `tools.ts` 中添加 `clear_context` 工具
- [ ] 测试：清理 session 后，目标群启动新 session
