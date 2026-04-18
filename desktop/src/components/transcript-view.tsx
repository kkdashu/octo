import { useEffect, useRef } from "react";
import type {
  GroupRuntimeSnapshot,
  RuntimeRenderableBlock,
  RuntimeRenderableMessage,
} from "../lib/runtime-types";

function formatTimestamp(value: number | string): string {
  const date = typeof value === "number"
    ? new Date(value)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getRoleLabel(message: RuntimeRenderableMessage): string {
  if (message.role === "user") {
    return "用户";
  }

  if (message.role === "assistant") {
    return "助手";
  }

  if (message.role === "toolResult") {
    return "工具结果";
  }

  if (message.role === "bashExecution") {
    return "Bash";
  }

  return "自定义";
}

function renderBlock(block: RuntimeRenderableBlock, key: string) {
  if (block.type === "text") {
    return <p key={key} className="message-text">{block.text}</p>;
  }

  if (block.type === "thinking") {
    return (
      <div key={key} className="thinking-card">
        <strong>Thinking</strong>
        <p className="message-text">{block.text}</p>
      </div>
    );
  }

  if (block.type === "tool_call") {
    return (
      <div key={key} className="tool-card">
        <strong>{block.toolName}</strong>
        <pre className="message-code">{block.argsText}</pre>
      </div>
    );
  }

  if (block.type === "tool_result") {
    return (
      <div
        key={key}
        className={`tool-card ${block.isError ? "tool-card-error" : ""}`}
      >
        <strong>{block.toolName}</strong>
        <pre className="message-code">{block.text}</pre>
      </div>
    );
  }

  if (block.type === "bash") {
    return (
      <div key={key} className="tool-card">
        <strong>{block.command}</strong>
        <pre className="message-code">{block.output}</pre>
      </div>
    );
  }

  return (
    <div key={key} className="custom-card">
      <strong>{block.customType}</strong>
      <p className="message-text">{block.text}</p>
    </div>
  );
}

interface TranscriptViewProps {
  snapshot: GroupRuntimeSnapshot | null;
  statusText: string;
}

export function TranscriptView(props: TranscriptViewProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: props.snapshot?.isStreaming ? "smooth" : "auto",
      block: "end",
    });
  }, [props.snapshot?.isStreaming, props.snapshot?.messages.length]);

  if (!props.snapshot) {
    return (
      <section className="transcript">
        <div className="empty-state">
          <div className="empty-card">
            <h3>选择一个 group 开始</h3>
            <p>desktop UI 会从 sidecar 拉取 snapshot，并通过 SSE 持续同步运行时事件。</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="transcript">
      <div className="status-banner">{props.statusText}</div>
      <div className="message-list">
        {props.snapshot.messages.length === 0 ? (
          <div className="empty-card">
            <h3>当前会话还没有消息</h3>
            <p>发送第一条消息后，这里会展示 transcript、thinking 和 tool 执行块。</p>
          </div>
        ) : null}
        {props.snapshot.messages.map((message) => (
          <article
            key={message.id}
            className={`message-card message-card-${message.role}`}
          >
            <header className="message-header">
              <span className="message-role">{getRoleLabel(message)}</span>
              <span className="message-time">{formatTimestamp(message.timestamp)}</span>
            </header>
            <div className="message-blocks">
              {message.blocks.map((block, index) => renderBlock(block, `${message.id}-${index}`))}
            </div>
          </article>
        ))}
        {props.snapshot.pendingSteering.length > 0 ? (
          <div>
            <p className="eyebrow">Pending Steering</p>
            <div className="queue-chip-row">
              {props.snapshot.pendingSteering.map((item) => (
                <span key={item} className="queue-chip">{item}</span>
              ))}
            </div>
          </div>
        ) : null}
        {props.snapshot.pendingFollowUp.length > 0 ? (
          <div>
            <p className="eyebrow">Pending Follow Up</p>
            <div className="queue-chip-row">
              {props.snapshot.pendingFollowUp.map((item) => (
                <span key={item} className="queue-chip">{item}</span>
              ))}
            </div>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}
