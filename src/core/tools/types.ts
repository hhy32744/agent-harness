/** 工具 / 作用域共同引用的结构定义，单独一层避免循环依赖 */

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 暴露给模型的工具声明（对应 OpenAI tools[].function） */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** 工具执行结果，最终会被序列化成一条 role=tool 的消息 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** 执行期上下文：工具能看到的全部"环境"都从这里来 */
export interface ToolContext {
  scope: import("../scope").Scope;
  sessionId: string;
  signal?: AbortSignal;
  logger: (event: string, detail?: unknown) => void;
}

/** 工具实现：声明 + 一个纯函数式的 run */
export interface ToolDefinition extends ToolSpec {
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}
