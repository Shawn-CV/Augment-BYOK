"use strict";

const nodePath = require("path");

const { warn } = require("../infra/log");
const { ensureConfigManager, state } = require("../config/state");
const { decideRoute } = require("../core/router");
const { normalizeEndpoint, normalizeString, normalizeRawToken, safeTransform, emptyAsyncGenerator } = require("../infra/util");
const { ensureModelRegistryFeatureFlags } = require("../core/model-registry");
const { openAiCompleteText, openAiStreamTextDeltas, openAiChatStreamChunks } = require("../providers/openai");
const { anthropicCompleteText, anthropicStreamTextDeltas, anthropicChatStreamChunks } = require("../providers/anthropic");
const { joinBaseUrl, safeFetch, readTextLimit } = require("../providers/http");
const { getOfficialConnection } = require("../config/official");
const { normalizeAugmentChatRequest, buildSystemPrompt, convertOpenAiTools, convertAnthropicTools, buildToolMetaByName, buildOpenAiMessages, buildAnthropicMessages } = require("../core/augment-chat");
const { maybeSummarizeAndCompactAugmentChatRequest } = require("../core/augment-history-summary-auto");
const { STOP_REASON_END_TURN, makeBackChatChunk } = require("../core/augment-protocol");
const { makeEndpointErrorText, guardObjectStream } = require("../core/stream-guard");
const {
  buildMessagesForEndpoint,
  makeBackTextResult,
  makeBackChatResult,
  makeBackCompletionResult,
  makeBackNextEditGenerationChunk,
  makeBackNextEditLocationResult,
  buildByokModelsFromConfig,
  makeBackGetModelsResult,
  makeModelInfo
} = require("../core/protocol");

function resolveProviderApiKey(provider, label) {
  if (!provider || typeof provider !== "object") throw new Error(`${label} provider 无效`);
  const key = normalizeRawToken(provider.apiKey);
  if (key) return key;
  throw new Error(`${label} 未配置 api_key`);
}

function providerLabel(provider) {
  const id = normalizeString(provider?.id);
  const type = normalizeString(provider?.type);
  return `Provider(${id || type || "unknown"})`;
}

function providerRequestContext(provider) {
  if (!provider || typeof provider !== "object") throw new Error("BYOK provider 未选择");
  const type = normalizeString(provider.type);
  const baseUrl = normalizeString(provider.baseUrl);
  const apiKey = resolveProviderApiKey(provider, providerLabel(provider));
  const extraHeaders = provider.headers && typeof provider.headers === "object" ? provider.headers : {};
  const requestDefaults = provider.requestDefaults && typeof provider.requestDefaults === "object" ? provider.requestDefaults : {};
  return { type, baseUrl, apiKey, extraHeaders, requestDefaults };
}

function asOpenAiMessages(system, messages) {
  const sys = typeof system === "string" ? system : "";
  const ms = Array.isArray(messages) ? messages : [];
  return [{ role: "system", content: sys }, ...ms].filter((m) => m && typeof m.content === "string" && m.content);
}

function asAnthropicMessages(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const out = ms
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  return { system: sys, messages: out };
}

function isTelemetryDisabled(cfg, ep) {
  const list = Array.isArray(cfg?.telemetry?.disabledEndpoints) ? cfg.telemetry.disabledEndpoints : [];
  return list.includes(ep);
}

function normalizeLineNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  return Math.floor(n);
}

function normalizeNewlines(s) {
  return typeof s === "string" ? s.replace(/\r\n/g, "\n") : "";
}

function countNewlines(s) {
  const text = typeof s === "string" ? s : "";
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function clampLineNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  if (v <= 1) return 1;
  return Math.floor(v);
}

function commonPrefixLen(a, b) {
  const s1 = typeof a === "string" ? a : "";
  const s2 = typeof b === "string" ? b : "";
  const n = Math.min(s1.length, s2.length);
  let i = 0;
  for (; i < n; i++) if (s1.charCodeAt(i) !== s2.charCodeAt(i)) break;
  return i;
}

function commonSuffixLen(a, b) {
  const s1 = typeof a === "string" ? a : "";
  const s2 = typeof b === "string" ? b : "";
  const n = Math.min(s1.length, s2.length);
  let i = 0;
  for (; i < n; i++) if (s1.charCodeAt(s1.length - 1 - i) !== s2.charCodeAt(s2.length - 1 - i)) break;
  return i;
}

function bestMatchIndex(haystack, needle, { prefixHint, suffixHint, maxCandidates = 200 } = {}) {
  const h = typeof haystack === "string" ? haystack : "";
  const n = typeof needle === "string" ? needle : "";
  if (!h || !n) return -1;
  const pre = typeof prefixHint === "string" ? prefixHint : "";
  const suf = typeof suffixHint === "string" ? suffixHint : "";
  let bestIdx = -1;
  let bestScore = -1;
  let i = 0;
  for (let pos = h.indexOf(n); pos !== -1; pos = h.indexOf(n, pos + 1)) {
    i += 1;
    if (i > maxCandidates) break;
    const before = pre ? h.slice(Math.max(0, pos - pre.length), pos) : "";
    const after = suf ? h.slice(pos + n.length, pos + n.length + suf.length) : "";
    const score = commonSuffixLen(before, pre) * 2 + commonPrefixLen(after, suf);
    if (score > bestScore || (score === bestScore && pos > bestIdx)) { bestScore = score; bestIdx = pos; }
  }
  return bestIdx;
}

function bestInsertionIndex(haystack, { prefixHint, suffixHint, maxCandidates = 200 } = {}) {
  const h = typeof haystack === "string" ? haystack : "";
  const pre = typeof prefixHint === "string" ? prefixHint : "";
  const suf = typeof suffixHint === "string" ? suffixHint : "";
  if (!h) return 0;
  if (!pre && !suf) return 0;

  if (pre) {
    let bestIdx = -1;
    let bestScore = -1;
    let i = 0;
    for (let pos = h.indexOf(pre); pos !== -1; pos = h.indexOf(pre, pos + 1)) {
      i += 1;
      if (i > maxCandidates) break;
      const ins = pos + pre.length;
      const after = suf ? h.slice(ins, ins + suf.length) : "";
      const score = pre.length * 2 + commonPrefixLen(after, suf);
      if (score > bestScore || (score === bestScore && ins > bestIdx)) { bestScore = score; bestIdx = ins; }
    }
    if (bestIdx >= 0) return bestIdx;
  }

  if (suf) {
    const pos = h.indexOf(suf);
    if (pos >= 0) return pos;
  }
  return 0;
}

function trimTrailingNewlines(s) {
  const t = normalizeNewlines(s);
  return t.replace(/\n+$/g, "");
}

function resolveTextField(obj, keys) {
  const b = obj && typeof obj === "object" ? obj : {};
  for (const k of Array.isArray(keys) ? keys : []) {
    if (typeof b[k] === "string") return b[k];
  }
  return "";
}

async function readWorkspaceFileTextByPath(p) {
  const raw = normalizeString(p);
  if (!raw) return "";
  const vscode = state.vscode;
  const ws = vscode && vscode.workspace ? vscode.workspace : null;
  const Uri = vscode && vscode.Uri ? vscode.Uri : null;
  if (!ws || !ws.fs || typeof ws.fs.readFile !== "function" || !Uri) return "";

  const tryRead = async (uri) => {
    try {
      const bytes = await ws.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return "";
    }
  };

  if (raw.includes("://")) {
    try { return await tryRead(Uri.parse(raw)); } catch {}
  }

  try {
    if (nodePath.isAbsolute(raw)) return await tryRead(Uri.file(raw));
  } catch {}

  const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const folders = Array.isArray(ws.workspaceFolders) ? ws.workspaceFolders : [];
  for (const f of folders) {
    const base = f && f.uri ? f.uri : null;
    if (!base) continue;
    const u = Uri.joinPath(base, rel);
    const txt = await tryRead(u);
    if (txt) return txt;
  }
  return "";
}

async function buildInstructionReplacementMeta(body) {
  const b = body && typeof body === "object" ? body : {};
  const selectedTextRaw = resolveTextField(b, ["selected_text", "selectedText"]);
  const prefixRaw = resolveTextField(b, ["prefix"]);
  const suffixRaw = resolveTextField(b, ["suffix"]);
  const targetPath = normalizeString(resolveTextField(b, ["target_file_path", "targetFilePath"]));
  const path = normalizeString(resolveTextField(b, ["path", "pathName"]));
  const filePath = targetPath || path;

  const targetFileContentRaw = resolveTextField(b, ["target_file_content", "targetFileContent"]);
  const fileTextRaw = targetFileContentRaw ? targetFileContentRaw : await readWorkspaceFileTextByPath(filePath);
  const fileText = normalizeNewlines(fileTextRaw);
  const selectedText = normalizeNewlines(selectedTextRaw);
  const prefix = normalizeNewlines(prefixRaw);
  const suffix = normalizeNewlines(suffixRaw);

  const prefixHint = prefix ? prefix.slice(Math.max(0, prefix.length - 400)) : "";
  const suffixHint = suffix ? suffix.slice(0, 400) : "";

  if (fileText && selectedText) {
    const idx = bestMatchIndex(fileText, selectedText, { prefixHint, suffixHint });
    if (idx >= 0) {
      const startLine = 1 + countNewlines(fileText.slice(0, idx));
      const trimmed = trimTrailingNewlines(selectedText);
      const endLine = startLine + countNewlines(trimmed);
      return { replacement_start_line: clampLineNumber(startLine), replacement_end_line: clampLineNumber(endLine), replacement_old_text: selectedText };
    }
  }

  const insertIdx = fileText ? bestInsertionIndex(fileText, { prefixHint, suffixHint }) : 0;
  const insertLine = fileText ? 1 + countNewlines(fileText.slice(0, insertIdx)) : 1;
  const lines = fileText ? fileText.split("\n") : [];
  const lineBefore = insertLine > 1 && lines[insertLine - 2] != null ? String(lines[insertLine - 2]).trimEnd() : "";
  const oldText = selectedText ? selectedText : `PURE INSERTION AFTER LINE:${lineBefore}`;
  return { replacement_start_line: clampLineNumber(insertLine), replacement_end_line: clampLineNumber(insertLine), replacement_old_text: oldText };
}

function pickNextEditLocationCandidates(body) {
  const b = body && typeof body === "object" ? body : {};
  const max =
    Number.isFinite(Number(b.num_results)) && Number(b.num_results) > 0 ? Math.min(6, Math.floor(Number(b.num_results))) : 1;

  const out = [];
  const diags = Array.isArray(b.diagnostics) ? b.diagnostics : [];
  for (const d of diags) {
    const path = normalizeString(d?.path || d?.file_path || d?.filePath || d?.item?.path);
    if (!path) continue;
    const r = d?.range || d?.item?.range || d?.location?.range;
    const start = normalizeLineNumber(r?.start?.line ?? r?.start_line ?? r?.startLine ?? r?.start);
    if (start === null) continue;
    const stop = normalizeLineNumber(r?.end?.line ?? r?.stop?.line ?? r?.end_line ?? r?.stopLine ?? r?.stop ?? start) ?? start;
    out.push({ item: { path, range: { start, stop: Math.max(start, stop) } }, score: 1, debug_info: { source: "diagnostic" } });
    if (out.length >= max) break;
  }

  if (!out.length) {
    const path = normalizeString(b.path);
    if (path) out.push({ item: { path, range: { start: 0, stop: 0 } }, score: 1, debug_info: { source: "fallback" } });
  }

  return out;
}

async function byokCompleteText({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);

  if (type === "openai_compatible") {
    return await openAiCompleteText({
      baseUrl,
      apiKey,
      model,
      messages: asOpenAiMessages(system, messages),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults
    });
  }
  if (type === "anthropic") {
    const { system: sys, messages: msgs } = asAnthropicMessages(system, messages);
    return await anthropicCompleteText({ baseUrl, apiKey, model, system: sys, messages: msgs, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function* byokStreamText({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);

  if (type === "openai_compatible") {
    yield* openAiStreamTextDeltas({
      baseUrl,
      apiKey,
      model,
      messages: asOpenAiMessages(system, messages),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults
    });
    return;
  }
  if (type === "anthropic") {
    const { system: sys, messages: msgs } = asAnthropicMessages(system, messages);
    yield* anthropicStreamTextDeltas({ baseUrl, apiKey, model, system: sys, messages: msgs, timeoutMs, abortSignal, extraHeaders, requestDefaults });
    return;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function* byokChatStream({ cfg, provider, model, requestedModel, body, timeoutMs, abortSignal }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);
  const req = normalizeAugmentChatRequest(body);
  const msg = normalizeString(req.message);
  const hasNodes = Array.isArray(req.nodes) && req.nodes.length;
  const hasHistory = Array.isArray(req.chat_history) && req.chat_history.length;
  const hasReqNodes = (Array.isArray(req.structured_request_nodes) && req.structured_request_nodes.length) || (Array.isArray(req.request_nodes) && req.request_nodes.length);
  if (!msg && !hasNodes && !hasHistory && !hasReqNodes) {
    yield makeBackChatChunk({ text: "", stop_reason: STOP_REASON_END_TURN });
    return;
  }
  try {
    await maybeSummarizeAndCompactAugmentChatRequest({ cfg, req, requestedModel, fallbackProvider: provider, fallbackModel: model, timeoutMs, abortSignal });
  } catch (err) {
    warn(`historySummary failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
  const toolMetaByName = buildToolMetaByName(req.tool_definitions);
  const fdf = req && typeof req === "object" && req.feature_detection_flags && typeof req.feature_detection_flags === "object" ? req.feature_detection_flags : {};
  const supportToolUseStart = fdf.support_tool_use_start === true || fdf.supportToolUseStart === true;
  if (type === "openai_compatible") {
    yield* openAiChatStreamChunks({ baseUrl, apiKey, model, messages: buildOpenAiMessages(req), tools: convertOpenAiTools(req.tool_definitions), timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    return;
  }
  if (type === "anthropic") {
    yield* anthropicChatStreamChunks({ baseUrl, apiKey, model, system: buildSystemPrompt(req), messages: buildAnthropicMessages(req), tools: convertAnthropicTools(req.tool_definitions), timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    return;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function fetchOfficialGetModels({ completionURL, apiToken, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "get-models");
  if (!url) throw new Error("completionURL 无效（无法请求官方 get-models）");
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const resp = await safeFetch(url, { method: "POST", headers, body: "{}" }, { timeoutMs, abortSignal, label: "augment/get-models" });
  if (!resp.ok) throw new Error(`get-models ${resp.status}: ${await readTextLimit(resp, 300)}`.trim());
  const json = await resp.json().catch(() => null);
  if (!json || typeof json !== "object") throw new Error("get-models 响应不是 JSON 对象");
  return json;
}

function mergeModels(upstreamJson, byokModelNames, opts) {
  const base = upstreamJson && typeof upstreamJson === "object" ? upstreamJson : {};
  const models = Array.isArray(base.models) ? base.models.slice() : [];
  const existing = new Set(models.map((m) => (m && typeof m.name === "string" ? m.name : "")).filter(Boolean));
  for (const name of byokModelNames) {
    if (!name || existing.has(name)) continue;
    models.push(makeModelInfo(name));
    existing.add(name);
  }
  const baseDefaultModel = typeof base.default_model === "string" && base.default_model ? base.default_model : (models[0]?.name || "unknown");
  const baseFlags = base.feature_flags && typeof base.feature_flags === "object" && !Array.isArray(base.feature_flags) ? base.feature_flags : {};
  const preferredDefaultModel = normalizeString(opts?.defaultModel);
  const defaultModel = preferredDefaultModel || baseDefaultModel;
  const flags = ensureModelRegistryFeatureFlags(baseFlags, { byokModelIds: byokModelNames, defaultModel, agentChatModel: defaultModel });
  return { ...base, default_model: defaultModel, models, feature_flags: flags };
}

async function maybeHandleCallApi({ endpoint, body, transform, timeoutMs, abortSignal, upstreamApiToken }) {
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return undefined;

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();
  if (!state.runtimeEnabled) return undefined;

  if (isTelemetryDisabled(cfg, ep)) {
    try {
      return safeTransform(transform, {}, `telemetry:${ep}`);
    } catch (err) {
      warn(`telemetry stub transform failed, fallback official: ${ep}`);
      return undefined;
    }
  }

  const route = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") throw new Error(`BYOK disabled endpoint: ${ep}`);
  if (route.mode !== "byok") return undefined;

  const t = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : cfg.timeouts.upstreamMs;

  if (ep === "/get-models") {
    const byokModels = buildByokModelsFromConfig(cfg);
    const byokDefaultModel = byokModels.length ? byokModels[0] : "";
    const activeProviderId = normalizeString(cfg?.routing?.defaultProviderId) || normalizeString(cfg?.providers?.[0]?.id);
    const activeProvider = Array.isArray(cfg?.providers) ? cfg.providers.find((p) => p && normalizeString(p.id) === activeProviderId) : null;
    const activeProviderDefaultModel = normalizeString(activeProvider?.defaultModel) || normalizeString(activeProvider?.models?.[0]);
    const preferredByok = activeProviderId && activeProviderDefaultModel ? `byok:${activeProviderId}:${activeProviderDefaultModel}` : "";
    const preferredDefaultModel = byokModels.includes(preferredByok) ? preferredByok : byokDefaultModel;
    try {
      const off = getOfficialConnection();
      const completionURL = off.completionURL;
      const apiToken = normalizeRawToken(upstreamApiToken) || off.apiToken;
      const upstream = await fetchOfficialGetModels({ completionURL, apiToken, timeoutMs: Math.min(12000, t), abortSignal });
      const merged = mergeModels(upstream, byokModels, { defaultModel: preferredDefaultModel });
      return safeTransform(transform, merged, ep);
    } catch (err) {
      warn(`get-models fallback to local: ${err instanceof Error ? err.message : String(err)}`);
      const local = makeBackGetModelsResult({ defaultModel: preferredDefaultModel || "unknown", models: byokModels.map(makeModelInfo) });
      return safeTransform(transform, local, ep);
    }
  }

  if (ep === "/completion" || ep === "/chat-input-completion") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const text = await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return safeTransform(transform, makeBackCompletionResult(text), ep);
  }

  if (ep === "/edit") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const text = await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return safeTransform(transform, makeBackTextResult(text), ep);
  }

  if (ep === "/chat") {
    const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(route.provider);
    const req = normalizeAugmentChatRequest(body);
    const msg = normalizeString(req.message);
    const hasNodes = Array.isArray(req.nodes) && req.nodes.length;
    const hasHistory = Array.isArray(req.chat_history) && req.chat_history.length;
    const hasReqNodes = (Array.isArray(req.structured_request_nodes) && req.structured_request_nodes.length) || (Array.isArray(req.request_nodes) && req.request_nodes.length);
    if (!msg && !hasNodes && !hasHistory && !hasReqNodes) return safeTransform(transform, makeBackChatResult("", { nodes: [] }), ep);
    try {
      await maybeSummarizeAndCompactAugmentChatRequest({ cfg, req, requestedModel: route.requestedModel, fallbackProvider: route.provider, fallbackModel: route.model, timeoutMs: t, abortSignal });
    } catch (err) {
      warn(`historySummary failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (type === "openai_compatible") {
      const text = await openAiCompleteText({ baseUrl, apiKey, model: route.model, messages: buildOpenAiMessages(req), timeoutMs: t, abortSignal, extraHeaders, requestDefaults });
      return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
    }
    if (type === "anthropic") {
      const text = await anthropicCompleteText({ baseUrl, apiKey, model: route.model, system: buildSystemPrompt(req), messages: buildAnthropicMessages(req), timeoutMs: t, abortSignal, extraHeaders, requestDefaults });
      return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
    }
    throw new Error(`未知 provider.type: ${type}`);
  }

  if (ep === "/next_edit_loc") {
    const candidate_locations = pickNextEditLocationCandidates(body);
    return safeTransform(transform, makeBackNextEditLocationResult(candidate_locations), ep);
  }

  return undefined;
}

async function maybeHandleCallApiStream({ endpoint, body, transform, timeoutMs, abortSignal }) {
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return undefined;

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();
  if (!state.runtimeEnabled) return undefined;

  const route = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") throw new Error(`BYOK disabled endpoint: ${ep}`);
  if (route.mode !== "byok") return undefined;

  const t = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : cfg.timeouts.upstreamMs;

  if (isTelemetryDisabled(cfg, ep)) return emptyAsyncGenerator();

  if (ep === "/chat-stream") {
    const src = byokChatStream({ cfg, provider: route.provider, model: route.model, requestedModel: route.requestedModel, body, timeoutMs: t, abortSignal });
    return guardObjectStream({
      ep,
      src,
      transform,
      makeErrorChunk: (err) => makeBackChatChunk({ text: makeEndpointErrorText(ep, err), stop_reason: STOP_REASON_END_TURN })
    });
  }

  if (ep === "/prompt-enhancer" || ep === "/generate-conversation-title") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const src = byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return guardObjectStream({
      ep,
      transform,
      src: (async function* () { for await (const delta of src) yield makeBackChatResult(delta, { nodes: [] }); })(),
      makeErrorChunk: (err) => makeBackChatResult(makeEndpointErrorText(ep, err), { nodes: [] })
    });
  }

  if (ep === "/instruction-stream" || ep === "/smart-paste-stream") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const meta = await buildInstructionReplacementMeta(body);
    const src = byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return guardObjectStream({
      ep,
      transform,
      src: (async function* () {
        yield { text: "", ...meta };
        for await (const delta of src) {
          const t = typeof delta === "string" ? delta : String(delta ?? "");
          if (!t) continue;
          yield { text: t, replacement_text: t };
        }
      })(),
      makeErrorChunk: (err) => ({ text: makeEndpointErrorText(ep, err), ...meta })
    });
  }

  if (ep === "/generate-commit-message-stream") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const src = byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return guardObjectStream({
      ep,
      transform,
      src: (async function* () { for await (const delta of src) yield makeBackChatResult(delta, { nodes: [] }); })(),
      makeErrorChunk: (err) => makeBackChatResult(makeEndpointErrorText(ep, err), { nodes: [] })
    });
  }

  if (ep === "/next-edit-stream") {
    const b = body && typeof body === "object" ? body : {};
    const selectionBegin = Number.isFinite(Number(b.selection_begin_char)) ? Number(b.selection_begin_char) : 0;
    const selectionEnd = Number.isFinite(Number(b.selection_end_char)) ? Number(b.selection_end_char) : selectionBegin;
    const existingCode = typeof b.selected_text === "string" ? b.selected_text : "";

    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const suggestedCode = await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });

    const raw = makeBackNextEditGenerationChunk({
      path: normalizeString(b.path),
      blobName: normalizeString(b.blob_name),
      charStart: selectionBegin,
      charEnd: selectionEnd,
      existingCode,
      suggestedCode
    });
    return (async function* () { yield safeTransform(transform, raw, ep); })();
  }

  return undefined;
}

module.exports = { maybeHandleCallApi, maybeHandleCallApiStream };
