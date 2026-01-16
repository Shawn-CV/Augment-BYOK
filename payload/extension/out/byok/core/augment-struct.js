"use strict";

function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asString(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function pick(obj, keys) {
  const o = asRecord(obj);
  for (const k of asArray(keys)) if (Object.prototype.hasOwnProperty.call(o, k)) return o[k];
  return undefined;
}

function normalizeNodeType(node) {
  const r = asRecord(node);
  const v = pick(r, ["type", "node_type", "nodeType"]);
  const n = Number(v);
  return Number.isFinite(n) ? n : -1;
}

module.exports = { asRecord, asArray, asString, pick, normalizeNodeType };
