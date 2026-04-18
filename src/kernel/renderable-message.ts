import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type {
  CustomMessageEntry,
  SessionEntry,
  SessionManager,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import type {
  RuntimeMessageDelta,
  RuntimeRenderableBlock,
  RuntimeRenderableMessage,
} from "./types";

type BashExecutionMessageLike = {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  timestamp: number;
};

type CustomMessageLike = {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  timestamp: number;
};

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? "", null, 2);
  } catch {
    return String(value);
  }
}

function toImagePlaceholder(block: ImageContent): string {
  return `[image:${block.mimeType}]`;
}

function contentToTextBlocks(
  content: string | (TextContent | ImageContent)[],
): RuntimeRenderableBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }

    return { type: "text", text: toImagePlaceholder(block) };
  });
}

function contentToPlainText(
  content: string | (TextContent | ImageContent)[],
): string {
  return contentToTextBlocks(content)
    .filter((block): block is Extract<RuntimeRenderableBlock, { type: "text" }> =>
      block.type === "text"
    )
    .map((block) => block.text)
    .join("\n");
}

function assistantContentToBlocks(
  content: Array<TextContent | ThinkingContent | ToolCall>,
): RuntimeRenderableBlock[] {
  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }

    if (block.type === "thinking") {
      return { type: "thinking", text: block.thinking };
    }

    return {
      type: "tool_call",
      toolCallId: block.id,
      toolName: block.name,
      argsText: stringifyUnknown(block.arguments),
    };
  });
}

function isBashExecutionMessage(
  message: AgentMessage,
): message is AgentMessage & BashExecutionMessageLike {
  return message.role === "bashExecution";
}

function isCustomMessage(
  message: AgentMessage,
): message is AgentMessage & CustomMessageLike {
  return message.role === "custom";
}

function renderUserMessage(
  id: string,
  message: UserMessage,
): RuntimeRenderableMessage {
  return {
    id,
    role: "user",
    timestamp: message.timestamp,
    blocks: contentToTextBlocks(message.content),
  };
}

function renderAssistantMessage(
  id: string,
  message: AssistantMessage,
): RuntimeRenderableMessage {
  return {
    id,
    role: "assistant",
    timestamp: message.timestamp,
    blocks: assistantContentToBlocks(message.content),
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
  };
}

function renderToolResultMessage(
  id: string,
  message: ToolResultMessage,
): RuntimeRenderableMessage {
  return {
    id,
    role: "toolResult",
    timestamp: message.timestamp,
    blocks: [
      {
        type: "tool_result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        text: contentToPlainText(message.content),
        isError: message.isError,
      },
    ],
  };
}

function renderBashExecutionMessage(
  id: string,
  message: BashExecutionMessageLike,
): RuntimeRenderableMessage {
  return {
    id,
    role: "bashExecution",
    timestamp: message.timestamp,
    blocks: [
      {
        type: "bash",
        command: message.command,
        output: message.output,
        exitCode: message.exitCode,
        cancelled: message.cancelled,
      },
    ],
  };
}

function renderCustomMessage(
  id: string,
  message: CustomMessageLike,
): RuntimeRenderableMessage | null {
  if (!message.display) {
    return null;
  }

  return {
    id,
    role: "custom",
    timestamp: message.timestamp,
    customType: message.customType,
    blocks: [
      {
        type: "custom",
        customType: message.customType,
        text: contentToPlainText(message.content),
      },
    ],
  };
}

export function toRenderableMessage(
  id: string,
  message: AgentMessage,
): RuntimeRenderableMessage | null {
  if (message.role === "user") {
    return renderUserMessage(id, message as UserMessage);
  }

  if (message.role === "assistant") {
    return renderAssistantMessage(id, message as AssistantMessage);
  }

  if (message.role === "toolResult") {
    return renderToolResultMessage(id, message as ToolResultMessage);
  }

  if (isBashExecutionMessage(message)) {
    return renderBashExecutionMessage(id, message);
  }

  if (isCustomMessage(message)) {
    return renderCustomMessage(id, message);
  }

  return null;
}

function toRenderableCustomEntry(
  entry: CustomMessageEntry,
): RuntimeRenderableMessage | null {
  if (!entry.display) {
    return null;
  }

  return {
    id: entry.id,
    role: "custom",
    timestamp: entry.timestamp,
    customType: entry.customType,
    blocks: [
      {
        type: "custom",
        customType: entry.customType,
        text: contentToPlainText(entry.content),
      },
    ],
  };
}

function toRenderableEntry(entry: SessionEntry): RuntimeRenderableMessage | null {
  if (entry.type === "message") {
    return toRenderableMessage(entry.id, entry.message);
  }

  if (entry.type === "custom_message") {
    return toRenderableCustomEntry(entry);
  }

  return null;
}

export function buildRenderableMessages(
  sessionManager: SessionManager,
): RuntimeRenderableMessage[] {
  const branch = sessionManager.getBranch(sessionManager.getLeafId() ?? undefined);
  const messages: RuntimeRenderableMessage[] = [];

  for (const entry of branch) {
    const renderable = toRenderableEntry(entry);
    if (renderable) {
      messages.push(renderable);
    }
  }

  return messages;
}

function toRenderableToolCallDelta(
  event: Extract<
    AssistantMessageEvent,
    { type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }
  >,
): RuntimeMessageDelta | null {
  if (event.type === "toolcall_delta") {
    return {
      kind: "tool_call_delta",
      contentIndex: event.contentIndex,
      text: event.delta,
    };
  }

  const toolCall = event.type === "toolcall_end"
    ? event.toolCall
    : event.partial.content[event.contentIndex];

  if (!toolCall || toolCall.type !== "toolCall") {
    return null;
  }

  if (event.type === "toolcall_start") {
    return {
      kind: "tool_call_start",
      contentIndex: event.contentIndex,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      argsText: stringifyUnknown(toolCall.arguments),
    };
  }

  return {
    kind: "tool_call_end",
    contentIndex: event.contentIndex,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    argsText: stringifyUnknown(toolCall.arguments),
  };
}

export function toRenderableAssistantDelta(
  event: AssistantMessageEvent,
): RuntimeMessageDelta | null {
  if (event.type === "text_delta") {
    return {
      kind: "text",
      contentIndex: event.contentIndex,
      text: event.delta,
    };
  }

  if (event.type === "thinking_delta") {
    return {
      kind: "thinking",
      contentIndex: event.contentIndex,
      text: event.delta,
    };
  }

  if (
    event.type === "toolcall_start"
    || event.type === "toolcall_delta"
    || event.type === "toolcall_end"
  ) {
    return toRenderableToolCallDelta(event);
  }

  return null;
}
