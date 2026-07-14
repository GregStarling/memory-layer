import {
  createMemoryWithAsyncAdapter,
  type CreateMemoryOptions,
} from '../core/quick.js';
import type { MemoryManager } from '../core/manager.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { EmbeddingAdapter } from '../contracts/embedding.js';
import type { AliasMap } from '../contracts/aliases.js';
import type { OntologyConfig } from '../contracts/ontology.js';
import type { LintOptions, LintReport } from '../contracts/lint.js';
import { type MemoryScope } from '../contracts/identity.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { lintKnowledge as runKnowledgeLint } from '../core/knowledge-lint.js';
import {
  parseAliases,
  parseOntology,
  SCOPE_CONFIG_KEYS,
  serializeAliases,
  serializeOntology,
} from '../core/scope-config.js';
import { scopeKeyFor, withScopeManagers } from './scope-propagation.js';

interface AdapterResources {
  asyncAdapter: AsyncStorageAdapter;
  embeddingAdapter?: EmbeddingAdapter;
  close: () => Promise<void>;
}

export interface ServerContextConfig {
  dbPath?: string;
  databaseUrl?: string;
  asyncAdapter?: AsyncStorageAdapter;
  embeddingAdapter?: EmbeddingAdapter;
  closeAdapterResources?: () => Promise<void>;
  managerCacheLimit?: number;
  sessionManagerCacheLimit?: number;
  buildManagerOptions: (
    scopeInput: string | MemoryScope,
    sessionId?: string,
  ) => Omit<CreateMemoryOptions, 'adapter' | 'path'>;
}

export interface ServerContext {
  getManager(scopeInput: string | MemoryScope): Promise<MemoryManager>;
  getSessionManager(scopeInput: string | MemoryScope, sessionId: string): Promise<MemoryManager>;
  withScopeManagers(
    scopeInput: string | MemoryScope,
    callback: (manager: MemoryManager) => Promise<void>,
  ): Promise<void>;
  refreshScopeConfig(scopeInput: string | MemoryScope): Promise<{
    aliases?: AliasMap;
    ontology?: OntologyConfig;
  }>;
  saveAliases(scopeInput: string | MemoryScope, aliasMap: AliasMap): Promise<void>;
  saveOntology(scopeInput: string | MemoryScope, ontology: OntologyConfig): Promise<void>;
  /**
   * Lint the knowledge base for a scope. Encapsulated here (rather than reached
   * for in the HTTP layer) so the adapter is never accessed bare: callers pass a
   * scope that has already been through the server's auth + scope-resolution
   * pipeline, and lint runs against the same shared adapter every manager uses.
   * Ontology-violation checks use the scope's persisted ontology.
   */
  lintKnowledge(scopeInput: string | MemoryScope, options?: LintOptions): Promise<LintReport>;
  getCacheSizes(): { managers: number; sessionManagers: number };
  close(): Promise<void>;
}

const DEFAULT_MANAGER_CACHE_LIMIT = 256;
const DEFAULT_SESSION_MANAGER_CACHE_LIMIT = 256;

function materializeScope(scopeInput: string | MemoryScope): MemoryScope {
  return typeof scopeInput === 'string'
    ? {
        tenant_id: 'default',
        system_id: 'default',
        scope_id: scopeInput,
      }
    : scopeInput;
}

function touchCache<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number,
  onEvict?: (evictedKey: string, evictedValue: T) => void,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestEntry = cache.entries().next().value as [string, T] | undefined;
    if (!oldestEntry) break;
    const [oldestKey, oldestValue] = oldestEntry;
    cache.delete(oldestKey);
    onEvict?.(oldestKey, oldestValue);
  }
}

export function createServerContext(config: ServerContextConfig): ServerContext {
  const managers = new Map<string, MemoryManager>();
  const sessionManagers = new Map<string, MemoryManager>();
  const managerCacheLimit = config.managerCacheLimit ?? DEFAULT_MANAGER_CACHE_LIMIT;
  const sessionManagerCacheLimit =
    config.sessionManagerCacheLimit ?? DEFAULT_SESSION_MANAGER_CACHE_LIMIT;
  let adapterPromise: Promise<AdapterResources> | null = null;

  async function getAdapterResources(): Promise<AdapterResources> {
    if (!adapterPromise) {
      adapterPromise = (async () => {
        if (config.asyncAdapter) {
          return {
            asyncAdapter: config.asyncAdapter,
            embeddingAdapter: config.embeddingAdapter,
            close: async () => {
              await config.closeAdapterResources?.();
            },
          };
        }
        if (!config.databaseUrl) {
          const { createSQLiteAdapterWithEmbeddings } = await import(
            '../adapters/sqlite/index.js'
          );
          const sqlite = createSQLiteAdapterWithEmbeddings(config.dbPath ?? ':memory:');
          return {
            asyncAdapter: wrapSyncAdapter(sqlite),
            embeddingAdapter: sqlite.embeddings,
            close: async () => {
              sqlite.close();
            },
          };
        }

        const moduleName = 'pg';
        const pgModule = await import(moduleName).catch(() => {
          throw new Error(
            'memory-layer: hosted Postgres mode requires the "pg" package. Install it with: npm install pg',
          );
        });
        const { createPostgresAdapter, createPostgresEmbeddingAdapter } = await import(
          '../adapters/postgres/index.js'
        );
        const Pool = pgModule.Pool ?? pgModule.default?.Pool;
        const pool = new Pool({ connectionString: config.databaseUrl });
        return {
          asyncAdapter: createPostgresAdapter(pool, { ownsPool: false }),
          embeddingAdapter: createPostgresEmbeddingAdapter(pool),
          close: async () => {
            await pool.end();
          },
        };
      })();
    }
    return adapterPromise;
  }

  async function readScopeConfig(scopeInput: string | MemoryScope): Promise<{
    aliases?: AliasMap;
    ontology?: OntologyConfig;
  }> {
    const { asyncAdapter } = await getAdapterResources();
    const scope = materializeScope(scopeInput);
    const [aliasesValue, ontologyValue] = await Promise.all([
      asyncAdapter.getScopeConfig(scope, SCOPE_CONFIG_KEYS.aliases),
      asyncAdapter.getScopeConfig(scope, SCOPE_CONFIG_KEYS.ontology),
    ]);
    return {
      aliases: parseAliases(aliasesValue),
      ontology: parseOntology(ontologyValue),
    };
  }

  async function hydrateManager(
    scopeInput: string | MemoryScope,
    manager: MemoryManager,
  ): Promise<void> {
    const persisted = await readScopeConfig(scopeInput);
    if (persisted.aliases) {
      manager.setAliases(persisted.aliases);
    }
    if (persisted.ontology) {
      manager.setOntology(persisted.ontology);
    }
  }

  async function createManager(
    scopeInput: string | MemoryScope,
    sessionId?: string,
  ): Promise<MemoryManager> {
    const adapterResources = await getAdapterResources();
    const manager = createMemoryWithAsyncAdapter({
      ...config.buildManagerOptions(scopeInput, sessionId),
      asyncAdapter: adapterResources.asyncAdapter,
      embeddingAdapter: adapterResources.embeddingAdapter,
      closeAdapter: false,
    });
    await hydrateManager(scopeInput, manager);
    return manager;
  }

  async function getManager(scopeInput: string | MemoryScope): Promise<MemoryManager> {
    const key = scopeKeyFor(scopeInput);
    const existing = managers.get(key);
    if (existing) {
      touchCache(managers, key, existing, managerCacheLimit);
      return existing;
    }
    const manager = await createManager(scopeInput);
    touchCache(managers, key, manager, managerCacheLimit, (_evictedKey, evictedManager) => {
      void evictedManager.close().catch(() => undefined);
    });
    return manager;
  }

  async function getSessionManager(
    scopeInput: string | MemoryScope,
    sessionId: string,
  ): Promise<MemoryManager> {
    const key = `${scopeKeyFor(scopeInput)}|session:${sessionId}`;
    const existing = sessionManagers.get(key);
    if (existing) {
      touchCache(sessionManagers, key, existing, sessionManagerCacheLimit);
      return existing;
    }
    const manager = await createManager(scopeInput, sessionId);
    touchCache(
      sessionManagers,
      key,
      manager,
      sessionManagerCacheLimit,
      (_evictedKey, evictedManager) => {
        void evictedManager.close().catch(() => undefined);
      },
    );
    return manager;
  }

  async function refreshScopeConfig(scopeInput: string | MemoryScope): Promise<{
    aliases?: AliasMap;
    ontology?: OntologyConfig;
  }> {
    const persisted = await readScopeConfig(scopeInput);
    await withScopeManagers(scopeInput, sessionManagers, getManager, async (manager) => {
      if (persisted.aliases) {
        manager.setAliases(persisted.aliases);
      }
      if (persisted.ontology) {
        manager.setOntology(persisted.ontology);
      }
    });
    return persisted;
  }

  async function saveAliases(scopeInput: string | MemoryScope, aliasMap: AliasMap): Promise<void> {
    const { asyncAdapter } = await getAdapterResources();
    await asyncAdapter.setScopeConfig(
      materializeScope(scopeInput),
      SCOPE_CONFIG_KEYS.aliases,
      serializeAliases(aliasMap),
    );
    await withScopeManagers(scopeInput, sessionManagers, getManager, async (manager) => {
      manager.setAliases(aliasMap);
    });
  }

  async function saveOntology(
    scopeInput: string | MemoryScope,
    ontology: OntologyConfig,
  ): Promise<void> {
    const { asyncAdapter } = await getAdapterResources();
    await asyncAdapter.setScopeConfig(
      materializeScope(scopeInput),
      SCOPE_CONFIG_KEYS.ontology,
      serializeOntology(ontology),
    );
    await withScopeManagers(scopeInput, sessionManagers, getManager, async (manager) => {
      manager.setOntology(ontology);
    });
  }

  async function lintKnowledgeForScope(
    scopeInput: string | MemoryScope,
    options?: LintOptions,
  ): Promise<LintReport> {
    const { asyncAdapter } = await getAdapterResources();
    // getManager hydrates persisted aliases/ontology for the scope, so the
    // ontology-violation lint category sees the same config the manager uses.
    const manager = await getManager(scopeInput);
    const ontology = manager.getOntology();
    return runKnowledgeLint(asyncAdapter, materializeScope(scopeInput), options, ontology);
  }

  return {
    getManager,
    getSessionManager,
    withScopeManagers(scopeInput, callback) {
      return withScopeManagers(scopeInput, sessionManagers, getManager, callback);
    },
    refreshScopeConfig,
    saveAliases,
    saveOntology,
    lintKnowledge: lintKnowledgeForScope,
    getCacheSizes() {
      return {
        managers: managers.size,
        sessionManagers: sessionManagers.size,
      };
    },
    async close() {
      for (const manager of new Set([...managers.values(), ...sessionManagers.values()])) {
        await manager.close().catch(() => undefined);
      }
      managers.clear();
      sessionManagers.clear();
      if (adapterPromise) {
        const adapterResources = await adapterPromise;
        await adapterResources.close();
      }
    },
  };
}
