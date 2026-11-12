/**
 * Session：消息流 + 事件日志。
 *
 * 为什么要分层：
 *   - messages 是"给模型看的"，必须严格符合协议；
 *   - events 是"给人看的"，记录时间、耗时、拒绝原因，用来复盘和打分。
 * 两者同源但不混在一起，否则往 messages 里塞诊断字段会污染协议。
 */
import type { Message } from "../types";

export type SessionEventType =
  | "session.start"
  | "session.fork"
  | "user.message"
  | "assistant.message"
  | "tool.call"
  | "tool.result"
  | "tool.note"
  | "tool.denied"
  | "turn.limit"
  | "session.end"
  | "error";

export interface SessionEvent {
  seq: number;
  /** 毫秒时间戳 */
  ts: number;
  turn: number;
  type: SessionEventType;
  data: Record<string, unknown>;
}

export interface SessionSnapshot {
  id: string;
  parentId?: string;
  messages: Message[];
  events: SessionEvent[];
  stats: { turns: number; toolCalls: number; toolErrors: number };
}

let counter = 0;

function newSessionId(prefix = "sess"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, "0")}`;
}

export class Session {
  readonly id: string;
  readonly parentId?: string;
  private readonly _messages: Message[] = [];
  private readonly _events: SessionEvent[] = [];
  private seq = 0;
  private stats = { turns: 0, toolCalls: 0, toolErrors: 0 };

  constructor(id: string = newSessionId(), parentId?: string) {
    this.id = id;
    this.parentId = parentId;
  }

  get messages(): readonly Message[] {
    return this._messages;
  }

  get events(): readonly SessionEvent[] {
    return this._events;
  }

  get lastMessage(): Message | undefined {
    return this._messages[this._messages.length - 1];
  }

  append(message: Message): void {
    this._messages.push(message);
  }

  record(type: SessionEventType, data: Record<string, unknown> = {}, turn = 0): SessionEvent {
    if (type === "tool.call") this.stats.toolCalls += 1;
    if (type === "tool.result" && data.isError) this.stats.toolErrors += 1;
    if (type === "assistant.message") this.stats.turns = Math.max(this.stats.turns, turn);
    const event: SessionEvent = { seq: ++this.seq, ts: Date.now(), turn, type, data };
    this._events.push(event);
    return event;
  }

  /**
   * 分支会话：把当前消息流复制一份，用于"换条路再试一次"。
   * 复制而不是引用，保证子会话继续 append 时不会污染父会话。
   */
  fork(reason: string): Session {
    const child = new Session(newSessionId("fork"), this.id);
    for (const m of this._messages) child._messages.push(m);
    child.record("session.fork", { reason, parentId: this.id, copiedMessages: this._messages.length });
    return child;
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      parentId: this.parentId,
      messages: [...this._messages],
      events: [...this._events],
      stats: { ...this.stats },
    };
  }
}
