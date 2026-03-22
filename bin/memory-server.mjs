#!/usr/bin/env node

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
memory-layer - Drop-in memory server for AI systems

Usage:
  memory-layer serve [options]

Options:
  --db <path>          Database path (default: ':memory:')
  --scope <scope>      Default scope identifier (default: 'default')
  --summarizer <type>  Summarizer: extractive|claude|openai (default: extractive)
  --extractor <type>   Extractor: regex|claude|openai|none (default: regex)
  --preset <preset>    Preset: ai_ide|chat_agent|autonomous_agent
  --transport <type>   Transport: mcp|http|both (default: mcp)
  --port <port>        HTTP port (default: 3100)
  --host <host>        HTTP host (default: 127.0.0.1)
  --api-key <key>      Bearer auth key for HTTP requests
  --admin-key <key>    Admin key for compaction and maintenance endpoints
  --body-limit <n>     Maximum HTTP request body bytes (default: 1048576)
  --help               Show this help message

Environment variables:
  MEMORY_DB_PATH       Database path
  MEMORY_SCOPE         Default scope
  MEMORY_SUMMARIZER    Summarizer type
  MEMORY_EXTRACTOR     Extractor type
  MEMORY_PRESET        Preset name
  MEMORY_API_KEY       API key for HTTP bearer auth
  MEMORY_ADMIN_API_KEY Admin key for privileged endpoints
  MEMORY_TRANSPORT     Transport type (mcp|http|both)
  MEMORY_HOST          HTTP host
  MEMORY_BODY_LIMIT    Maximum HTTP request body bytes

Examples:
  npx memory-layer serve --db ./memory.db --preset ai_ide
  npx memory-layer serve --transport http --port 3100
  npx memory-layer serve --transport both --db ./shared.db
  `);
  process.exit(0);
}

const command = args[0];
if (command && command !== 'serve') {
  console.error(`Unknown command: ${command}. Use 'serve' or --help.`);
  process.exit(1);
}

const config = {
  dbPath: getArg('db') ?? process.env.MEMORY_DB_PATH ?? ':memory:',
  scope: getArg('scope') ?? process.env.MEMORY_SCOPE ?? 'default',
  summarizer: getArg('summarizer') ?? process.env.MEMORY_SUMMARIZER ?? 'extractive',
  extractor: getArg('extractor') ?? process.env.MEMORY_EXTRACTOR ?? 'regex',
  preset: getArg('preset') ?? process.env.MEMORY_PRESET ?? undefined,
  apiKey: getArg('api-key') ?? process.env.MEMORY_API_KEY ?? undefined,
  adminApiKey: getArg('admin-key') ?? process.env.MEMORY_ADMIN_API_KEY ?? undefined,
  host: getArg('host') ?? process.env.MEMORY_HOST ?? '127.0.0.1',
  bodyLimitBytes: Number(getArg('body-limit') ?? process.env.MEMORY_BODY_LIMIT ?? 1048576),
};

if (config.extractor === 'none') {
  config.extractor = false;
}

const transport = getArg('transport') ?? process.env.MEMORY_TRANSPORT ?? 'mcp';
const port = Number(getArg('port') ?? process.env.MEMORY_PORT ?? 3100);

async function main() {
  if (transport === 'mcp' || transport === 'both') {
    const { startMcpServer } = await import('../dist/server/mcp-server.js');
    if (transport === 'mcp') {
      await startMcpServer(config);
      return;
    }
    // For 'both', start MCP in background (it reads stdin)
    startMcpServer(config).catch((err) => {
      console.error('MCP server error:', err);
    });
  }

  if (transport === 'http' || transport === 'both') {
    const { startHttpServer } = await import('../dist/server/http-server.js');
    const { server } = await startHttpServer({ ...config, port });
    console.error(`memory-layer HTTP server listening on ${config.host}:${port}`);

    process.on('SIGINT', () => {
      server.close();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error('Failed to start memory-layer server:', error);
  process.exit(1);
});
