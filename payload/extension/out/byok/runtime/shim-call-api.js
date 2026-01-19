"use strict";

const { debug, warn } = require("../infra/log");
const { withTiming } = require("../infra/trace");
const { ensureConfigManager, state } = require("../config/state");
const { decideRoute } = require("../core/router");
const { normalizeEndpoint, normalizeString, normalizeRawToken, safeTransform, randomId } = require("../infra/util");
const { getOfficialConnection } = require("../config/official");
const { fetchOfficialGetModels, mergeModels } = require("./official");
const { normalizeAugmentChatRequest, buildSystemPrompt, buildOpenAiMessages, buildOpenAiResponsesInput, buildAnthropicMessages, buildGeminiContents } = require("../core/augment-chat");
const { openAiCompleteText } = require("../providers/openai");
const { openAiResponsesCompleteText } = require("../providers/openai-responses");
const { anthropicCompleteText } = require("../providers/anthropic");
const { geminiCompleteText } = require("../providers/gemini");
const { buildMessagesForEndpoint, makeBackTextResult, makeBackChatResult, makeBackCompletionResult, buildByokModelsFromConfig, makeBackGetModelsResult, makeModelInfo } = require("../core/protocol");
const { parseNextEditLocCandidatesFromText, mergeNextEditLocCandidates } = require("../core/next-edit-loc-utils");
const { pickPath, pickNumResults } = require("../core/next-edit-fields");
const { byokCompleteText } = require("./shim-byok-text");
const { maybeAugmentBodyWithWorkspaceBlob, pickNextEditLocationCandidates } = require("./shim-next-edit");
const {
  captureAugmentChatToolDefinitions,
  summarizeAugmentChatRequest,
  isAugmentChatRequestEmpty,
  logAugmentChatStart,
  prepareAugmentChatRequestForByok
} = require("./shim-augment-chat");
const {
  normalizeTimeoutMs,
  maybeDeleteHistorySummaryCacheForEndpoint,
  providerLabel,
  formatRouteForLog,
  providerRequestContext
} = require("./shim-common");

async function handleGetModels({ cfg, ep, transform, abortSignal, timeoutMs, upstreamApiToken, upstreamCompletionURL, requestId }) {
  const byokModels = buildByokModelsFromConfig(cfg);
  const byokDefaultModel = byokModels.length ? byokModels[0] : "";
  const activeProvider = Array.isArray(cfg?.providers) ? cfg.providers[0] : null;
  const activeProviderId = normalizeString(activeProvider?.id);
  const activeProviderDefaultModel = normalizeString(activeProvider?.defaultModel) || normalizeString(activeProvider?.models?.[0]);
  const preferredByok = activeProviderId && activeProviderDefaultModel ? `byok:${activeProviderId}:${activeProviderDefaultModel}` : "";
  const preferredDefaultModel = byokModels.includes(preferredByok) ? preferredByok : byokDefaultModel;

  try {
    const off = getOfficialConnection();
    const completionURL = normalizeString(upstreamCompletionURL) || off.completionURL;
    const apiToken = normalizeRawToken(upstreamApiToken) || off.apiToken;
    const upstream = await withTiming(`[callApi ${ep}] rid=${requestId} official/get-models`, async () =>
      await fetchOfficialGetModels({ completionURL, apiToken, timeoutMs: Math.min(12000, timeoutMs), abortSignal })
    );
    const merged = mergeModels(upstream, byokModels, { defaultModel: preferredDefaultModel });
    return safeTransform(transform, merged, ep);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn("get-models fallback to local", { requestId, error: msg });
    const local = makeBackGetModelsResult({ defaultModel: preferredDefaultModel || "unknown", models: byokModels.map(makeModelInfo) });
    return safeTransform(transform, local, ep);
  }
}

async function handleCompletion({ route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const { system, messages } = buildMessagesForEndpoint(ep, body);
  const label = `[callApi ${ep}] rid=${requestId} complete provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
  const text = await withTiming(label, async () =>
    await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs, abortSignal })
  );
  return safeTransform(transform, makeBackCompletionResult(text), ep);
}

async function handleEdit({ route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const { system, messages } = buildMessagesForEndpoint(ep, body);
  const label = `[callApi ${ep}] rid=${requestId} edit provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
  const text = await withTiming(label, async () =>
    await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs, abortSignal })
  );
  return safeTransform(transform, makeBackTextResult(text), ep);
}

async function handleChat({ cfg, route, ep, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL, requestId }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(route.provider);
  const req = normalizeAugmentChatRequest(body);
  const conversationId = normalizeString(req?.conversation_id ?? req?.conversationId ?? req?.conversationID);
  captureAugmentChatToolDefinitions({
    endpoint: "/chat",
    req,
    provider: route.provider,
    providerType: type,
    requestedModel: route.requestedModel,
    conversationId,
    requestId
  });

  const summary = summarizeAugmentChatRequest(req);
  logAugmentChatStart({
    kind: "chat",
    requestId,
    provider: route.provider,
    providerType: type,
    model: route.model,
    requestedModel: route.requestedModel,
    conversationId,
    summary
  });

  if (isAugmentChatRequestEmpty(summary)) return safeTransform(transform, makeBackChatResult("", { nodes: [] }), ep);

  await prepareAugmentChatRequestForByok({
    cfg,
    req,
    requestedModel: route.requestedModel,
    fallbackProvider: route.provider,
    fallbackModel: route.model,
    timeoutMs,
    abortSignal,
    upstreamCompletionURL,
    upstreamApiToken,
    requestId
  });

  const chatLabel = `[callApi ${ep}] rid=${requestId} provider=${providerLabel(route.provider)} type=${type || "unknown"} model=${normalizeString(route.model) || "unknown"}`;
  if (type === "openai_compatible") {
    const text = await withTiming(chatLabel, async () =>
      await openAiCompleteText({ baseUrl, apiKey, model: route.model, messages: buildOpenAiMessages(req), timeoutMs, abortSignal, extraHeaders, requestDefaults })
    );
    return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
  }
  if (type === "anthropic") {
    const text = await withTiming(chatLabel, async () =>
      await anthropicCompleteText({ baseUrl, apiKey, model: route.model, system: buildSystemPrompt(req), messages: buildAnthropicMessages(req), timeoutMs, abortSignal, extraHeaders, requestDefaults })
    );
    return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
  }
  if (type === "openai_responses") {
    const { instructions, input } = buildOpenAiResponsesInput(req);
    const text = await withTiming(chatLabel, async () =>
      await openAiResponsesCompleteText({ baseUrl, apiKey, model: route.model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults })
    );
    return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = buildGeminiContents(req);
    const text = await withTiming(chatLabel, async () =>
      await geminiCompleteText({ baseUrl, apiKey, model: route.model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults })
    );
    return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function handleNextEditLoc({ route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const b = body && typeof body === "object" ? body : {};
  const max = pickNumResults(b, { defaultValue: 1, max: 6 });

  const baseline = pickNextEditLocationCandidates(body);
  const fallbackPath = pickPath(b) || normalizeString(baseline?.[0]?.item?.path);
  let llmCandidates = [];

  try {
    const bodyForPrompt = await maybeAugmentBodyWithWorkspaceBlob(body, { pathHint: fallbackPath });
    const { system, messages } = buildMessagesForEndpoint(ep, bodyForPrompt);
    const label = `[callApi ${ep}] rid=${requestId} llm provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
    const text = await withTiming(label, async () =>
      await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs, abortSignal })
    );
    llmCandidates = parseNextEditLocCandidatesFromText(text, { fallbackPath, max, source: "byok:llm" });
  } catch (err) {
    warn("next_edit_loc llm fallback to diagnostics", { requestId, error: err instanceof Error ? err.message : String(err) });
  }

  if (!llmCandidates.length) return safeTransform(transform, makeBackNextEditLocationResult(baseline), ep);
  const merged = mergeNextEditLocCandidates({ baseline, llmCandidates, max });
  return safeTransform(transform, makeBackNextEditLocationResult(merged), ep);
}

async function maybeHandleCallApi({ endpoint, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL }) {
  const requestId = randomId();
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return undefined;
  await maybeDeleteHistorySummaryCacheForEndpoint(ep, body);

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();
  if (!state.runtimeEnabled) return undefined;

  const route = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  debug(`[callApi] ${formatRouteForLog(route, { requestId })}`);
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") {
    try {
      return safeTransform(transform, {}, `disabled:${ep}`);
    } catch {
      return {};
    }
  }
  if (route.mode !== "byok") return undefined;

  const t = normalizeTimeoutMs(timeoutMs);

  try {
    if (ep === "/get-models") {
      return await handleGetModels({ cfg, ep, transform, abortSignal, timeoutMs: t, upstreamApiToken, upstreamCompletionURL, requestId });
    }
    if (ep === "/completion" || ep === "/chat-input-completion") {
      return await handleCompletion({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
    if (ep === "/edit") {
      return await handleEdit({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
    if (ep === "/chat") {
      return await handleChat({ cfg, route, ep, body, transform, timeoutMs: t, abortSignal, upstreamApiToken, upstreamCompletionURL, requestId });
    }
    if (ep === "/next_edit_loc") {
      return await handleNextEditLoc({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn("callApi BYOK failed, fallback official", { requestId, endpoint: ep, error: msg });
    return undefined;
  }

  return undefined;
}

module.exports = { maybeHandleCallApi };
