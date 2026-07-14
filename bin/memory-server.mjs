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
  memory-layer inspect <knowledge|audits|monitor|compactions|reverification|changes> [options]

Options:
  --db <path>          Database path (default: ':memory:')
  --database-url <url> Postgres connection string for hosted mode
  --scope <scope>      Default scope identifier (default: 'default')
  --summarizer <type>  Summarizer: extractive|claude|openai (default: extractive)
  --extractor <type>   Extractor: regex|claude|openai|none (default: regex)
  --preset <preset>    Preset: ai_ide|chat_agent|autonomous_agent
  --quality-mode <m>   Quality mode: fast_adoption|balanced_memory|high_fidelity_memory
  --quality-tier <t>   Legacy tier: offline_default|local_semantic|provider_backed
  --cross-scope-level  Cross-scope level: scope|workspace|system|tenant
  --transport <type>   Transport: mcp|http|both (default: mcp)
  --port <port>        HTTP port (default: 3100)
  --host <host>        HTTP host (default: 127.0.0.1)
  --api-key <key>      Bearer auth key for HTTP requests
  --admin-key <key>    Admin key for compaction and maintenance endpoints
  --body-limit <n>     Maximum HTTP request body bytes (default: 1048576)
  --help               Show this help message
  --tenant <id>        Explicit tenant for inspect mode
  --system <id>        Explicit system for inspect mode
  --workspace <id>     Explicit workspace for inspect mode
  --collaboration <id> Explicit collaboration for inspect mode
  --scope-id <id>      Explicit scope_id for inspect mode
  --id <n>             Knowledge id for inspect mode
  --knowledge-id <n>   Filter audits to a specific knowledge id
  --limit <n>          Limit rows for inspect mode
  --cursor <n>         Pagination cursor for inspect knowledge
  --since <iso>        Lower bound for inspect changes
  --run                Execute reverification instead of only listing due items

Environment variables:
  MEMORY_DB_PATH       Database path
  MEMORY_SCOPE         Default scope
  MEMORY_DATABASE_URL  Postgres connection string
  MEMORY_SUMMARIZER    Summarizer type
  MEMORY_EXTRACTOR     Extractor type
  MEMORY_PRESET        Preset name
  MEMORY_QUALITY_MODE  Hosted quality mode
  MEMORY_QUALITY_TIER  Legacy hosted quality tier
  MEMORY_CROSS_SCOPE_LEVEL Default hosted cross-scope level
  MEMORY_API_KEY       API key for HTTP bearer auth
  MEMORY_ADMIN_API_KEY Admin key for privileged endpoints
  MEMORY_TRANSPORT     Transport type (mcp|http|both)
  MEMORY_HOST          HTTP host
  MEMORY_PORT          HTTP port (default: 3100)
  MEMORY_BODY_LIMIT    Maximum HTTP request body bytes

Examples:
  npx memory-layer serve --db ./memory.db --preset ai_ide
  npx memory-layer serve --transport http --port 3100
  npx memory-layer serve --transport both --db ./shared.db
  npx memory-layer inspect knowledge --db ./memory.db --limit 20
  npx memory-layer inspect reverification --db ./memory.db --run
  `);
  process.exit(0);
}

const command = args[0];
if (command && command !== 'serve' && command !== 'inspect') {
  console.error(`Unknown command: ${command}. Use 'serve', 'inspect', or --help.`);
  process.exit(1);
}

const config = {
  dbPath: getArg('db') ?? process.env.MEMORY_DB_PATH ?? ':memory:',
  databaseUrl: getArg('database-url') ?? process.env.MEMORY_DATABASE_URL ?? undefined,
  scope: getArg('scope') ?? process.env.MEMORY_SCOPE ?? 'default',
  summarizer: getArg('summarizer') ?? process.env.MEMORY_SUMMARIZER ?? 'extractive',
  extractor: getArg('extractor') ?? process.env.MEMORY_EXTRACTOR ?? 'regex',
  preset: getArg('preset') ?? process.env.MEMORY_PRESET ?? undefined,
  qualityMode: getArg('quality-mode') ?? process.env.MEMORY_QUALITY_MODE ?? undefined,
  qualityTier: getArg('quality-tier') ?? process.env.MEMORY_QUALITY_TIER ?? undefined,
  crossScopeLevel: getArg('cross-scope-level') ?? process.env.MEMORY_CROSS_SCOPE_LEVEL ?? undefined,
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
  if (command === 'inspect') {
    const target = args[1] ?? 'knowledge';
    const { runInspectCommand } = await import('../dist/cli/inspect.js');
    const output = await runInspectCommand(target, {
      dbPath: config.dbPath,
      databaseUrl: config.databaseUrl,
      scope: config.scope,
      tenantId: getArg('tenant'),
      systemId: getArg('system'),
      workspaceId: getArg('workspace'),
      collaborationId: getArg('collaboration'),
      scopeId: getArg('scope-id'),
      qualityMode: config.qualityMode,
      qualityTier: config.qualityTier,
      crossScopeLevel: getArg('cross-scope-level') ?? process.env.MEMORY_CROSS_SCOPE_LEVEL,
      id: getArg('id') ? Number(getArg('id')) : undefined,
      knowledgeId: getArg('knowledge-id') ? Number(getArg('knowledge-id')) : undefined,
      limit: getArg('limit') ? Number(getArg('limit')) : undefined,
      cursor: getArg('cursor') ? Number(getArg('cursor')) : undefined,
      since: getArg('since'),
      run: args.includes('--run'),
    });
    console.log(output);
    return;
  }

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
