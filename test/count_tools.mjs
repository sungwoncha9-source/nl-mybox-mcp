import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
for (const b of process.argv.slice(2)) { const c = new Client({ name: 'n', version: '1' });
  await c.connect(new StdioClientTransport({ command: 'node', args: [b], env: { ...process.env, MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: 'http://127.0.0.1:9/v1' }, stderr: 'ignore' }));
  const v = c.getServerVersion(); const t = (await c.listTools()).tools.map(x => x.name); console.log(b, v.version, t.length, t.join(',')); await c.close(); }
