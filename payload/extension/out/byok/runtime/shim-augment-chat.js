"use strict";

const { debug, warn } = require("../infra/log");
const { normalizeString } = require("../infra/util");
const { captureAugmentToolDefinitions } = require("../config/state");
const { maybeSummarizeAndCompactAugmentChatRequest } = require("../core/augment-history-summary-auto");
const {
  maybeInjectOfficialCodebaseRetrieval,
  maybeInjectOfficialContextCanvas,
  maybeInjectOfficialExternalSources
} = require("./official");
const { providerLabel } = require("./shim-common");

function captureAugmentChatToolDefinitions({ endpoint, req, provider, providerType, requestedModel, conversationId, requestId }) {
  const ep = normalizeString(endpoint);
  if (!ep) return false;
  const r = req && typeof req === "object" ? req : {};
  try {
    captureAugmentToolDefinitions(r.tool_definitions, {
      endpoint: ep,
      providerId: normalizeString(provider?.id),
      providerType: normalizeString(providerType),
      requestedModel: normalizeString(requestedModel),
      conversationId: normalizeString(conversationId),
      ...(requestId ? { requestId: normalizeString(requestId) } : {})
    });
    return true;
  } catch {
    return false;
  }
}

function summarizeAugmentChatRequest(req) {
  const r = req && typeof req === "object" ? req : {};
  const msg = normalizeString(r.message);
  const hasNodes = Array.isArray(r.nodes) && r.nodes.length;
  const hasHistory = Array.isArray(r.chat_history) && r.chat_history.length;
  const hasReqNodes =
    (Array.isArray(r.structured_request_nodes) && r.structured_request_nodes.length) ||
    (Array.isArray(r.request_nodes) && r.request_nodes.length);
  const toolDefs = Array.isArray(r.tool_definitions) ? r.tool_definitions.length : 0;
  return { msg, hasNodes, hasHistory, hasReqNodes, toolDefs };
}

function isAugmentChatRequestEmpty(summary) {
  const s = summary && typeof summary === "object" ? summary : {};
  return !normalizeString(s.msg) && !s.hasNodes && !s.hasHistory && !s.hasReqNodes;
}

function logAugmentChatStart({ kind, requestId, provider, providerType, model, requestedModel, conversationId, summary }) {
  const label = normalizeString(kind) === "chat-stream" ? "chat-stream" : "chat";
  const rid = normalizeString(requestId);
  const s = summary && typeof summary === "object" ? summary : {};
  const msgLen = normalizeString(s.msg).length;

  debug(
    `[${label}] start${rid ? ` rid=${rid}` : ""} provider=${providerLabel(provider)} type=${normalizeString(providerType) || "unknown"} model=${normalizeString(model) || "unknown"} requestedModel=${normalizeString(requestedModel) || "unknown"} conv=${normalizeString(conversationId) || "n/a"} tool_defs=${Number(s.toolDefs) || 0} msg_len=${msgLen} has_nodes=${String(Boolean(s.hasNodes))} has_history=${String(Boolean(s.hasHistory))} has_req_nodes=${String(Boolean(s.hasReqNodes))}`
  );
}

async function prepareAugmentChatRequestForByok({ cfg, req, requestedModel, fallbackProvider, fallbackModel, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken, requestId }) {
  const rid = normalizeString(requestId);
  try {
    await maybeSummarizeAndCompactAugmentChatRequest({
      cfg,
      req,
      requestedModel,
      fallbackProvider,
      fallbackModel,
      timeoutMs,
      abortSignal
    });
  } catch (err) {
    warn("historySummary failed (ignored)", { requestId: rid, error: err instanceof Error ? err.message : String(err) });
  }

  await maybeInjectOfficialCodebaseRetrieval({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken });
  await maybeInjectOfficialContextCanvas({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken });
  await maybeInjectOfficialExternalSources({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken });
}

function resolveSupportToolUseStart(req) {
  const r = req && typeof req === "object" ? req : {};
  const fdf = r.feature_detection_flags && typeof r.feature_detection_flags === "object" ? r.feature_detection_flags : {};
  return fdf.support_tool_use_start === true || fdf.supportToolUseStart === true;
}

module.exports = {
  captureAugmentChatToolDefinitions,
  summarizeAugmentChatRequest,
  isAugmentChatRequestEmpty,
  logAugmentChatStart,
  prepareAugmentChatRequestForByok,
  resolveSupportToolUseStart
};

