export interface IncomingMessage {
  id: string;
  chatId: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  mentionsMe: boolean;
  raw: unknown;
}

export interface ChatInfo {
  chatId: string;
  name: string;
  type: "group" | "p2p";
}

export type MessageHandler = (
  channel: Channel,
  message: IncomingMessage,
) => void;

export interface ChannelOptions {
  onMessage: MessageHandler;
}

export interface Channel {
  readonly type: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendImage?(chatId: string, filePath: string): Promise<void>;
  sendFile?(chatId: string, filePath: string): Promise<void>;
  listChats(): Promise<ChatInfo[]>;
}
