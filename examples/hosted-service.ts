import { startHttpServer } from 'memory-layer/server';

async function main() {
  const service = await startHttpServer({
    host: '127.0.0.1',
    port: 3100,
    dbPath: './data/hosted-memory.db',
    preset: 'ai_ide',
    apiKey: process.env.MEMORY_API_KEY,
    adminApiKey: process.env.MEMORY_ADMIN_API_KEY,
  });

  console.log('memory-layer HTTP service running on http://127.0.0.1:3100');

  process.on('SIGINT', async () => {
    await service.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
