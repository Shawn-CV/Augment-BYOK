"use strict";

const { debug } = require("../infra/log");
const { normalizeEndpoint, normalizeString, normalizeRawToken } = require("../infra/util");
const { deleteHistorySummaryCache } = require("../core/augment-history-summary-auto");

const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000;

function normalizeTimeoutMs(timeoutMs) {
  const t = Number(timeoutMs);
  return Number.isFinite(t) && t > 0 ? t : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

async function maybeDeleteHistorySummaryCacheForEndpoint(ep, body) {
  const endpoint = normalizeEndpoint(ep);
  if (!endpoint) return false;
  const lower = endpoint.toLowerCase();
  if (!lower.includes("delete") && !lower.includes("remove") && !lower.includes("archive")) return false;
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  const conversationId = normalizeString(b?.conversation_id ?? b?.conversationId ?? b?.conversationID);
  if (!conversationId) return false;
  try {
    const ok = await deleteHistorySummaryCache(conversationId);
    if (ok) debug(`historySummary cache deleted: conv=${conversationId} endpoint=${endpoint}`);
    return ok;
  } catch (err) {
    debug(`historySummary cache delete failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function resolveProviderApiKey(provider, label) {
  if (!provider || typeof provider !== "object") throw new Error(`${label} provider 无效`);
  return normalizeRawToken(provider.apiKey);
}

function providerLabel(provider) {
  const id = normalizeString(provider?.id);
  const type = normalizeString(provider?.type);
  return `Provider(${id || type || "unknown"})`;
}

function formatRouteForLog(route, opts) {
  const r = route && typeof route === "object" ? route : {};
  const requestId = normalizeString(opts?.requestId);
  const endpoint = normalizeString(r.endpoint);
  const mode = normalizeString(r.mode) || "unknown";
  const reason = normalizeString(r.reason);
  const providerId = normalizeString(r.provider?.id);
  const providerType = normalizeString(r.provider?.type);
  const model = normalizeString(r.model);
  const requestedModel = normalizeString(r.requestedModel);

  const parts = [];
  if (requestId) parts.push(`rid=${requestId}`);
  if (endpoint) parts.push(`ep=${endpoint}`);
  parts.push(`mode=${mode}`);
  if (reason) parts.push(`reason=${reason}`);
  if (providerId || providerType) parts.push(`provider=${providerId || providerType}`);
  if (model) parts.push(`model=${model}`);
  if (requestedModel) parts.push(`requestedModel=${requestedModel}`);
  return parts.join(" ");
}

function providerRequestContext(provider) {
  if (!provider || typeof provider !== "object") throw new Error("BYOK provider 未选择");
  const type = normalizeString(provider.type);
  const baseUrl = normalizeString(provider.baseUrl);
  const apiKey = resolveProviderApiKey(provider, providerLabel(provider));
  const extraHeaders = provider.headers && typeof provider.headers === "object" ? provider.headers : {};
  const requestDefaultsRaw = provider.requestDefaults && typeof provider.requestDefaults === "object" ? provider.requestDefaults : {};

  const requestDefaults =
    requestDefaultsRaw && typeof requestDefaultsRaw === "object" && !Array.isArray(requestDefaultsRaw) ? requestDefaultsRaw : {};
  if (!apiKey && Object.keys(extraHeaders).length === 0) throw new Error(`${providerLabel(provider)} 未配置 api_key（且 headers 为空）`);
  return { type, baseUrl, apiKey, extraHeaders, requestDefaults };
}

module.exports = {
  normalizeTimeoutMs,
  maybeDeleteHistorySummaryCacheForEndpoint,
  providerLabel,
  formatRouteForLog,
  providerRequestContext
};
