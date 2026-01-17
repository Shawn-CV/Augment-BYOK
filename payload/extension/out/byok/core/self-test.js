"use strict";

const { debug } = require("../infra/log");
const { normalizeString, normalizeRawToken, randomId } = require("../infra/util");
const { captureAugmentToolDefinitions, getLastCapturedToolDefinitions } = require("../config/state");
const { getOfficialConnection } = require("../config/official");
const { joinBaseUrl, safeFetch, readTextLimit } = require("../providers/http");
const { fetchProviderModels } = require("../providers/models");
const { openAiCompleteText, openAiStreamTextDeltas, openAiChatStreamChunks } = require("../providers/openai");
const { openAiResponsesCompleteText, openAiResponsesStreamTextDeltas, openAiResponsesChatStreamChunks } = require("../providers/openai-responses");
const { anthropicCompleteText, anthropicStreamTextDeltas, anthropicChatStreamChunks } = require("../providers/anthropic");
const { geminiCompleteText, geminiStreamTextDeltas, geminiChatStreamChunks } = require("../providers/gemini");
const { buildMessagesForEndpoint } = require("./protocol");
const {
  REQUEST_NODE_IMAGE,
  REQUEST_NODE_TOOL_RESULT,
  REQUEST_NODE_HISTORY_SUMMARY,
  RESPONSE_NODE_TOOL_USE,
  RESPONSE_NODE_TOKEN_USAGE,
  STOP_REASON_TOOL_USE_REQUESTED,
  TOOL_RESULT_CONTENT_TEXT
} = require("./augment-protocol");
const {
  buildSystemPrompt,
  buildToolMetaByName,
  convertOpenAiTools,
  convertAnthropicTools,
  convertGeminiTools,
  convertOpenAiResponsesTools,
  buildOpenAiMessages,
  buildOpenAiResponsesInput,
  buildAnthropicMessages,
  buildGeminiContents
} = require("./augment-chat");
const shared = require("./augment-chat.shared");
const { maybeSummarizeAndCompactAugmentChatRequest, deleteHistorySummaryCache } = require("./augment-history-summary-auto");

function nowMs() {
  return Date.now();
}

function hasAuthHeader(headers) {
  const h = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  const keys = Object.keys(h).map((k) => String(k || "").trim().toLowerCase());
  return keys.some((k) => k === "authorization" || k === "x-api-key" || k === "api-key" || k === "x-goog-api-key");
}

function buildOfficialAuthHeaders(apiToken) {
  const headers = { "content-type": "application/json" };
  const tok = normalizeRawToken(apiToken);
  if (tok) headers.authorization = `Bearer ${tok}`;
  return headers;
}

async function fetchOfficialListRemoteTools({ completionURL, apiToken, toolIds, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "agents/list-remote-tools");
  if (!url) throw new Error("completionURL 无效（无法请求官方 agents/list-remote-tools）");
  const headers = buildOfficialAuthHeaders(apiToken);
  const payload = { tool_id_list: { tool_ids: Array.isArray(toolIds) ? toolIds : [] } };
  const resp = await safeFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(payload) },
    { timeoutMs, abortSignal, label: "augment/agents/list-remote-tools" }
  );
  if (!resp.ok) throw new Error(`agents/list-remote-tools ${resp.status}: ${await readTextLimit(resp, 300)}`.trim());
  return await resp.json().catch(() => null);
}

async function fetchOfficialCheckToolSafety({ completionURL, apiToken, toolId, toolInputJson, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "agents/check-tool-safety");
  if (!url) throw new Error("completionURL 无效（无法请求官方 agents/check-tool-safety）");
  const headers = buildOfficialAuthHeaders(apiToken);
  const payload = { tool_id: Number(toolId), tool_input_json: String(toolInputJson || "") };
  const resp = await safeFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(payload) },
    { timeoutMs, abortSignal, label: "augment/agents/check-tool-safety" }
  );
  if (!resp.ok) throw new Error(`agents/check-tool-safety ${resp.status}: ${await readTextLimit(resp, 300)}`.trim());
  return await resp.json().catch(() => null);
}

async function fetchOfficialRunRemoteTool({ completionURL, apiToken, toolId, toolName, toolInputJson, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "agents/run-remote-tool");
  if (!url) throw new Error("completionURL 无效（无法请求官方 agents/run-remote-tool）");
  const headers = buildOfficialAuthHeaders(apiToken);
  const payload = { tool_name: String(toolName || ""), tool_input_json: String(toolInputJson || ""), tool_id: Number(toolId) };
  const resp = await safeFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(payload) },
    { timeoutMs, abortSignal, label: "augment/agents/run-remote-tool" }
  );
  if (!resp.ok) throw new Error(`agents/run-remote-tool ${resp.status}: ${await readTextLimit(resp, 300)}`.trim());
  return await resp.json().catch(() => null);
}

function normalizeOfficialRemoteToolsList(json) {
  const root = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  const rawTools = Array.isArray(root.tools) ? root.tools : [];
  const out = [];
  for (const it of rawTools) {
    const r = it && typeof it === "object" && !Array.isArray(it) ? it : {};
    const toolDefinition = r.tool_definition ?? r.toolDefinition;
    const toolDef = toolDefinition && typeof toolDefinition === "object" && !Array.isArray(toolDefinition) ? toolDefinition : null;
    const toolIdRaw = r.remote_tool_id ?? r.remoteToolId ?? r.tool_id ?? r.toolId;
    const toolIdNum = Number(toolIdRaw);
    const remoteToolId = Number.isFinite(toolIdNum) ? Math.floor(toolIdNum) : null;
    const availabilityStatusRaw = r.availability_status ?? r.availabilityStatus;
    const availabilityStatusNum = Number(availabilityStatusRaw);
    const availabilityStatus = Number.isFinite(availabilityStatusNum) ? Math.floor(availabilityStatusNum) : normalizeString(availabilityStatusRaw);
    const oauthUrl = normalizeString(r.oauth_url ?? r.oauthUrl);
    if (!toolDef) continue;
    out.push({ toolDef, remoteToolId, availabilityStatus, oauthUrl });
  }
  return out;
}

function extractToolDefinitionsFromOfficialRemoteTools(remoteTools) {
  const defs = [];
  const seen = new Set();
  for (const it of Array.isArray(remoteTools) ? remoteTools : []) {
    const d = it && typeof it === "object" ? it.toolDef : null;
    const name = normalizeString(d?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    defs.push(d);
  }
  return defs;
}

async function fetchOfficialRemoteToolsIndex({ completionURL, apiToken, timeoutMs, abortSignal, expectedToolNames } = {}) {
  const base = normalizeString(completionURL);
  const tok = normalizeRawToken(apiToken);
  if (!base || !tok) throw new Error("official completion_url/api_token 未配置（Self Test 无法自动拉取/执行真实工具）");

  const expected = Array.isArray(expectedToolNames) ? expectedToolNames.map((x) => normalizeString(x)).filter(Boolean) : [];
  const expectedSet = new Set(expected);

  const ranges = [
    { label: "empty", toolIds: [] },
    { label: "range128", toolIds: Array.from({ length: 128 }, (_, i) => i + 1) },
    { label: "range256", toolIds: Array.from({ length: 256 }, (_, i) => i + 1) }
  ];

  let lastErr = "";
  let best = null; // {attempt, items, byName, matched, expectedCount}
  for (const attempt of ranges) {
    try {
      const json = await fetchOfficialListRemoteTools({ completionURL: base, apiToken: tok, toolIds: attempt.toolIds, timeoutMs, abortSignal });
      const items = normalizeOfficialRemoteToolsList(json);
      const byName = new Map();
      for (const it of items) {
        const name = normalizeString(it?.toolDef?.name);
        if (!name || byName.has(name)) continue;
        byName.set(name, it);
      }
      const matched = expectedSet.size ? expected.filter((n) => byName.has(n)).length : byName.size;
      if (items.length && (!best || matched > best.matched || (matched === best.matched && items.length > best.items.length))) {
        best = { attempt: attempt.label, items, byName, matched, expectedCount: expectedSet.size };
      }
      if (items.length && expectedSet.size && matched === expectedSet.size) return { attempt: attempt.label, items, byName, matched, expectedCount: expectedSet.size };
      if (items.length && !expectedSet.size && matched > 0) return { attempt: attempt.label, items, byName, matched, expectedCount: expectedSet.size };
      lastErr = `no tools returned (attempt=${attempt.label} tools=${items.length} matched=${matched}/${expectedSet.size || "n/a"})`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (best && best.items.length && (!best.expectedCount || best.matched > 0)) return best;
  throw new Error(lastErr || "list-remote-tools failed");
}

function providerLabel(provider) {
  const id = normalizeString(provider?.id);
  const type = normalizeString(provider?.type);
  return id ? `${id} (${type || "unknown"})` : `(${type || "unknown"})`;
}

function formatMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n >= 0 ? `${Math.floor(n)}ms` : "n/a";
}

function formatMaybeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.floor(n)) : "";
}

function onePixelPngBase64() {
  // 1x1 png (RGBA). 用于多模态链路连通性测试。
  // 旧的灰度+alpha PNG 在少数网关/上游解码器中会被误判为“invalid image”，这里改为最通用的 RGBA。
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
}

function makeSelfTestToolDefinitions() {
  return [
    {
      name: "echo_self_test",
      description: "BYOK self-test tool. Echo back the input.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string" }
        }
      }
    }
  ];
}

function makeToolResultNode({ toolUseId, contentText, isError }) {
  return {
    id: 1,
    type: REQUEST_NODE_TOOL_RESULT,
    content: "",
    tool_result_node: {
      tool_use_id: String(toolUseId || ""),
      content: String(contentText || ""),
      is_error: Boolean(isError),
      content_nodes: [
        {
          type: TOOL_RESULT_CONTENT_TEXT,
          text_content: String(contentText || "")
        }
      ]
    }
  };
}

function makeImageNode() {
  return {
    id: 1,
    type: REQUEST_NODE_IMAGE,
    content: "",
    image_node: {
      // format=0 → 默认为 image/png
      format: 0,
      image_data: onePixelPngBase64()
    }
  };
}

function makeBaseAugmentChatRequest({ message, conversationId, toolDefinitions, nodes, chatHistory } = {}) {
  return {
    message: typeof message === "string" ? message : "",
    conversation_id: normalizeString(conversationId) || "",
    chat_history: Array.isArray(chatHistory) ? chatHistory : [],
    tool_definitions: Array.isArray(toolDefinitions) ? toolDefinitions : [],
    nodes: Array.isArray(nodes) ? nodes : [],
    structured_request_nodes: [],
    request_nodes: [],
    agent_memories: "",
    mode: "AGENT",
    prefix: "",
    selected_code: "",
    disable_selected_code_details: false,
    suffix: "",
    diff: "",
    lang: "",
    path: "",
    user_guidelines: "",
    workspace_guidelines: "",
    persona_type: 0,
    silent: false,
    canvas_id: "",
    request_id_override: "",
    rules: null,
    feature_detection_flags: {}
  };
}

async function collectChatStream(gen, { maxChunks = 500 } = {}) {
  const chunks = [];
  const nodes = [];
  let text = "";
  let stop_reason = null;
  for await (const ch of gen) {
    if (chunks.length >= maxChunks) break;
    chunks.push(ch);
    if (typeof ch?.text === "string" && ch.text) text += ch.text;
    if (Array.isArray(ch?.nodes)) nodes.push(...ch.nodes);
    if (ch && typeof ch === "object" && "stop_reason" in ch) stop_reason = ch.stop_reason;
  }
  return { chunks, nodes, text, stop_reason };
}

function extractToolUsesFromNodes(nodes) {
  const out = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const r = n && typeof n === "object" ? n : null;
    if (!r) continue;
    if (Number(r.type) !== RESPONSE_NODE_TOOL_USE) continue;
    const tu = r.tool_use && typeof r.tool_use === "object" ? r.tool_use : r.toolUse && typeof r.toolUse === "object" ? r.toolUse : null;
    const tool_use_id = normalizeString(tu?.tool_use_id ?? tu?.toolUseId);
    const tool_name = normalizeString(tu?.tool_name ?? tu?.toolName);
    const input_json = typeof (tu?.input_json ?? tu?.inputJson) === "string" ? (tu.input_json ?? tu.inputJson) : "";
    const mcp_server_name = normalizeString(tu?.mcp_server_name ?? tu?.mcpServerName);
    const mcp_tool_name = normalizeString(tu?.mcp_tool_name ?? tu?.mcpToolName);
    if (!tool_use_id || !tool_name) continue;
    out.push({ tool_use_id, tool_name, input_json, mcp_server_name, mcp_tool_name });
  }
  return out;
}

function extractTokenUsageFromNodes(nodes) {
  let last = null;
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const r = n && typeof n === "object" ? n : null;
    if (!r) continue;
    if (Number(r.type) !== RESPONSE_NODE_TOKEN_USAGE) continue;
    const tu = r.token_usage && typeof r.token_usage === "object" ? r.token_usage : r.tokenUsage && typeof r.tokenUsage === "object" ? r.tokenUsage : null;
    if (!tu) continue;
    last = tu;
  }
  return last;
}

async function withTimed(fn) {
  const t0 = nowMs();
  try {
    const res = await fn();
    return { ok: true, ms: nowMs() - t0, res };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, ms: nowMs() - t0, error: m };
  }
}

function summarizeToolDefs(toolDefs, { maxNames = 12 } = {}) {
  const defs = Array.isArray(toolDefs) ? toolDefs : [];
  const names = [];
  const seen = new Set();
  for (const d of defs) {
    if (!d || typeof d !== "object") continue;
    const n = normalizeString(d.name);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
    if (names.length >= Math.max(1, Number(maxNames) || 12)) break;
  }
  return { count: defs.length, names, namesTruncated: defs.length > names.length };
}

function dedupeToolDefsByName(toolDefs) {
  const defs = Array.isArray(toolDefs) ? toolDefs : [];
  const out = [];
  const seen = new Set();
  for (const d of defs) {
    if (!d || typeof d !== "object") continue;
    const name = normalizeString(d.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(d);
  }
  return out;
}

function countSchemaProperties(schema) {
  const s = schema && typeof schema === "object" && !Array.isArray(schema) ? schema : null;
  const props = s && s.properties && typeof s.properties === "object" && !Array.isArray(s.properties) ? s.properties : null;
  return props ? Object.keys(props).length : 0;
}

function sampleJsonFromSchema(schema, depth) {
  const d = Number.isFinite(Number(depth)) ? Number(depth) : 0;
  if (d > 8) return {};
  const s = schema && typeof schema === "object" && !Array.isArray(schema) ? schema : {};

  if (Object.prototype.hasOwnProperty.call(s, "const")) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Object.prototype.hasOwnProperty.call(s, "default")) return s.default;

  const pickFirst = (list) => (Array.isArray(list) && list.length ? list[0] : null);
  const union = pickFirst(s.oneOf) || pickFirst(s.anyOf) || pickFirst(s.allOf);
  if (union) return sampleJsonFromSchema(union, d + 1);

  const typeRaw = s.type;
  const types = Array.isArray(typeRaw) ? typeRaw.map((x) => normalizeString(x).toLowerCase()).filter(Boolean) : [normalizeString(typeRaw).toLowerCase()].filter(Boolean);
  const has = (t) => types.includes(t);

  const props = s.properties && typeof s.properties === "object" && !Array.isArray(s.properties) ? s.properties : null;
  if (has("object") || props) {
    const out = {};
    const required = Array.isArray(s.required) ? s.required.map((x) => normalizeString(x)).filter(Boolean) : [];
    const keys = props ? Object.keys(props) : [];
    const keysSet = keys.length ? new Set(keys) : null;
    const chosen = required.length ? required.filter((k) => (keysSet ? keysSet.has(k) : false)) : keys;
    const limit = 60;
    for (const k of chosen.slice(0, limit)) out[k] = sampleJsonFromSchema(props && props[k], d + 1);
    return out;
  }

  const items = s.items;
  if (has("array") || items) {
    const minItems = Number.isFinite(Number(s.minItems)) && Number(s.minItems) > 0 ? Math.floor(Number(s.minItems)) : 0;
    const n = Math.min(3, minItems);
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(sampleJsonFromSchema(items, d + 1));
    return arr;
  }

  if (has("integer")) {
    if (Number.isFinite(Number(s.minimum))) return Math.floor(Number(s.minimum));
    if (Number.isFinite(Number(s.exclusiveMinimum))) return Math.floor(Number(s.exclusiveMinimum)) + 1;
    return 1;
  }
  if (has("number")) {
    if (Number.isFinite(Number(s.minimum))) return Number(s.minimum);
    if (Number.isFinite(Number(s.exclusiveMinimum))) return Number(s.exclusiveMinimum) + 1;
    return 1;
  }
  if (has("boolean")) return true;
  if (has("null")) return null;
  if (has("string")) {
    const minLength = Number.isFinite(Number(s.minLength)) && Number(s.minLength) > 0 ? Math.floor(Number(s.minLength)) : 0;
    const base = "x".repeat(Math.min(16, Math.max(1, minLength)));
    return base;
  }

  // fallback：尽量返回可 JSON 化的值
  return {};
}

function summarizeCapturedToolsSchemas(toolDefs) {
  const defs = dedupeToolDefsByName(toolDefs);
  let withMcpMeta = 0;
  let sampleOk = 0;
  const failed = [];

  for (const d of defs) {
    const name = normalizeString(d?.name);
    const schema = shared.resolveToolSchema(d);
    const hasMcp = Boolean(normalizeString(d?.mcp_server_name ?? d?.mcpServerName) || normalizeString(d?.mcp_tool_name ?? d?.mcpToolName));
    if (hasMcp) withMcpMeta += 1;
    try {
      const sample = sampleJsonFromSchema(schema, 0);
      JSON.stringify(sample);
      sampleOk += 1;
    } catch {
      if (name) failed.push(name);
    }
  }

  return { toolCount: defs.length, withMcpMeta, sampleOk, sampleFailedNames: failed.slice(0, 12), sampleFailedTruncated: failed.length > 12 };
}

function pickRealToolsForUsabilityProbe(toolDefs, { maxTools = 4 } = {}) {
  const defs = dedupeToolDefsByName(toolDefs);
  const max = Math.max(1, Number(maxTools) || 4);
  if (max >= defs.length) {
    return defs.slice().sort((a, b) => normalizeString(a?.name).localeCompare(normalizeString(b?.name)));
  }
  const byName = new Map(defs.map((d) => [normalizeString(d?.name), d]).filter((x) => x[0]));

  const chosen = [];
  const seen = new Set();
  const pickByName = (name) => {
    const k = normalizeString(name);
    const d = k ? byName.get(k) : null;
    if (!d || seen.has(k)) return false;
    seen.add(k);
    chosen.push(d);
    return true;
  };

  // 明确优先：覆盖常用 + 复杂 schema（如果存在）
  const preferredNames = ["str-replace-editor", "codebase-retrieval", "web-fetch", "web-search", "diagnostics"];
  for (const n of preferredNames) {
    if (chosen.length >= maxTools) break;
    pickByName(n);
  }

  // 覆盖 MCP meta（用于验证 mcp_server_name/mcp_tool_name 能回填到 tool_use）
  if (chosen.length < maxTools) {
    const mcp = defs.filter((d) => normalizeString(d?.mcp_server_name ?? d?.mcpServerName) || normalizeString(d?.mcp_tool_name ?? d?.mcpToolName));
    mcp.sort((a, b) => normalizeString(a?.name).localeCompare(normalizeString(b?.name)));
    for (const d of mcp) {
      if (chosen.length >= maxTools) break;
      pickByName(d.name);
    }
  }

  // 覆盖最大 properties（更容易触发 schema 边界）
  if (chosen.length < maxTools) {
    const ranked = defs
      .map((d) => ({ d, props: countSchemaProperties(shared.resolveToolSchema(d)) }))
      .sort((a, b) => b.props - a.props || normalizeString(a.d?.name).localeCompare(normalizeString(b.d?.name)));
    for (const it of ranked) {
      if (chosen.length >= maxTools) break;
      pickByName(it.d.name);
    }
  }

  // 最后兜底：按 name 排序补齐
  if (chosen.length < maxTools) {
    const sorted = defs.slice().sort((a, b) => normalizeString(a?.name).localeCompare(normalizeString(b?.name)));
    for (const d of sorted) {
      if (chosen.length >= maxTools) break;
      pickByName(d.name);
    }
  }

  return chosen.slice(0, max);
}

function validateOpenAiStrictJsonSchema(schema, issues, path, depth) {
  const d = Number.isFinite(Number(depth)) ? Number(depth) : 0;
  if (d > 50) return;
  if (!schema) return;
  if (Array.isArray(schema)) {
    for (let i = 0; i < schema.length; i++) validateOpenAiStrictJsonSchema(schema[i], issues, `${path}[${i}]`, d + 1);
    return;
  }
  if (typeof schema !== "object") return;

  const t = schema.type;
  const hasObjectType =
    t === "object" || (Array.isArray(t) && t.some((x) => normalizeString(x).toLowerCase() === "object"));
  const props = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties : null;
  const hasProps = Boolean(props);

  if (hasObjectType || hasProps) {
    if (schema.additionalProperties !== false) issues.push(`${path || "<root>"}: additionalProperties must be false`);
    const req = Array.isArray(schema.required) ? schema.required : null;
    if (!req) {
      issues.push(`${path || "<root>"}: required must be array`);
    } else if (props) {
      for (const k of Object.keys(props)) {
        if (!req.includes(k)) issues.push(`${path || "<root>"}: required missing '${k}'`);
      }
    }
  }

  if (props) {
    for (const k of Object.keys(props)) validateOpenAiStrictJsonSchema(props[k], issues, `${path ? path + "." : ""}properties.${k}`, d + 1);
  }

  if (schema.items != null) validateOpenAiStrictJsonSchema(schema.items, issues, `${path ? path + "." : ""}items`, d + 1);
  if (schema.prefixItems != null) validateOpenAiStrictJsonSchema(schema.prefixItems, issues, `${path ? path + "." : ""}prefixItems`, d + 1);
  if (schema.not != null) validateOpenAiStrictJsonSchema(schema.not, issues, `${path ? path + "." : ""}not`, d + 1);
  if (schema.if != null) validateOpenAiStrictJsonSchema(schema.if, issues, `${path ? path + "." : ""}if`, d + 1);
  if (schema.then != null) validateOpenAiStrictJsonSchema(schema.then, issues, `${path ? path + "." : ""}then`, d + 1);
  if (schema.else != null) validateOpenAiStrictJsonSchema(schema.else, issues, `${path ? path + "." : ""}else`, d + 1);

  if (Array.isArray(schema.anyOf)) validateOpenAiStrictJsonSchema(schema.anyOf, issues, `${path ? path + "." : ""}anyOf`, d + 1);
  if (Array.isArray(schema.oneOf)) validateOpenAiStrictJsonSchema(schema.oneOf, issues, `${path ? path + "." : ""}oneOf`, d + 1);
  if (Array.isArray(schema.allOf)) validateOpenAiStrictJsonSchema(schema.allOf, issues, `${path ? path + "." : ""}allOf`, d + 1);

  if (schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)) {
    for (const k of Object.keys(schema.$defs)) validateOpenAiStrictJsonSchema(schema.$defs[k], issues, `${path ? path + "." : ""}$defs.${k}`, d + 1);
  }
  if (schema.definitions && typeof schema.definitions === "object" && !Array.isArray(schema.definitions)) {
    for (const k of Object.keys(schema.definitions)) validateOpenAiStrictJsonSchema(schema.definitions[k], issues, `${path ? path + "." : ""}definitions.${k}`, d + 1);
  }
}

function pickProviderModel(provider, fetchedModels) {
  const dm = normalizeString(provider?.defaultModel);
  if (dm) return dm;
  const ms = Array.isArray(provider?.models) ? provider.models : [];
  const firstLocal = ms.map((x) => normalizeString(x)).find(Boolean);
  if (firstLocal) return firstLocal;
  const firstFetched = Array.isArray(fetchedModels) ? fetchedModels.map((x) => normalizeString(x)).find(Boolean) : "";
  return firstFetched || "";
}

function buildOpenAiSystemMessages(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const out = [];
  if (sys) out.push({ role: "system", content: sys });
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()) out.push({ role: m.role, content: m.content });
  }
  return out;
}

function buildAnthropicBlocks(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()) out.push({ role: m.role, content: m.content });
  }
  return { system: sys, messages: out };
}

function buildGeminiTextContents(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const contents = [];
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "model" : m.role === "user" ? "user" : "";
    const content = typeof m.content === "string" ? m.content : "";
    if (!role || !content.trim()) continue;
    contents.push({ role, parts: [{ text: content }] });
  }
  return { systemInstruction: sys, contents };
}

function buildResponsesTextInput(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const input = [];
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "";
    const content = typeof m.content === "string" ? m.content : "";
    if (!role || !content.trim()) continue;
    input.push({ type: "message", role, content });
  }
  return { instructions: sys, input };
}

async function completeTextByProvider({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const type = normalizeString(provider?.type);
  const baseUrl = normalizeString(provider?.baseUrl);
  const apiKey = normalizeString(provider?.apiKey);
  const extraHeaders = provider?.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers) ? provider.headers : {};
  const requestDefaults = provider?.requestDefaults && typeof provider.requestDefaults === "object" && !Array.isArray(provider.requestDefaults) ? provider.requestDefaults : {};

  if (type === "openai_compatible") {
    return await openAiCompleteText({ baseUrl, apiKey, model, messages: buildOpenAiSystemMessages(system, messages), timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "anthropic") {
    const { system: sys, messages: ms } = buildAnthropicBlocks(system, messages);
    return await anthropicCompleteText({ baseUrl, apiKey, model, system: sys, messages: ms, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "openai_responses") {
    const { instructions, input } = buildResponsesTextInput(system, messages);
    return await openAiResponsesCompleteText({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = buildGeminiTextContents(system, messages);
    return await geminiCompleteText({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function streamTextByProvider({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const type = normalizeString(provider?.type);
  const baseUrl = normalizeString(provider?.baseUrl);
  const apiKey = normalizeString(provider?.apiKey);
  const extraHeaders = provider?.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers) ? provider.headers : {};
  const requestDefaults = provider?.requestDefaults && typeof provider.requestDefaults === "object" && !Array.isArray(provider.requestDefaults) ? provider.requestDefaults : {};

  if (type === "openai_compatible") {
    let out = "";
    for await (const d of openAiStreamTextDeltas({ baseUrl, apiKey, model, messages: buildOpenAiSystemMessages(system, messages), timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    return out;
  }
  if (type === "anthropic") {
    let out = "";
    const { system: sys, messages: ms } = buildAnthropicBlocks(system, messages);
    for await (const d of anthropicStreamTextDeltas({ baseUrl, apiKey, model, system: sys, messages: ms, timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    return out;
  }
  if (type === "openai_responses") {
    let out = "";
    const { instructions, input } = buildResponsesTextInput(system, messages);
    for await (const d of openAiResponsesStreamTextDeltas({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    return out;
  }
  if (type === "gemini_ai_studio") {
    let out = "";
    const { systemInstruction, contents } = buildGeminiTextContents(system, messages);
    for await (const d of geminiStreamTextDeltas({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    return out;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

function convertToolsByProviderType(providerType, toolDefs) {
  const t = normalizeString(providerType);
  if (t === "openai_compatible") return convertOpenAiTools(toolDefs);
  if (t === "anthropic") return convertAnthropicTools(toolDefs);
  if (t === "gemini_ai_studio") return convertGeminiTools(toolDefs);
  if (t === "openai_responses") return convertOpenAiResponsesTools(toolDefs);
  throw new Error(`未知 provider.type: ${t}`);
}

function validateConvertedToolsForProvider(providerType, convertedTools) {
  const t = normalizeString(providerType);
  const tools = Array.isArray(convertedTools) ? convertedTools : [];
  if (t !== "openai_responses") return { ok: true, issues: [] };

  const issues = [];
  for (const tool of tools) {
    const name = normalizeString(tool?.name) || normalizeString(tool?.function?.name);
    const params = tool?.parameters ?? tool?.function?.parameters;
    const toolIssues = [];
    validateOpenAiStrictJsonSchema(params, toolIssues, "", 0);
    if (toolIssues.length) {
      issues.push(`${name || "(unknown tool)"}: ${toolIssues[0]}`);
    }
    if (issues.length >= 30) break;
  }
  return { ok: issues.length === 0, issues };
}

async function chatStreamByProvider({ provider, model, req, timeoutMs, abortSignal }) {
  const type = normalizeString(provider?.type);
  const baseUrl = normalizeString(provider?.baseUrl);
  const apiKey = normalizeString(provider?.apiKey);
  const extraHeaders = provider?.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers) ? provider.headers : {};
  const requestDefaults = provider?.requestDefaults && typeof provider.requestDefaults === "object" && !Array.isArray(provider.requestDefaults) ? provider.requestDefaults : {};
  const toolMetaByName = buildToolMetaByName(req.tool_definitions);

  if (type === "openai_compatible") {
    return await collectChatStream(
      openAiChatStreamChunks({
        baseUrl,
        apiKey,
        model,
        messages: buildOpenAiMessages(req),
        tools: convertOpenAiTools(req.tool_definitions),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults,
        toolMetaByName,
        supportToolUseStart: true
      })
    );
  }
  if (type === "anthropic") {
    return await collectChatStream(
      anthropicChatStreamChunks({
        baseUrl,
        apiKey,
        model,
        system: buildSystemPrompt(req),
        messages: buildAnthropicMessages(req),
        tools: convertAnthropicTools(req.tool_definitions),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults,
        toolMetaByName,
        supportToolUseStart: true
      })
    );
  }
  if (type === "openai_responses") {
    const { instructions, input } = buildOpenAiResponsesInput(req);
    return await collectChatStream(
      openAiResponsesChatStreamChunks({
        baseUrl,
        apiKey,
        model,
        instructions,
        input,
        tools: convertOpenAiResponsesTools(req.tool_definitions),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults,
        toolMetaByName,
        supportToolUseStart: true
      })
    );
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = buildGeminiContents(req);
    return await collectChatStream(
      geminiChatStreamChunks({
        baseUrl,
        apiKey,
        model,
        systemInstruction,
        contents,
        tools: convertGeminiTools(req.tool_definitions),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults,
        toolMetaByName,
        supportToolUseStart: true
      })
    );
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function realToolsToolRoundtripByProvider({ provider, model, toolDefinitions, timeoutMs, abortSignal, maxTools, log }) {
  const providerType = normalizeString(provider?.type);
  const toolDefsAll = Array.isArray(toolDefinitions) ? toolDefinitions : [];
  const uniqueDefs = dedupeToolDefsByName(toolDefsAll);
  const uniqueCount = uniqueDefs.length;
  if (!uniqueCount) return { ok: false, detail: "no tools" };

  const desired = Number.isFinite(Number(maxTools)) && Number(maxTools) > 0 ? Math.floor(Number(maxTools)) : uniqueCount;
  const pickedToolDefs = pickRealToolsForUsabilityProbe(toolDefsAll, { maxTools: Math.max(1, Math.min(desired, uniqueCount)) });
  const toolNames = pickedToolDefs.map((d) => normalizeString(d?.name)).filter(Boolean);
  if (!toolNames.length) return { ok: false, detail: "no toolNames" };

  const toolDefsByName = new Map(pickedToolDefs.map((d) => [normalizeString(d?.name), d]).filter((x) => x[0]));

  const metaMismatches = [];
  const callFailed = [];
  const roundtripFailed = [];
  let calledOk = 0;
  let roundtripOk = 0;

  const emit = (line) => {
    try {
      if (typeof log === "function") log(String(line || ""));
    } catch {}
  };

  const buildExampleArgsJson = (toolDef) => {
    const rawSchema = shared.resolveToolSchema(toolDef);
    const schema = providerType === "openai_responses" ? shared.coerceOpenAiStrictJsonSchema(rawSchema, 0) : rawSchema;
    const sample = sampleJsonFromSchema(schema, 0);
    if (sample && typeof sample === "object" && !Array.isArray(sample)) {
      // 少量启发式：减少上游/网关对 format/pattern 的额外校验风险
      if (typeof sample.url === "string") sample.url = "https://example.com";
      if (typeof sample.uri === "string") sample.uri = "https://example.com";
      if (typeof sample.query === "string") sample.query = "hello";
      if (typeof sample.text === "string") sample.text = "hello";
      if (typeof sample.path === "string") sample.path = "selftest.txt";
    }
    try {
      return JSON.stringify(sample ?? {});
    } catch {
      return "{}";
    }
  };

  for (let i = 0; i < toolNames.length; i++) {
    const toolName = toolNames[i];
    const toolDef = toolDefsByName.get(toolName) || null;
    if (!toolDef) continue;
    const argsJson = buildExampleArgsJson(toolDef);

    const convId = `byok-selftest-realtools-${randomId()}`;
    const req1 = makeBaseAugmentChatRequest({
      message:
        `Self-test (real tools): You MUST call the tool ${toolName} now.\n` +
        `- This is a simulation: the tool will NOT be executed; a tool_result will be provided automatically.\n` +
        `- Use EXACT JSON arguments: ${argsJson}\n` +
        `- Do NOT output normal text; only call the tool.\n`,
      conversationId: convId,
      toolDefinitions: [toolDef],
      nodes: [],
      chatHistory: []
    });

    let res1;
    try {
      res1 = await chatStreamByProvider({ provider, model, req: req1, timeoutMs, abortSignal });
    } catch (err) {
      if (abortSignal && abortSignal.aborted) throw err;
      callFailed.push(toolName);
      emit(`[${providerLabel(provider)}] realTool ${i + 1}/${toolNames.length}: FAIL tool=${toolName} (chat-stream error: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const toolUses = extractToolUsesFromNodes(res1?.nodes);
    const match = toolUses.find((t) => normalizeString(t?.tool_name) === toolName) || null;
    if (!match) {
      const sr = normalizeString(res1?.stop_reason) || "n/a";
      callFailed.push(toolName);
      emit(`[${providerLabel(provider)}] realTool ${i + 1}/${toolNames.length}: FAIL tool=${toolName} (no tool_use, stop_reason=${sr})`);
      continue;
    }

    calledOk += 1;

    const expectedMcpServerName = normalizeString(toolDef?.mcp_server_name ?? toolDef?.mcpServerName);
    const expectedMcpToolName = normalizeString(toolDef?.mcp_tool_name ?? toolDef?.mcpToolName);
    if (expectedMcpServerName && normalizeString(match.mcp_server_name) !== expectedMcpServerName) {
      metaMismatches.push(`mcp_server_name ${toolName}: expected=${expectedMcpServerName} got=${normalizeString(match.mcp_server_name) || "?"}`);
    }
    if (expectedMcpToolName && normalizeString(match.mcp_tool_name) !== expectedMcpToolName) {
      metaMismatches.push(`mcp_tool_name ${toolName}: expected=${expectedMcpToolName} got=${normalizeString(match.mcp_tool_name) || "?"}`);
    }

    const exchange1 = {
      request_id: `selftest_realtool_${i + 1}_1`,
      request_message: req1.message,
      response_text: "",
      request_nodes: [],
      structured_request_nodes: [],
      nodes: [],
      response_nodes: Array.isArray(res1?.nodes) ? res1.nodes : [],
      structured_output_nodes: []
    };

    const req2 = makeBaseAugmentChatRequest({
      message: `Self-test (real tools): Tool result received. Reply with OK-realtools (${toolName}). Do NOT call any tool.`,
      conversationId: convId,
      toolDefinitions: [toolDef],
      nodes: [],
      chatHistory: [exchange1]
    });
    req2.request_nodes = [makeToolResultNode({ toolUseId: match.tool_use_id, contentText: "{\"ok\":true}", isError: false })];

    let res2;
    try {
      res2 = await chatStreamByProvider({ provider, model, req: req2, timeoutMs, abortSignal });
    } catch (err) {
      if (abortSignal && abortSignal.aborted) throw err;
      roundtripFailed.push(toolName);
      emit(`[${providerLabel(provider)}] realTool ${i + 1}/${toolNames.length}: FAIL tool=${toolName} (toolRoundtrip error: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const text2 = normalizeString(res2?.text);
    if (!text2) {
      const sr = normalizeString(res2?.stop_reason) || "n/a";
      roundtripFailed.push(toolName);
      emit(`[${providerLabel(provider)}] realTool ${i + 1}/${toolNames.length}: FAIL tool=${toolName} (empty assistant text after tool_result, stop_reason=${sr})`);
      continue;
    }

    roundtripOk += 1;
    if ((i + 1) % 5 === 0 || i + 1 === toolNames.length) {
      emit(`[${providerLabel(provider)}] realTool progress: ${i + 1}/${toolNames.length} (last=${toolName})`);
    }
  }

  const detailParts = [`tools=${toolNames.length}/${uniqueCount}`, `call=${calledOk}/${toolNames.length}`, `roundtrip=${roundtripOk}/${toolNames.length}`];
  if (callFailed.length) detailParts.push(`call_fail=${callFailed.length} first=${callFailed[0]}`);
  if (roundtripFailed.length) detailParts.push(`roundtrip_fail=${roundtripFailed.length} first=${roundtripFailed[0]}`);
  if (metaMismatches.length) detailParts.push(`meta_mismatch=${metaMismatches.length} first=${metaMismatches[0]}`);

  const ok = callFailed.length === 0 && roundtripFailed.length === 0 && metaMismatches.length === 0;
  return { ok, detail: detailParts.join(" ").trim() };
}

async function selfTestProvider({ cfg, provider, timeoutMs, abortSignal, log, capturedToolDefinitions }) {
  const pid = normalizeString(provider?.id) || "";
  const type = normalizeString(provider?.type);

  const entry = {
    providerId: pid,
    providerType: type,
    model: "",
    tests: [],
    ok: true
  };

  const record = (t) => {
    const test = t && typeof t === "object" ? t : { name: "unknown", ok: false, ms: 0, detail: "invalid test record" };
    entry.tests.push(test);
    if (test.ok === false) entry.ok = false;
    const badge = test.ok === true ? "ok" : "FAIL";
    const d = normalizeString(test.detail);
    log(`[${providerLabel(provider)}] ${test.name}: ${badge} (${formatMs(test.ms)})${d ? ` ${d}` : ""}`.trim());
  };

  const baseUrl = normalizeString(provider?.baseUrl);
  const apiKey = normalizeString(provider?.apiKey);
  const headers = provider?.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers) ? provider.headers : {};
  const authOk = Boolean(apiKey) || hasAuthHeader(headers);
  if (!type || !baseUrl || !authOk) {
    record({
      name: "config",
      ok: false,
      ms: 0,
      detail: `type/baseUrl/auth 未配置完整（type=${type || "?"}, baseUrl=${baseUrl || "?"}, auth=${authOk ? "set" : "empty"}）`
    });
    log(`[${providerLabel(provider)}] done`);
    return entry;
  }

  log(`[${providerLabel(provider)}] start`);

  const modelsRes = await withTimed(async () => await fetchProviderModels({ provider, timeoutMs: Math.min(15000, timeoutMs), abortSignal }));
  if (modelsRes.ok) {
    const models = Array.isArray(modelsRes.res) ? modelsRes.res : [];
    record({ name: "models", ok: true, ms: modelsRes.ms, detail: `models=${models.length}` });
    entry.model = pickProviderModel(provider, models);
  } else {
    record({ name: "models", ok: false, ms: modelsRes.ms, detail: modelsRes.error });
    entry.model = pickProviderModel(provider, []);
  }

  const model = normalizeString(entry.model);
  if (!model) {
    record({ name: "model", ok: false, ms: 0, detail: "未找到可用 model（请配置 providers[].defaultModel 或 models[]）" });
    log(`[${providerLabel(provider)}] done`);
    return entry;
  }

  const completionRes = await withTimed(async () => {
    const text = await completeTextByProvider({
      provider,
      model,
      system: "You are running a connectivity self-test. Output only: OK",
      messages: [{ role: "user", content: "OK" }],
      timeoutMs,
      abortSignal
    });
    return text;
  });
  if (completionRes.ok && normalizeString(completionRes.res)) {
    record({ name: "completeText", ok: true, ms: completionRes.ms, detail: `len=${String(completionRes.res).length}` });
  } else {
    record({ name: "completeText", ok: false, ms: completionRes.ms, detail: completionRes.ok ? "empty output" : completionRes.error });
  }

  const streamRes = await withTimed(async () => {
    const text = await streamTextByProvider({
      provider,
      model,
      system: "You are running a streaming self-test. Output only: OK",
      messages: [{ role: "user", content: "OK" }],
      timeoutMs,
      abortSignal
    });
    return text;
  });
  if (streamRes.ok && normalizeString(streamRes.res)) {
    record({ name: "streamText", ok: true, ms: streamRes.ms, detail: `len=${String(streamRes.res).length}` });
  } else {
    record({ name: "streamText", ok: false, ms: streamRes.ms, detail: streamRes.ok ? "empty output" : streamRes.error });
  }

  // /next-edit-stream prompt builder smoke test（走非流式 completeText）
  const nextEditRes = await withTimed(async () => {
    const body = {
      instruction: "Replace foo with bar in the selected range.",
      path: "selftest.js",
      lang: "javascript",
      prefix: "const x = '",
      selected_text: "foo",
      suffix: "';\nconsole.log(x);\n"
    };
    const { system, messages } = buildMessagesForEndpoint("/next-edit-stream", body);
    return await completeTextByProvider({ provider, model, system, messages, timeoutMs, abortSignal });
  });
  if (nextEditRes.ok && normalizeString(nextEditRes.res)) {
    record({ name: "nextEdit", ok: true, ms: nextEditRes.ms, detail: `len=${String(nextEditRes.res).length}` });
  } else {
    record({ name: "nextEdit", ok: false, ms: nextEditRes.ms, detail: nextEditRes.ok ? "empty output" : nextEditRes.error });
  }

  // chat-stream（基础）
  const chatReq = makeBaseAugmentChatRequest({
    message: "Self-test: reply with OK-chat (no markdown).",
    conversationId: `byok-selftest-${randomId()}`,
    toolDefinitions: [],
    nodes: [],
    chatHistory: []
  });
  const chatRes = await withTimed(async () => await chatStreamByProvider({ provider, model, req: chatReq, timeoutMs, abortSignal }));
  if (chatRes.ok && (normalizeString(chatRes.res?.text) || (Array.isArray(chatRes.res?.nodes) && chatRes.res.nodes.length))) {
    const tu = extractTokenUsageFromNodes(chatRes.res?.nodes);
    const usage = tu
      ? ` tokens=${formatMaybeInt(tu.input_tokens ?? tu.inputTokens) || "?"}/${formatMaybeInt(tu.output_tokens ?? tu.outputTokens) || "?"} cached=${formatMaybeInt(tu.cache_read_input_tokens ?? tu.cacheReadInputTokens) || "0"}`
      : "";
    record({
      name: "chatStream",
      ok: true,
      ms: chatRes.ms,
      detail: `textLen=${String(chatRes.res?.text || "").length} nodes=${Array.isArray(chatRes.res?.nodes) ? chatRes.res.nodes.length : 0}${usage}`
    });
  } else {
    record({ name: "chatStream", ok: false, ms: chatRes.ms, detail: chatRes.ok ? "empty output" : chatRes.error });
  }

  // 真实环境工具集：schema 校验 + chat-stream acceptance（不执行工具，仅验证上游是否接受 tools）
  const realToolDefs = Array.isArray(capturedToolDefinitions) ? capturedToolDefinitions : [];
  if (realToolDefs.length) {
    const sum = summarizeToolDefs(realToolDefs);
    const schemaRes = await withTimed(async () => {
      const converted = convertToolsByProviderType(type, realToolDefs);
      const v = validateConvertedToolsForProvider(type, converted);
      if (!v.ok) throw new Error(v.issues.slice(0, 8).join(" | "));
      return { convertedCount: Array.isArray(converted) ? converted.length : 0, firstNames: sum.names };
    });
    if (schemaRes.ok) {
      record({
        name: "realToolsSchema",
        ok: true,
        ms: schemaRes.ms,
        detail: `tools=${sum.count} converted=${schemaRes.res?.convertedCount ?? "?"} names=${sum.names.join(",")}${sum.namesTruncated ? ",…" : ""}`
      });
    } else {
      record({ name: "realToolsSchema", ok: false, ms: schemaRes.ms, detail: schemaRes.error });
    }

    const realToolsReq = makeBaseAugmentChatRequest({
      message: "Self-test: reply with OK-realtools. Do NOT call any tool unless absolutely necessary.",
      conversationId: `byok-selftest-${randomId()}`,
      toolDefinitions: realToolDefs,
      nodes: [],
      chatHistory: []
    });
    const realToolsChatRes = await withTimed(async () => await chatStreamByProvider({ provider, model, req: realToolsReq, timeoutMs, abortSignal }));
    if (realToolsChatRes.ok && (normalizeString(realToolsChatRes.res?.text) || (Array.isArray(realToolsChatRes.res?.nodes) && realToolsChatRes.res.nodes.length))) {
      record({
        name: "realToolsChatStream",
        ok: true,
        ms: realToolsChatRes.ms,
        detail: `textLen=${String(realToolsChatRes.res?.text || "").length} nodes=${Array.isArray(realToolsChatRes.res?.nodes) ? realToolsChatRes.res.nodes.length : 0} stop_reason=${normalizeString(realToolsChatRes.res?.stop_reason) || "n/a"}`
      });
    } else {
      record({ name: "realToolsChatStream", ok: false, ms: realToolsChatRes.ms, detail: realToolsChatRes.ok ? "empty output" : realToolsChatRes.error });
    }

    // 真实工具可用性：在真实工具 schema 下触发 tool_use + tool_result 往返（不执行真实工具；仅验证工具链路/配对逻辑对真实工具集可用）
    const realToolsRoundtripRes = await withTimed(
      async () => await realToolsToolRoundtripByProvider({ provider, model, toolDefinitions: realToolDefs, timeoutMs, abortSignal, log, maxTools: 9999 })
    );
    if (realToolsRoundtripRes.ok && realToolsRoundtripRes.res?.ok) {
      record({ name: "realToolsToolRoundtrip", ok: true, ms: realToolsRoundtripRes.ms, detail: realToolsRoundtripRes.res?.detail || "" });
    } else {
      record({
        name: "realToolsToolRoundtrip",
        ok: false,
        ms: realToolsRoundtripRes.ms,
        detail: realToolsRoundtripRes.ok ? (realToolsRoundtripRes.res?.detail || "failed") : realToolsRoundtripRes.error
      });
    }
  } else {
    record({ name: "realToolsSchema", ok: true, ms: 0, detail: "skipped (no captured tool_definitions yet)" });
    record({ name: "realToolsChatStream", ok: true, ms: 0, detail: "skipped (no captured tool_definitions yet)" });
    record({ name: "realToolsToolRoundtrip", ok: true, ms: 0, detail: "skipped (no captured tool_definitions yet)" });
  }

  // chat-stream（多模态 + 工具）
  const toolDefs = makeSelfTestToolDefinitions();
  const toolReq = makeBaseAugmentChatRequest({
    message:
      "Self-test tool call.\n1) You MUST call the tool echo_self_test with JSON arguments {\"text\":\"hello\"}.\n2) Do not output normal text; only call the tool.",
    conversationId: `byok-selftest-${randomId()}`,
    toolDefinitions: toolDefs,
    nodes: [makeImageNode()],
    chatHistory: []
  });

  const toolChatRes = await withTimed(async () => await chatStreamByProvider({ provider, model, req: toolReq, timeoutMs, abortSignal }));
  if (!toolChatRes.ok) {
    record({ name: "tools+multimodal", ok: false, ms: toolChatRes.ms, detail: toolChatRes.error });
    return entry;
  }

  const toolUses = extractToolUsesFromNodes(toolChatRes.res?.nodes);
  if (!toolUses.length) {
    record({
      name: "tools+multimodal",
      ok: true,
      ms: toolChatRes.ms,
      detail: `no tool_use observed (stop_reason=${normalizeString(toolChatRes.res?.stop_reason) || "n/a"})`
    });
    record({ name: "toolRoundtrip", ok: true, ms: 0, detail: "skipped (no tool call)" });
    log(`[${providerLabel(provider)}] done`);
    return entry;
  }

  const first = toolUses[0];
  record({
    name: "tools+multimodal",
    ok: true,
    ms: toolChatRes.ms,
    detail: `tool=${first.tool_name} id=${first.tool_use_id} stop_reason=${normalizeString(toolChatRes.res?.stop_reason) || "n/a"}`
  });

  // tool_result round-trip：把 tool_use 放入 history，再在下一轮 request_nodes 回填 tool_result
  const exchange1 = {
    request_id: "selftest_req_1",
    request_message: toolReq.message,
    response_text: "",
    request_nodes: [],
    structured_request_nodes: [],
    nodes: toolReq.nodes,
    response_nodes: Array.isArray(toolChatRes.res?.nodes) ? toolChatRes.res.nodes : [],
    structured_output_nodes: []
  };

  const toolReq2 = makeBaseAugmentChatRequest({
    message: "Tool result received. Reply with OK-tool.",
    conversationId: toolReq.conversation_id,
    toolDefinitions: toolDefs,
    nodes: [],
    chatHistory: [exchange1]
  });
  toolReq2.request_nodes = [makeToolResultNode({ toolUseId: first.tool_use_id, contentText: "{\"ok\":true}", isError: false })];

  const toolRoundtripRes = await withTimed(async () => await chatStreamByProvider({ provider, model, req: toolReq2, timeoutMs, abortSignal }));
  if (toolRoundtripRes.ok && normalizeString(toolRoundtripRes.res?.text)) {
    record({ name: "toolRoundtrip", ok: true, ms: toolRoundtripRes.ms, detail: `textLen=${String(toolRoundtripRes.res?.text || "").length}` });
  } else {
    record({ name: "toolRoundtrip", ok: false, ms: toolRoundtripRes.ms, detail: toolRoundtripRes.ok ? "empty output" : toolRoundtripRes.error });
  }

  // 提示：并非所有模型都会稳定 tool-call（尤其是 defaultModel 不是工具模型时），因此 toolRoundtrip 失败不一定代表 BYOK 协议有问题。
  if (normalizeString(toolRoundtripRes.error) && normalizeString(toolRoundtripRes.error).includes("tool_result_missing")) {
    record({ name: "note", ok: true, ms: 0, detail: "观察到 tool_result_missing：说明工具执行/回填缺失被容错降级（不是 400/422）。" });
  }

  if (toolChatRes.res?.stop_reason && toolChatRes.res.stop_reason !== STOP_REASON_TOOL_USE_REQUESTED) {
    record({ name: "note", ok: true, ms: 0, detail: `模型 stop_reason=${toolChatRes.res.stop_reason}（可能未真正进入工具模式）` });
  }

  log(`[${providerLabel(provider)}] done`);
  return entry;
}

async function selfTestHistorySummary({ cfg, fallbackProvider, fallbackModel, timeoutMs, abortSignal, log }) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const hs = c.historySummary && typeof c.historySummary === "object" && !Array.isArray(c.historySummary) ? c.historySummary : {};

  const convId = `byok-selftest-history-${randomId()}`;
  const mkEx = (i) => ({
    request_id: `selftest_h_${i}`,
    request_message: `User message ${i}: ` + "x".repeat(2000),
    response_text: `Assistant response ${i}: ` + "y".repeat(2000),
    request_nodes: [],
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  });
  const history = Array.from({ length: 6 }, (_, i) => mkEx(i + 1));

  // 只在内存中强制开启，避免用户必须手动启用 historySummary 才能自检
  const cfg2 = JSON.parse(JSON.stringify(c));
  cfg2.historySummary = {
    ...(hs && typeof hs === "object" ? hs : {}),
    enabled: true,
    triggerOnHistorySizeChars: 2000,
    historyTailSizeCharsToExclude: 0,
    minTailExchanges: 2,
    maxTokens: 256,
    timeoutSeconds: Math.max(5, Math.floor((Number(timeoutMs) || 30000) / 1000)),
    cacheTtlMs: 5 * 60 * 1000
  };

  const req1 = makeBaseAugmentChatRequest({ message: "continue", conversationId: convId, chatHistory: history });
  const req2 = makeBaseAugmentChatRequest({ message: "continue", conversationId: convId, chatHistory: history });

  const run1 = await withTimed(async () => {
    return await maybeSummarizeAndCompactAugmentChatRequest({
      cfg: cfg2,
      req: req1,
      requestedModel: fallbackModel,
      fallbackProvider,
      fallbackModel,
      timeoutMs,
      abortSignal
    });
  });

  const run2 = await withTimed(async () => {
    return await maybeSummarizeAndCompactAugmentChatRequest({
      cfg: cfg2,
      req: req2,
      requestedModel: fallbackModel,
      fallbackProvider,
      fallbackModel,
      timeoutMs,
      abortSignal
    });
  });

  try {
    await deleteHistorySummaryCache(convId);
  } catch {}

  const ok1 = run1.ok && run1.res === true;
  const ok2 = run2.ok && run2.res === true;
  const injected1 = Array.isArray(req1.request_nodes) && req1.request_nodes.some((n) => shared.normalizeNodeType(n) === REQUEST_NODE_HISTORY_SUMMARY);
  const injected2 = Array.isArray(req2.request_nodes) && req2.request_nodes.some((n) => shared.normalizeNodeType(n) === REQUEST_NODE_HISTORY_SUMMARY);

  if (ok1 && ok2) {
    log(`[historySummary] ok (run1=${run1.ms}ms injected=${injected1} run2=${run2.ms}ms injected=${injected2})`);
    // run2 应该命中 cache（一般更快），但不同环境也可能依旧触发网络；这里只做观察信息
    return { ok: true, ms: run1.ms + run2.ms, detail: `run1=${run1.ms}ms run2=${run2.ms}ms` };
  }

  const detail = `run1=${run1.ok ? String(run1.res) : run1.error} run2=${run2.ok ? String(run2.res) : run2.error}`;
  return { ok: false, ms: run1.ms + run2.ms, detail };
}

function selfTestOpenAiResponsesStrictSchema(log) {
  const defs = [
    {
      name: "schema_self_test",
      input_schema: {
        type: "object",
        properties: {
          a: { type: "string" },
          insert_line_1: { type: "integer" }
        },
        required: ["a"]
      }
    }
  ];
  const tools = convertOpenAiResponsesTools(defs);
  const p0 = tools?.[0]?.parameters;
  const props = p0 && typeof p0 === "object" && p0.properties && typeof p0.properties === "object" ? Object.keys(p0.properties) : [];
  const req = Array.isArray(p0?.required) ? p0.required : [];
  const missing = props.filter((k) => !req.includes(k));
  const ok = p0 && p0.additionalProperties === false && Array.isArray(p0.required) && missing.length === 0;
  log(`[responses strict schema] additionalProperties=${String(p0?.additionalProperties)} required_ok=${String(missing.length === 0)} props=${props.length}`);
  return ok;
}

function summarizeMaybeJson(value, { maxLen = 200 } = {}) {
  const lim = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 200;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return "";
    return s.length > lim ? s.slice(0, lim) + "…" : s;
  }
  try {
    const s = JSON.stringify(value ?? null);
    return s.length > lim ? s.slice(0, lim) + "…" : s;
  } catch {
    return String(value ?? "");
  }
}

function buildExampleArgsJsonForToolExecution(toolDef) {
  const schema = shared.resolveToolSchema(toolDef);
  const sample = sampleJsonFromSchema(schema, 0);
  const obj = sample && typeof sample === "object" && !Array.isArray(sample) ? sample : {};

  // 少量启发式：降低真实工具执行时的“格式/域名”校验风险
  if (typeof obj.url === "string") obj.url = "https://example.com";
  if (typeof obj.uri === "string") obj.uri = "https://example.com";
  if (typeof obj.query === "string") obj.query = "hello";
  if (typeof obj.text === "string") obj.text = "hello";
  if (typeof obj.path === "string") obj.path = "selftest.txt";

  try {
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

async function selfTestOfficialRemoteToolsExec({ toolDefinitions, timeoutMs, abortSignal, log }) {
  const off = getOfficialConnection();
  const completionURL = normalizeString(off?.completionURL);
  const apiToken = normalizeRawToken(off?.apiToken);
  if (!completionURL || !apiToken) {
    return { ok: false, ms: 0, detail: "official completion_url/api_token 未配置（无法真实执行工具；OAuth 登录态暂不支持自检）" };
  }

  const defs = dedupeToolDefsByName(toolDefinitions);
  const toolNames = defs.map((d) => normalizeString(d?.name)).filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (!toolNames.length) return { ok: false, ms: 0, detail: "no tools" };

  const t0 = nowMs();

  const idx = await fetchOfficialRemoteToolsIndex({
    completionURL,
    apiToken,
    timeoutMs: Math.min(30000, timeoutMs),
    abortSignal,
    expectedToolNames: toolNames
  });

  const missingIds = [];
  for (const name of toolNames) {
    const it = idx.byName.get(name);
    if (!it || it.remoteToolId == null) missingIds.push(name);
  }

  if (missingIds.length) {
    log(`[official tools] list-remote-tools partial: matched=${idx.matched}/${toolNames.length} attempt=${idx.attempt} missing_id=${missingIds[0]}${missingIds.length > 1 ? ",…" : ""}`);
  } else {
    log(`[official tools] list-remote-tools ok: matched=${idx.matched}/${toolNames.length} attempt=${idx.attempt} tools=${idx.items.length}`);
  }

  const defsByName = new Map(defs.map((d) => [normalizeString(d?.name), d]).filter((x) => x[0]));

  const failed = [];
  const unsafe = [];
  const executed = [];

  for (let i = 0; i < toolNames.length; i++) {
    const name = toolNames[i];
    const meta = idx.byName.get(name);
    const toolId = meta?.remoteToolId;
    const toolDef = defsByName.get(name) || null;
    if (!toolDef || toolId == null) {
      failed.push(name);
      log(`[official tool ${i + 1}/${toolNames.length}] FAIL tool=${name} (missing remoteToolId)`);
      continue;
    }

    const inputJson = buildExampleArgsJsonForToolExecution(toolDef);

    // 1) 安全性检查
    let isSafe = false;
    try {
      const r = await fetchOfficialCheckToolSafety({ completionURL, apiToken, toolId, toolInputJson: inputJson, timeoutMs: Math.min(20000, timeoutMs), abortSignal });
      isSafe = Boolean(r?.is_safe ?? r?.isSafe);
    } catch (err) {
      failed.push(name);
      log(`[official tool ${i + 1}/${toolNames.length}] FAIL tool=${name} (check-tool-safety: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    if (!isSafe) {
      unsafe.push(name);
      log(`[official tool ${i + 1}/${toolNames.length}] FAIL tool=${name} (unsafe by policy)`);
      continue;
    }

    // 2) 真实执行
    try {
      const r = await fetchOfficialRunRemoteTool({ completionURL, apiToken, toolId, toolName: name, toolInputJson: inputJson, timeoutMs, abortSignal });
      const status = r?.status;
      const toolOutput = r?.tool_output ?? r?.toolOutput;
      const toolResultMessage = r?.tool_result_message ?? r?.toolResultMessage;
      const outSum = summarizeMaybeJson(toolOutput, { maxLen: 180 });
      const msgSum = summarizeMaybeJson(toolResultMessage, { maxLen: 180 });
      const hasOutput = toolOutput != null && !(typeof toolOutput === "string" && !toolOutput.trim());
      const hasMessage = typeof toolResultMessage === "string" && Boolean(toolResultMessage.trim());
      if (!hasOutput && !hasMessage) {
        failed.push(name);
        log(`[official tool ${i + 1}/${toolNames.length}] FAIL tool=${name} (empty tool_output/tool_result_message)`);
        continue;
      }
      executed.push(name);
      log(
        `[official tool ${i + 1}/${toolNames.length}] ok tool=${name} status=${normalizeString(status) || String(status ?? "") || "?"} output=${outSum ? "yes" : "no"} message=${msgSum ? "yes" : "no"}`
      );
    } catch (err) {
      failed.push(name);
      log(`[official tool ${i + 1}/${toolNames.length}] FAIL tool=${name} (run-remote-tool: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const ms = nowMs() - t0;
  const detail = `matched=${idx.matched}/${toolNames.length} exec_ok=${executed.length}/${toolNames.length} unsafe=${unsafe.length} failed=${failed.length}`;
  const ok = failed.length === 0 && unsafe.length === 0 && missingIds.length === 0 && executed.length === toolNames.length;
  return { ok, ms, detail };
}

async function runSelfTest({ cfg, timeoutMs, abortSignal, onEvent } = {}) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const providers = Array.isArray(c.providers) ? c.providers : [];
  const t = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : 30000;

  const report = {
    startedAtMs: nowMs(),
    finishedAtMs: 0,
    ok: true,
    global: { tests: [], capturedTools: null },
    providers: []
  };

  const emit = (ev) => {
    try {
      if (typeof onEvent === "function") onEvent(ev);
    } catch {}
  };
  const log = (line) => emit({ type: "log", line: String(line || "") });

  log("Self Test started.");

  const captured = getLastCapturedToolDefinitions();
  const capturedDefs0 = Array.isArray(captured?.toolDefinitions) ? captured.toolDefinitions : [];
  const capturedMeta0 = captured?.meta && typeof captured.meta === "object" ? captured.meta : null;
  const capturedAtMs0 = Number(captured?.capturedAtMs) || 0;

  let toolDefsForSelfTest = capturedDefs0;
  let toolDefsSource = capturedDefs0.length ? "captured" : "none";
  let toolDefsMeta = capturedMeta0;
  let toolDefsCapturedAtMs = capturedAtMs0;

  // captured tools 为空时，尝试走官方 /agents/list-remote-tools 拉取（需要 official.api_token）。
  if (!toolDefsForSelfTest.length) {
    const off = getOfficialConnection();
    const completionURL = normalizeString(off?.completionURL);
    const apiToken = normalizeRawToken(off?.apiToken);
    if (completionURL && apiToken) {
      log("[captured tools] none → 尝试通过 official /agents/list-remote-tools 自动拉取真实工具定义…");
      const fetchRes = await withTimed(async () => {
        const idx = await fetchOfficialRemoteToolsIndex({ completionURL, apiToken, timeoutMs: Math.min(20000, t), abortSignal });
        const defs = extractToolDefinitionsFromOfficialRemoteTools(idx.items);
        return { defs, attempt: idx.attempt, tools: idx.items.length };
      });
      if (fetchRes.ok && Array.isArray(fetchRes.res?.defs) && fetchRes.res.defs.length) {
        toolDefsForSelfTest = fetchRes.res.defs;
        toolDefsSource = `official(list-remote-tools:${fetchRes.res.attempt})`;
        toolDefsMeta = { endpoint: "/agents/list-remote-tools", attempt: fetchRes.res.attempt, tools: fetchRes.res.tools };
        toolDefsCapturedAtMs = nowMs();
        try {
          captureAugmentToolDefinitions(toolDefsForSelfTest, { ...toolDefsMeta, capturedBy: "self-test" });
        } catch {}
        log(`[captured tools] fetched count=${toolDefsForSelfTest.length} via ${toolDefsSource}`);
      } else {
        const msg = fetchRes.ok ? "empty tool list" : fetchRes.error;
        log(`[captured tools] auto fetch failed: ${msg}`);
      }
    } else {
      log("[captured tools] none (未配置 official.api_token，Self Test 无法自动拉取真实工具定义；可先跑一次 Agent /chat-stream 以捕获 tool_definitions)");
    }
  }

  const capturedSummary = summarizeToolDefs(toolDefsForSelfTest);
  const capturedAgeMs = toolDefsCapturedAtMs ? Math.max(0, nowMs() - Number(toolDefsCapturedAtMs)) : 0;
  report.global.capturedTools = {
    count: capturedSummary.count,
    capturedAtMs: toolDefsCapturedAtMs,
    ageMs: capturedSummary.count ? capturedAgeMs : 0,
    meta: toolDefsMeta,
    source: toolDefsSource,
    namesPreview: capturedSummary.names
  };

  if (capturedSummary.count) {
    log(`[captured tools] count=${capturedSummary.count} age=${formatMs(capturedAgeMs)} source=${toolDefsSource} names=${capturedSummary.names.join(",")}${capturedSummary.namesTruncated ? ",…" : ""}`);
    report.global.tests.push({ name: "capturedToolsAvailable", ok: true, detail: `count=${capturedSummary.count} source=${toolDefsSource}` });
  } else {
    report.global.tests.push({
      name: "capturedToolsAvailable",
      ok: false,
      detail: "未捕获到真实 tool_definitions 且无法自动拉取；Self Test 无法覆盖真实工具集"
    });
    report.ok = false;
  }

  // captured tools：schema 可解析性/可 JSON 化（不执行工具）
  if (toolDefsForSelfTest.length) {
    const schemaSum = summarizeCapturedToolsSchemas(toolDefsForSelfTest);
    const ok = schemaSum.sampleOk === schemaSum.toolCount;
    report.global.tests.push({
      name: "capturedToolsSchemaSamples",
      ok,
      detail: `sampleable=${schemaSum.sampleOk}/${schemaSum.toolCount} mcpMeta=${schemaSum.withMcpMeta}${schemaSum.sampleFailedNames.length ? ` failed=${schemaSum.sampleFailedNames.join(",")}${schemaSum.sampleFailedTruncated ? ",…" : ""}` : ""}`
    });
    log(
      `[captured tools schema] sampleable=${schemaSum.sampleOk}/${schemaSum.toolCount} mcpMeta=${schemaSum.withMcpMeta}${schemaSum.sampleFailedNames.length ? ` failed=${schemaSum.sampleFailedNames.join(",")}${schemaSum.sampleFailedTruncated ? ",…" : ""}` : ""}`
    );
    if (!ok) report.ok = false;
  } else {
    report.global.tests.push({ name: "capturedToolsSchemaSamples", ok: true, detail: "skipped (no captured tools)" });
  }

  const localSchemaOk = selfTestOpenAiResponsesStrictSchema(log);
  report.global.tests.push({ name: "responsesStrictSchema", ok: Boolean(localSchemaOk) });
  if (!localSchemaOk) report.ok = false;

  if (toolDefsForSelfTest.length) {
    const strictCaptured = await withTimed(async () => {
      const tools = convertOpenAiResponsesTools(toolDefsForSelfTest);
      const v = validateConvertedToolsForProvider("openai_responses", tools);
      if (!v.ok) throw new Error(v.issues.slice(0, 10).join(" | "));
      return { tools: Array.isArray(tools) ? tools.length : 0 };
    });
    if (strictCaptured.ok) {
      report.global.tests.push({ name: "responsesStrictSchema(capturedTools)", ok: true, ms: strictCaptured.ms, detail: `tools=${strictCaptured.res?.tools ?? "?"}` });
      log(`[responses strict schema][capturedTools] ok (${formatMs(strictCaptured.ms)}) tools=${strictCaptured.res?.tools ?? "?"}`);
    } else {
      report.global.tests.push({ name: "responsesStrictSchema(capturedTools)", ok: false, ms: strictCaptured.ms, detail: strictCaptured.error });
      log(`[responses strict schema][capturedTools] FAIL (${formatMs(strictCaptured.ms)}) ${strictCaptured.error}`);
      report.ok = false;
    }
  } else {
    report.global.tests.push({ name: "responsesStrictSchema(capturedTools)", ok: true, ms: 0, detail: "skipped (no captured tools)" });
  }

  // 真实工具执行：对真实环境的 tools 做一次“真实执行”验证（需要 official.api_token；会产生一定副作用/访问网络）
  if (toolDefsForSelfTest.length) {
    const offExecRes = await withTimed(async () => await selfTestOfficialRemoteToolsExec({ toolDefinitions: toolDefsForSelfTest, timeoutMs: t, abortSignal, log }));
    if (offExecRes.ok) {
      const r = offExecRes.res && typeof offExecRes.res === "object" ? offExecRes.res : null;
      const ms = Number.isFinite(Number(r?.ms)) && Number(r?.ms) >= 0 ? Number(r.ms) : offExecRes.ms;
      const ok = Boolean(r?.ok);
      report.global.tests.push({ name: "officialToolsExec", ok, ms, detail: normalizeString(r?.detail) || "" });
      if (!ok) report.ok = false;
    } else {
      report.global.tests.push({ name: "officialToolsExec", ok: false, ms: offExecRes.ms, detail: offExecRes.error });
      report.ok = false;
    }
  } else {
    report.global.tests.push({ name: "officialToolsExec", ok: true, ms: 0, detail: "skipped (no tools)" });
  }

  const providerResults = [];
  for (const p of providers) {
    const res = await selfTestProvider({ cfg: c, provider: p, timeoutMs: t, abortSignal, log, capturedToolDefinitions: toolDefsForSelfTest });
    providerResults.push(res);
    report.providers.push(res);
    if (!res.ok) report.ok = false;
  }

  // historySummary：用第一个可用 provider 作为 fallback（真实逻辑也是：hs.providerId 不配时 fallback 到当前 provider）
  const firstOkProvider = providers.find((p) => normalizeString(p?.type) && normalizeString(p?.baseUrl) && (normalizeString(p?.apiKey) || hasAuthHeader(p?.headers)));
  const fallbackProvider = firstOkProvider || providers[0] || null;
  const fallbackModel = normalizeString(fallbackProvider?.defaultModel) || normalizeString(fallbackProvider?.models?.[0]) || "";
  if (fallbackProvider && fallbackModel) {
    const hsRes = await selfTestHistorySummary({ cfg: c, fallbackProvider, fallbackModel, timeoutMs: t, abortSignal, log });
    report.global.tests.push({ name: "historySummary", ok: Boolean(hsRes.ok), detail: hsRes.detail, ms: hsRes.ms });
    if (!hsRes.ok) report.ok = false;
  } else {
    report.global.tests.push({ name: "historySummary", ok: true, detail: "skipped (no provider configured)" });
  }

  report.finishedAtMs = nowMs();
  log(`Self Test finished. ok=${String(report.ok)}`);
  debug(`self-test done: providers=${report.providers.length} ok=${String(report.ok)}`);
  emit({ type: "done", report });
  return report;
}

module.exports = { runSelfTest };
