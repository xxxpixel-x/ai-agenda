// 离线 stdio 服务器，每个请求占一行。只把真正执行过的调用记在测试目录。
import fs from 'node:fs';
import readline from 'node:readline';

for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === 'initialize') {
    result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } };
  } else if (method === 'tools/list') {
    result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: {
      type: 'object', properties: { text: { type: 'string' } }, required: ['text'],
    } }] };
  } else if (method === 'tools/call' && params.name === 'echo') {
    fs.appendFileSync(process.argv[2], JSON.stringify(params.arguments) + '\n');
    result = { content: [{ type: 'text', text: 'echo: ' + params.arguments.text }] };
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
