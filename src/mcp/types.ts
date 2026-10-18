/**
 * MCP server configuration — the vocabulary for connecting external tool servers.
 *
 * Why this exists rather than writing forty tools: MCP is an open standard, and
 * any server that speaks it brings its tools with it. One integration replaces a
 * long list of hand-written ones.
 *
 * SECURITY, and this is the important part: an MCP stdio server is a SHELL
 * COMMAND. Its config is a command plus arguments that the gateway will spawn,
 * so it carries the full authority of the bot process. It is therefore NOT
 * something a model or an ordinary user may add — only the owner, through a
 * config file or the owner panel, and a server that is not explicitly enabled
 * never runs.
 */

/** How BOBI reaches an MCP server. */
export type McpTransport = "stdio" | "http";

/** One configured server. */
export interface McpServerConfig {
  /** Stable identifier, used as the tool-name prefix and in the panel. */
  name: string;
  transport: McpTransport;
  /**
   * False by default. A server added to the file is inert until the owner
   * enables it, so dropping a config in place cannot silently execute code.
   */
  enabled: boolean;
  // ---- stdio ----
  /** Executable to run. This is a shell command — owner-only. */
  command?: string;
  args?: string[];
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
  // ---- http ----
  /** Endpoint URL, for a streamable-HTTP server. */
  url?: string;
  /** Bearer token for the endpoint, if it needs one. Never logged. */
  token?: string;
}

/** The on-disk shape of the MCP config file. */
export interface McpConfigFile {
  /** Servers keyed by name. */
  servers: Record<string, Omit<McpServerConfig, "name">>;
}

export interface McpValidationIssue {
  /** Dotted path to the offending field, e.g. `servers.foo.command`. */
  path: string;
  message: string;
}

/**
 * Why a server name is restricted.
 *
 * The name becomes a prefix on every tool the server exposes, and tool names
 * reach both the model and the callback payloads. A name containing a separator
 * or shell characters would make a tool impossible to address unambiguously.
 */
export const MCP_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Ceilings, so a hostile or mistaken config cannot exhaust the process. */
export const MAX_SERVERS = 16;
export const MAX_ARGS = 32;
export const MAX_ARG_LENGTH = 512;
export const MAX_ENV_VARS = 32;
export const MAX_TOOLS_PER_SERVER = 100;
