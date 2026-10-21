// A minimal MCP stdio server whose only tool always fails with an enormous
// error payload (200k chars), so tests can prove the bridge clips error
// results to the same ceiling as successful ones before they reach the model.
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "errprobe", version: "1.0.0" },
    }});
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      {
        name: "boom",
        description: "Always fails with a huge error text.",
        inputSchema: { type: "object", properties: {} },
      },
    ]}});
    return;
  }
  if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      isError: true,
      content: [{ type: "text", text: "E".repeat(200_000) }],
    }});
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
