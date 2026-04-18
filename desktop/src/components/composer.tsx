import type { ChangeEvent, KeyboardEvent } from "react";

interface ComposerProps {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  onAbort(): void;
  onNewSession(): void;
  disabled: boolean;
  isStreaming: boolean;
  isSubmitting: boolean;
  groupName: string | null;
}

export function Composer(props: ComposerProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      props.onSubmit();
    }
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    props.onChange(event.target.value);
  }

  return (
    <section className="composer">
      <textarea
        value={props.value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={props.disabled || props.isStreaming}
        placeholder={
          props.groupName
            ? `给 ${props.groupName} 发送下一条消息...`
            : "先选择一个 group"
        }
      />
      <div className="composer-actions">
        <button
          type="button"
          className="button-primary"
          disabled={props.disabled || props.isSubmitting || props.isStreaming || !props.value.trim()}
          onClick={props.onSubmit}
        >
          {props.isSubmitting ? "发送中..." : "发送"}
        </button>
        <button
          type="button"
          className="button-danger"
          disabled={props.disabled || !props.isStreaming}
          onClick={props.onAbort}
        >
          停止
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={props.disabled || props.isSubmitting}
          onClick={props.onNewSession}
        >
          新会话
        </button>
      </div>
      <div className="composer-hint">
        {props.isStreaming
          ? "当前正在生成，先停止后再发送下一条消息。"
          : "支持 Ctrl/Command + Enter 快速发送。"}
      </div>
    </section>
  );
}
