export type WebMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) => unknown | Promise<unknown>;
};

export type ModelContext = {
  registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => Promise<void>;
};

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
}
