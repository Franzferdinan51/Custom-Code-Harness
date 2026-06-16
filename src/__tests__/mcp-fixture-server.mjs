
// Minimal MCP stdio server for testing the client. Reads
// newline-delimited JSON-RPC from stdin, writes responses.
// Supports: initialize, tools/list, tools/call ("echo"), ping.

let buf = "";

function send(res) {
  process.stdout.write(JSON.stringify(res) + "\n");
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.id === undefined) continue; // notification
    const id = req.id;
    if (req.method === "initialize") {
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fixture", version: "0.0.1", title: "Test Fixture" },
        },
      });
    } else if (req.method === "tools/list") {
      send({
        jsonrpc: "2.0", id,
        result: { tools: [
          {
            name: "echo",
            description: "Echo the input back",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
          {
            name: "add",
            description: "Add two numbers",
            inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
          },
        ] },
      });
    } else if (req.method === "tools/call") {
      const { name, arguments: args } = req.params || {};
      if (name === "echo") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo: " + (args?.text ?? "") }] } });
      } else if (name === "add") {
        const sum = (args?.a ?? 0) + (args?.b ?? 0);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(sum) }] } });
      } else {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "unknown tool" }], isError: true } });
      }
    } else if (req.method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method: " + req.method } });
    }
  }
});
