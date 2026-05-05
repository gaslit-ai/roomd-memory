export interface McpToolNames {
  readonly send: string
  readonly recv: string
}

export const DEFAULT_MCP_TOOL_NAMES: McpToolNames = Object.freeze({
  send: 'comms.send',
  recv: 'comms.recv',
})
