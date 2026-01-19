"use strict";

const { maybeHandleCallApi } = require("./shim-call-api");
const { maybeHandleCallApiStream } = require("./shim-call-api-stream");

module.exports = { maybeHandleCallApi, maybeHandleCallApiStream };
