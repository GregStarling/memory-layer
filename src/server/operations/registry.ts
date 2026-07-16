/**
 * The operation registry (Phase 6.3).
 *
 * One entry per HTTP operation the server serves through its dispatch chain.
 * This is the single structural source of truth: HTTP dispatch loops over it,
 * MCP tool curation filters it, and the OpenAPI parity test asserts it 1:1
 * against the documented spec paths.
 *
 * Ordering mirrors the original dispatch order so first-match semantics are
 * preserved for any same-method paths that could otherwise overlap.
 *
 * Excluded by design: `/healthz` and `/readyz` are answered *before* the auth
 * gate and routing (they must respond without credentials), so they are not
 * registry operations — they are the documented pre-routing exception and are
 * allow-listed in the parity test.
 */
import type { OperationSpec } from './types.js';

export const OPERATIONS: readonly OperationSpec[] = [
  // ---- graph / discovery -------------------------------------------------
  { name: 'discover', http: { method: 'GET', path: '/v1/discover' }, auth: 'tenant', mcp: { toolName: 'memory_discover', core: false } },
  { name: 'getReport', http: { method: 'GET', path: '/v1/report' }, auth: 'tenant', mcp: { toolName: 'memory_get_report', core: false } },

  // ---- curation / temporal reads ----------------------------------------
  { name: 'getFactsAt', http: { method: 'GET', path: '/v1/facts-at' }, auth: 'tenant', mcp: { toolName: 'memory_get_facts_at', core: false } },
  { name: 'reflectKnowledge', http: { method: 'POST', path: '/v1/reflect-knowledge' }, auth: 'tenant', mcp: { toolName: 'memory_reflect_knowledge', core: false } },
  { name: 'derive', http: { method: 'POST', path: '/v1/derive' }, auth: 'tenant', mcp: { toolName: 'memory_derive', core: false } },
  { name: 'getCuration', http: { method: 'GET', path: '/v1/curation' }, auth: 'tenant', mcp: { toolName: 'memory_get_curation', core: false } },
  { name: 'getCoreMemory', http: { method: 'GET', path: '/v1/core-memory' }, auth: 'tenant', mcp: { toolName: 'memory_get_core_memory', core: false } },
  { name: 'setAliases', http: { method: 'POST', path: '/v1/aliases' }, auth: 'tenant', mcp: { toolName: 'memory_set_aliases', core: false } },
  { name: 'getAliases', http: { method: 'GET', path: '/v1/aliases' }, auth: 'tenant', mcp: { toolName: 'memory_get_aliases', core: false } },
  { name: 'getAliasCandidates', http: { method: 'GET', path: '/v1/alias-candidates' }, auth: 'tenant', mcp: { toolName: 'memory_get_alias_candidates', core: false } },
  { name: 'setOntology', http: { method: 'POST', path: '/v1/ontology' }, auth: 'tenant', mcp: { toolName: 'memory_set_ontology', core: false } },
  { name: 'getOntology', http: { method: 'GET', path: '/v1/ontology' }, auth: 'tenant', mcp: { toolName: 'memory_get_ontology', core: false } },
  { name: 'exportBundle', http: { method: 'POST', path: '/v1/bundles/export' }, auth: 'tenant', mcp: { toolName: 'memory_export_bundle', core: false } },
  { name: 'importBundle', http: { method: 'POST', path: '/v1/bundles/import' }, auth: 'tenant', mcp: { toolName: 'memory_import_bundle', core: false } },
  { name: 'refreshDocuments', http: { method: 'POST', path: '/v1/refresh-documents' }, auth: 'tenant', mcp: { toolName: 'memory_refresh_documents', core: false } },
  { name: 'promoteResponse', http: { method: 'POST', path: '/v1/promote-response' }, auth: 'tenant' },
  { name: 'ingestDocument', http: { method: 'POST', path: '/v1/documents' }, auth: 'tenant' },
  { name: 'listDocuments', http: { method: 'GET', path: '/v1/documents' }, auth: 'tenant' },
  { name: 'exportMarkdown', http: { method: 'GET', path: '/v1/export/markdown' }, auth: 'tenant' },
  { name: 'lintKnowledge', http: { method: 'POST', path: '/v1/lint/knowledge' }, auth: 'tenant' },

  // ---- turns / exchanges / context --------------------------------------
  { name: 'storeTurn', http: { method: 'POST', path: '/v1/turns' }, auth: 'tenant', mcp: { toolName: 'memory_store_turn', core: true } },
  { name: 'storeExchange', http: { method: 'POST', path: '/v1/exchanges' }, auth: 'tenant', mcp: { toolName: 'memory_store_exchange', core: true } },
  { name: 'getContext', http: { method: 'GET', path: '/v1/context' }, auth: 'tenant', mcp: { toolName: 'memory_get_context', core: true } },
  { name: 'requestContext', http: { method: 'POST', path: '/v1/context/request' }, auth: 'tenant', mcp: { toolName: 'memory_request_context', core: false } },

  // ---- governance (admin) -----------------------------------------------
  { name: 'getContextConfig', http: { method: 'GET', path: '/v1/context/config' }, auth: 'admin', mcp: { toolName: 'memory_get_context_config', core: false } },
  { name: 'setDefaultContract', http: { method: 'PUT', path: '/v1/context/config/default-contract' }, auth: 'admin', mcp: { toolName: 'memory_set_default_context_contract', core: false } },
  { name: 'deleteDefaultContract', http: { method: 'DELETE', path: '/v1/context/config/default-contract' }, auth: 'admin' },
  { name: 'putContract', http: { method: 'PUT', path: '/v1/context/config/contracts/{name}' }, auth: 'admin', mcp: { toolName: 'memory_put_context_contract', core: false } },
  { name: 'deleteContract', http: { method: 'DELETE', path: '/v1/context/config/contracts/{name}' }, auth: 'admin', mcp: { toolName: 'memory_delete_context_contract', core: false } },
  { name: 'putInvariant', http: { method: 'PUT', path: '/v1/context/config/invariants/{id}' }, auth: 'admin', mcp: { toolName: 'memory_put_context_invariant', core: false } },
  { name: 'deleteInvariant', http: { method: 'DELETE', path: '/v1/context/config/invariants/{id}' }, auth: 'admin', mcp: { toolName: 'memory_delete_context_invariant', core: false } },
  { name: 'setEscalationPolicy', http: { method: 'PUT', path: '/v1/context/config/escalation-policy' }, auth: 'admin', mcp: { toolName: 'memory_set_context_escalation_policy', core: false } },

  // ---- temporal ----------------------------------------------------------
  { name: 'getStateAt', http: { method: 'GET', path: '/v1/state' }, auth: 'tenant', mcp: { toolName: 'memory_get_state_at', core: false } },
  { name: 'getTimeline', http: { method: 'GET', path: '/v1/timeline' }, auth: 'tenant', mcp: { toolName: 'memory_get_timeline', core: false } },
  { name: 'diffState', http: { method: 'GET', path: '/v1/state/diff' }, auth: 'tenant', mcp: { toolName: 'memory_diff_state', core: false } },
  { name: 'listEvents', http: { method: 'GET', path: '/v1/events/log' }, auth: 'tenant', mcp: { toolName: 'memory_list_events', core: false } },
  { name: 'streamChanges', http: { method: 'GET', path: '/v1/changes/stream' }, auth: 'tenant', mcp: { toolName: 'memory_stream_changes', core: false } },

  // ---- search ------------------------------------------------------------
  { name: 'search', http: { method: 'GET', path: '/v1/search' }, auth: 'tenant', mcp: { toolName: 'memory_search', core: true } },
  { name: 'searchCrossScope', http: { method: 'GET', path: '/v1/search/cross-scope' }, auth: 'tenant', mcp: { toolName: 'memory_search_cross_scope', core: true } },

  // ---- inspection --------------------------------------------------------
  { name: 'inspectKnowledgeList', http: { method: 'GET', path: '/v1/inspect/knowledge' }, auth: 'tenant' },
  { name: 'inspectKnowledgeItem', http: { method: 'GET', path: '/v1/inspect/knowledge/{knowledgeId:int}' }, auth: 'tenant' },
  { name: 'inspectAudits', http: { method: 'GET', path: '/v1/inspect/audits' }, auth: 'tenant' },
  { name: 'inspectMonitor', http: { method: 'GET', path: '/v1/inspect/monitor' }, auth: 'tenant' },
  { name: 'inspectCompactions', http: { method: 'GET', path: '/v1/inspect/compactions' }, auth: 'tenant' },
  { name: 'inspectContext', http: { method: 'GET', path: '/v1/inspect/context' }, auth: 'tenant' },
  { name: 'inspectSessionState', http: { method: 'GET', path: '/v1/inspect/session-state' }, auth: 'tenant' },
  { name: 'inspectRetrieval', http: { method: 'GET', path: '/v1/inspect/retrieval' }, auth: 'tenant' },
  { name: 'inspectReverification', http: { method: 'GET', path: '/v1/inspect/reverification' }, auth: 'tenant' },

  // ---- facts / work ------------------------------------------------------
  { name: 'learnFact', http: { method: 'POST', path: '/v1/facts' }, auth: 'tenant', mcp: { toolName: 'memory_learn_fact', core: true } },
  { name: 'trackWork', http: { method: 'POST', path: '/v1/work' }, auth: 'tenant', mcp: { toolName: 'memory_track_work', core: true } },
  { name: 'updateWorkItem', http: { method: 'POST', path: '/v1/work-items/{id:int}' }, auth: 'tenant', mcp: { toolName: 'memory_update_work_item', core: true } },
  { name: 'claimWorkItem', http: { method: 'POST', path: '/v1/work-items/{id:int}/claim' }, auth: 'tenant', mcp: { toolName: 'memory_claim_work_item', core: true } },
  { name: 'renewWorkClaim', http: { method: 'POST', path: '/v1/work-claims/{id:int}/renew' }, auth: 'tenant', mcp: { toolName: 'memory_renew_work_claim', core: false } },
  { name: 'releaseWorkClaim', http: { method: 'POST', path: '/v1/work-claims/{id:int}/release' }, auth: 'tenant', mcp: { toolName: 'memory_release_work_claim', core: true } },
  { name: 'listWorkClaims', http: { method: 'GET', path: '/v1/work-claims' }, auth: 'tenant', mcp: { toolName: 'memory_list_work_claims', core: true } },
  { name: 'handoffWorkItem', http: { method: 'POST', path: '/v1/work-items/{id:int}/handoffs' }, auth: 'tenant', mcp: { toolName: 'memory_handoff_work_item', core: true } },
  { name: 'acceptHandoff', http: { method: 'POST', path: '/v1/handoffs/{id:int}/accept' }, auth: 'tenant', mcp: { toolName: 'memory_accept_handoff', core: true } },
  { name: 'rejectHandoff', http: { method: 'POST', path: '/v1/handoffs/{id:int}/reject' }, auth: 'tenant', mcp: { toolName: 'memory_reject_handoff', core: false } },
  { name: 'cancelHandoff', http: { method: 'POST', path: '/v1/handoffs/{id:int}/cancel' }, auth: 'tenant', mcp: { toolName: 'memory_cancel_handoff', core: false } },
  { name: 'listPendingHandoffs', http: { method: 'GET', path: '/v1/handoffs' }, auth: 'tenant', mcp: { toolName: 'memory_list_pending_handoffs', core: true } },

  // ---- lifecycle / health (admin where privileged) ----------------------
  { name: 'forceCompact', http: { method: 'POST', path: '/v1/compact' }, auth: 'admin', mcp: { toolName: 'memory_force_compact', core: false } },
  { name: 'getHealth', http: { method: 'GET', path: '/v1/health' }, auth: 'tenant', mcp: { toolName: 'memory_get_health', core: true } },
  { name: 'runMaintenance', http: { method: 'POST', path: '/v1/maintenance' }, auth: 'admin', mcp: { toolName: 'memory_run_maintenance', core: false } },
  { name: 'reverifyKnowledge', http: { method: 'POST', path: '/v1/reverification/run' }, auth: 'admin' },
  { name: 'reverifyKnowledgeItem', http: { method: 'POST', path: '/v1/reverification/{knowledgeId:int}' }, auth: 'admin' },

  // ---- changes / events --------------------------------------------------
  { name: 'listChanges', http: { method: 'GET', path: '/v1/changes' }, auth: 'tenant' },
  { name: 'eventsStream', http: { method: 'GET', path: '/v1/events' }, auth: 'tenant' },

  // ---- episodes / reflect / cognitive / profile -------------------------
  { name: 'searchEpisodes', http: { method: 'GET', path: '/v1/episodes' }, auth: 'tenant', mcp: { toolName: 'memory_search_episodes', core: true } },
  { name: 'summarizeEpisode', http: { method: 'POST', path: '/v1/episodes/summarize' }, auth: 'tenant', mcp: { toolName: 'memory_summarize_episode', core: false } },
  { name: 'reflect', http: { method: 'POST', path: '/v1/reflect' }, auth: 'tenant', mcp: { toolName: 'memory_reflect', core: true } },
  { name: 'searchCognitive', http: { method: 'GET', path: '/v1/memory' }, auth: 'tenant', mcp: { toolName: 'memory_search_cognitive', core: false } },
  { name: 'getProfile', http: { method: 'GET', path: '/v1/profile' }, auth: 'tenant', mcp: { toolName: 'memory_get_profile', core: true } },

  // ---- playbooks ---------------------------------------------------------
  { name: 'createPlaybook', http: { method: 'POST', path: '/v1/playbooks' }, auth: 'tenant', mcp: { toolName: 'memory_create_playbook', core: true } },
  { name: 'listPlaybooks', http: { method: 'GET', path: '/v1/playbooks' }, auth: 'tenant', mcp: { toolName: 'memory_search_playbooks', core: true } },
  { name: 'createPlaybookFromTask', http: { method: 'POST', path: '/v1/playbooks/from-task' }, auth: 'tenant', mcp: { toolName: 'memory_create_playbook_from_task', core: false } },
  { name: 'getPlaybook', http: { method: 'GET', path: '/v1/playbooks/{playbookId:int}' }, auth: 'tenant' },
  { name: 'updatePlaybook', http: { method: 'PUT', path: '/v1/playbooks/{playbookId:int}' }, auth: 'tenant' },
  { name: 'revisePlaybook', http: { method: 'POST', path: '/v1/playbooks/{playbookId:int}/revise' }, auth: 'tenant', mcp: { toolName: 'memory_revise_playbook', core: false } },
  { name: 'usePlaybook', http: { method: 'POST', path: '/v1/playbooks/{playbookId:int}/use' }, auth: 'tenant', mcp: { toolName: 'memory_use_playbook', core: true } },

  // ---- associations ------------------------------------------------------
  { name: 'addAssociation', http: { method: 'POST', path: '/v1/associations' }, auth: 'tenant', mcp: { toolName: 'memory_add_association', core: true } },
  { name: 'traverseAssociations', http: { method: 'POST', path: '/v1/associations/traverse' }, auth: 'tenant' },
  { name: 'getAssociations', http: { method: 'GET', path: '/v1/associations/{kind:slug}/{id:int}' }, auth: 'tenant', mcp: { toolName: 'memory_get_associations', core: true } },
  { name: 'removeAssociation', http: { method: 'DELETE', path: '/v1/associations/{id:int}' }, auth: 'tenant', mcp: { toolName: 'memory_remove_association', core: false } },

  // ---- documents (single) / sessions snapshots --------------------------
  { name: 'getDocument', http: { method: 'GET', path: '/v1/documents/{id:int}' }, auth: 'tenant' },
  { name: 'captureSnapshot', http: { method: 'POST', path: '/v1/sessions/{id}/snapshot' }, auth: 'tenant', mcp: { toolName: 'memory_snapshot', core: true } },
  { name: 'getSnapshot', http: { method: 'GET', path: '/v1/sessions/{id}/snapshot' }, auth: 'tenant' },
  { name: 'refreshSnapshot', http: { method: 'POST', path: '/v1/sessions/{id}/refresh' }, auth: 'tenant' },
];

/** The MCP tool names in the default "core" set (daily drivers). */
export const CORE_MCP_TOOL_NAMES: readonly string[] = OPERATIONS.flatMap((op) =>
  op.mcp && op.mcp.core ? [op.mcp.toolName] : [],
);

/** Every MCP tool name declared by the registry (core + full/admin). */
export const ALL_MCP_TOOL_NAMES: readonly string[] = OPERATIONS.flatMap((op) =>
  op.mcp ? [op.mcp.toolName] : [],
);
