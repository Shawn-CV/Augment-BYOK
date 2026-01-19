"use strict";

const { debug, warn } = require("../infra/log");
const { withTiming, traceAsyncGenerator } = require("../infra/trace");
const { ensureConfigManager, state } = require("../config/state");
const { decideRoute } = require("../core/router");
const { normalizeEndpoint, normalizeString, safeTransform, emptyAsyncGenerator, randomId } = require("../infra/util");
const { makeEndpointErrorText, guardObjectStream } = require("../core/stream-guard");
const { buildMessagesForEndpoint, makeBackChatResult, makeBackNextEditGenerationChunk } = require("../core/protocol");
const { pickPath, pickBlobNameHint } = require("../core/next-edit-fields");
const { buildNextEditStreamRuntimeContext } = require("../core/next-edit-stream-utils");
const { STOP_REASON_END_TURN, makeBackChatChunk } = require("../core/augment-protocol");
const { byokCompleteText, byokStreamText } = require("./shim-byok-text");
const { byokChatStream } = require("./shim-byok-chat-stream");
const { maybeAugmentBodyWithWorkspaceBlob, buildInstructionReplacementMeta } = require("./shim-next-edit");
const {
  normalizeTimeoutMs,
  maybeDeleteHistorySummaryCacheForEndpoint,
  providerLabel,
  formatRouteForLog
} = require("./shim-common");

function guardWithMeta({ ep, src, transform, makeErrorChunk, requestId, route }) {
  return guardObjectStream({
    ep,
    src,
    transform,
    makeErrorChunk,
    logMeta: {
      requestId,
      route: formatRouteForLog(route)
    }
  });
}

async function handleChatStream({ cfg, route, ep, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL, requestId }) {
  const src = byokChatStream({
    cfg,
    provider: route.provider,
    model: route.model,
    requestedModel: route.requestedModel,
    body,
    timeoutMs,
    abortSignal,
    upstreamApiToken,
    upstreamCompletionURL,
    requestId
  });
  return guardWithMeta({
    ep,
    src,
    transform,
    requestId,
    route,
    makeErrorChunk: (err) => makeBackChatChunk({ text: makeEndpointErrorText(ep, err), stop_reason: STOP_REASON_END_TURN })
  });
}

async function handleChatResultDeltaStream({ route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const { system, messages } = buildMessagesForEndpoint(ep, body);
  const label = `[callApiStream ${ep}] rid=${requestId} delta provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
  const deltas = traceAsyncGenerator(label, byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs, abortSignal }));

  const src = (async function* () {
    for await (const delta of deltas) yield makeBackChatResult(delta, { nodes: [] });
  })();

  return guardWithMeta({
    ep,
    transform,
    src,
    requestId,
    route,
    makeErrorChunk: (err) => makeBackChatResult(makeEndpointErrorText(ep, err), { nodes: [] })
  });
}

async function handleInstructionLikeStream({ route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const { system, messages } = buildMessagesForEndpoint(ep, body);
  const meta = await buildInstructionReplacementMeta(body);
  const label = `[callApiStream ${ep}] rid=${requestId} delta provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
  const deltas = traceAsyncGenerator(label, byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs, abortSignal }));

  const src = (async function* () {
    yield { text: "", ...meta };
    for await (const delta of deltas) {
      const t = typeof delta === "string" ? delta : String(delta ?? "");
      if (!t) continue;
      yield { text: t, replacement_text: t };
    }
  })();

  return guardWithMeta({
    ep,
    transform,
    src,
    requestId,
    route,
    makeErrorChunk: (err) => ({ text: makeEndpointErrorText(ep, err), ...meta })
  });
}

async function handleNextEditStream({ route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const b = body && typeof body === "object" ? body : {};
  const hasPrefix = typeof b.prefix === "string";
  const hasSuffix = typeof b.suffix === "string";
  const bodyForContext =
    hasPrefix && hasSuffix
      ? b
      : await maybeAugmentBodyWithWorkspaceBlob(body, { pathHint: pickPath(body), blobKey: pickBlobNameHint(body) });

  const { promptBody, path, blobName, selectionBegin, selectionEnd, existingCode } = buildNextEditStreamRuntimeContext(bodyForContext);
  const { system, messages } = buildMessagesForEndpoint(ep, promptBody);
  const label = `[callApiStream ${ep}] rid=${requestId} complete provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
  const suggestedCode = await withTiming(label, async () =>
    await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs, abortSignal })
  );

  const raw = makeBackNextEditGenerationChunk({
    path: path || blobName,
    blobName,
    charStart: selectionBegin,
    charEnd: selectionEnd,
    existingCode,
    suggestedCode
  });
  return (async function* () { yield safeTransform(transform, raw, ep); })();
}

async function maybeHandleCallApiStream({ endpoint, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL }) {
  const requestId = randomId();
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return undefined;
  await maybeDeleteHistorySummaryCacheForEndpoint(ep, body);

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();
  if (!state.runtimeEnabled) return undefined;

  const route = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  debug(`[callApiStream] ${formatRouteForLog(route, { requestId })}`);
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") return emptyAsyncGenerator();
  if (route.mode !== "byok") return undefined;

  const t = normalizeTimeoutMs(timeoutMs);

  try {
    if (ep === "/chat-stream") {
      return await handleChatStream({ cfg, route, ep, body, transform, timeoutMs: t, abortSignal, upstreamApiToken, upstreamCompletionURL, requestId });
    }
    if (ep === "/prompt-enhancer" || ep === "/generate-conversation-title") {
      return await handleChatResultDeltaStream({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
    if (ep === "/instruction-stream" || ep === "/smart-paste-stream") {
      return await handleInstructionLikeStream({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
    if (ep === "/generate-commit-message-stream") {
      return await handleChatResultDeltaStream({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
    if (ep === "/next-edit-stream") {
      return await handleNextEditStream({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn("callApiStream BYOK failed, fallback official", { requestId, endpoint: ep, error: msg });
    return undefined;
  }

  return undefined;
}

module.exports = { maybeHandleCallApiStream };
