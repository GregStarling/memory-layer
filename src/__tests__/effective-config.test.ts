import { describe, expect, it } from 'vitest';

import { resolveEffectiveConfig } from '../composition/quick.js';

describe('resolveEffectiveConfig', () => {
  it('attributes an unlayered field to the built-in default', () => {
    // softScoreThreshold is set by neither the preset, the quality profile, nor
    // the caller, so it must fall through to DEFAULT_MONITOR_POLICY.
    const config = resolveEffectiveConfig({ preset: 'ai_ide' });
    expect(config.monitorPolicy.softScoreThreshold).toEqual({ value: 4, source: 'default' });
  });

  it('attributes a preset-provided field to the preset', () => {
    const config = resolveEffectiveConfig({ preset: 'ai_ide' });
    // ai_ide overrides softTurnThreshold to 18 over the default of 15.
    expect(config.monitorPolicy.softTurnThreshold).toEqual({ value: 18, source: 'preset' });
  });

  it('lets a user policy override win over the preset (preset-vs-user provenance)', () => {
    const config = resolveEffectiveConfig({
      preset: 'ai_ide',
      policies: { monitor: { softTurnThreshold: 99 } },
    });
    expect(config.monitorPolicy.softTurnThreshold).toEqual({ value: 99, source: 'user' });
  });

  it('attributes a quality-profile field to qualityMode over the preset', () => {
    // ai_ide sets minConfidenceForPromotion='medium'; high_fidelity_memory
    // raises it to 'high', so qualityMode must win.
    const config = resolveEffectiveConfig({
      preset: 'ai_ide',
      qualityMode: 'high_fidelity_memory',
    });
    expect(config.extractionPolicy.minConfidenceForPromotion).toEqual({
      value: 'high',
      source: 'qualityMode',
    });
  });

  it('honors the full precedence chain default < preset < qualityMode < user', () => {
    const config = resolveEffectiveConfig({
      preset: 'ai_ide',
      qualityMode: 'high_fidelity_memory',
      policies: { extraction: { minConfidenceForPromotion: 'low' } },
    });
    expect(config.extractionPolicy.minConfidenceForPromotion).toEqual({
      value: 'low',
      source: 'user',
    });
  });

  it('tracks scalar provenance for autoCompact and crossScopeLevel', () => {
    const preset = resolveEffectiveConfig({ preset: 'ai_ide' });
    expect(preset.autoCompact).toEqual({ value: true, source: 'preset' });
    expect(preset.crossScopeLevel).toEqual({ value: 'workspace', source: 'preset' });

    const overridden = resolveEffectiveConfig({
      preset: 'ai_ide',
      autoCompact: false,
      crossScopeLevel: 'scope',
    });
    expect(overridden.autoCompact).toEqual({ value: false, source: 'user' });
    expect(overridden.crossScopeLevel).toEqual({ value: 'scope', source: 'user' });
  });

  it('maps a legacy qualityTier onto the resolved qualityMode and records it', () => {
    const config = resolveEffectiveConfig({ qualityTier: 'provider_backed' });
    expect(config.qualityMode).toBe('high_fidelity_memory');
    expect(config.qualityTier).toBe('provider_backed');
  });

  it('defaults preset to chat_agent and qualityTier to null', () => {
    const config = resolveEffectiveConfig();
    expect(config.preset).toBe('chat_agent');
    expect(config.qualityMode).toBe('balanced_memory');
    expect(config.qualityTier).toBeNull();
  });
});
