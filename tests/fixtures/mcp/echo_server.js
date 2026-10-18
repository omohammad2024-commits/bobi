// A minimal MCP stdio server: one tool that adds two numbers.
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
      serverInfo: { name: "probe", version: "1.0.0" },
    }});
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
      name: "add",
      description: "Adds two numbers.",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a","b"] },
    }]}});
    return;
  }
  if (msg.method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    const sum = Number(args.a) + Number(args.b);
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `sum=${sum}` }] }});
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
