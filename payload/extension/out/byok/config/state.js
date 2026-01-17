"use strict";

const { createConfigManager } = require("./config");

const RUNTIME_ENABLED_KEY = "augment-byok.runtimeEnabled.v1";
const CONFIG_SYNC_KEYS = [RUNTIME_ENABLED_KEY];

const state = {
  installed: false,
  vscode: null,
  extensionContext: null,
  runtimeEnabled: true,
  configManager: null,
  lastCapturedToolDefinitions: null,
  lastCapturedToolDefinitionsAtMs: 0,
  lastCapturedToolDefinitionsMeta: null
};

async function setRuntimeEnabled(ctx, enabled) {
  state.runtimeEnabled = Boolean(enabled);
  try {
    await ctx?.globalState?.update?.(RUNTIME_ENABLED_KEY, state.runtimeEnabled);
  } catch {}
  return state.runtimeEnabled;
}

function captureAugmentToolDefinitions(toolDefinitions, meta) {
  const defs = Array.isArray(toolDefinitions) ? toolDefinitions.filter((x) => x && typeof x === "object") : [];
  if (!defs.length) return false;
  state.lastCapturedToolDefinitions = defs;
  state.lastCapturedToolDefinitionsAtMs = Date.now();
  state.lastCapturedToolDefinitionsMeta = meta && typeof meta === "object" ? meta : null;
  return true;
}

function getLastCapturedToolDefinitions() {
  const defs = Array.isArray(state.lastCapturedToolDefinitions) ? state.lastCapturedToolDefinitions : [];
  return {
    toolDefinitions: defs,
    capturedAtMs: Number(state.lastCapturedToolDefinitionsAtMs) || 0,
    meta: state.lastCapturedToolDefinitionsMeta && typeof state.lastCapturedToolDefinitionsMeta === "object" ? state.lastCapturedToolDefinitionsMeta : null
  };
}

function ensureConfigManager(opts) {
  if (!state.configManager) state.configManager = createConfigManager();
  const ctx = opts && typeof opts === "object" ? opts.ctx : null;
  if (ctx && typeof state.configManager.attachContext === "function") state.configManager.attachContext(ctx);
  return state.configManager;
}

module.exports = { state, setRuntimeEnabled, captureAugmentToolDefinitions, getLastCapturedToolDefinitions, ensureConfigManager, CONFIG_SYNC_KEYS, RUNTIME_ENABLED_KEY };
