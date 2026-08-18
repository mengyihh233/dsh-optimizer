window.__ModuleLoader__.load({ id: "dsh-optimizer", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = __toESM(require("react"), 1);
async function rpc(method, args) {
  const res = await fetch("/dsh-optimizer/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args: args ?? {} })
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  return await res.json();
}
var name = "dsh-optimizer";
var inject = ["slots"];
var CSS = `
.dsh-opt-root{display:flex;flex-direction:column;gap:16px;padding:4px 0}
.dsh-opt-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.dsh-opt-card h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-opt-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}
.dsh-opt-stat{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.dsh-opt-stat b{font-size:18px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-opt-stat span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-opt-row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px}
.dsh-opt-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-opt-row-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}
.dsh-opt-row-detail{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:18px;word-break:break-all}
.dsh-opt-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:10px;flex:none}
.dsh-opt-badge-high{background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary)}
.dsh-opt-badge-medium{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.dsh-opt-badge-low{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-opt-btn{border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer;flex:none;color:var(--dsw-alias-label-primary-bluish);background:var(--dsw-alias-state-business-tertiary)}
.dsh-opt-btn:hover:not(:disabled){filter:brightness(1.1)}
.dsh-opt-btn:disabled{opacity:.5;cursor:default}
.dsh-opt-btn-primary{background:var(--dsw-static-deepseek-500,#4d6bfe);color:#fff}
.dsh-opt-btn-ghost{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-opt-log{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.dsh-opt-ok{color:var(--dsw-alias-state-success-primary)}
.dsh-opt-err{color:var(--dsw-alias-state-error-primary)}
.dsh-opt-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px 0}
`;
function severityLabel(s) {
  return s === "high" ? "\u9AD8" : s === "medium" ? "\u4E2D" : "\u4F4E";
}
function OptimizerSettings(props) {
  const [scan, setScan] = import_react.default.useState(null);
  const [loading, setLoading] = import_react.default.useState(false);
  const [log, setLog] = import_react.default.useState([]);
  const [applying, setApplying] = import_react.default.useState(null);
  const pushLog = (line) => setLog((prev) => [...prev.slice(-19), line]);
  const runScan = import_react.default.useCallback(async () => {
    setLoading(true);
    try {
      const r = await rpc("optimizer/scan");
      setScan(r);
      if (!r.ok) pushLog("\u626B\u63CF\u5931\u8D25: " + (r.message ?? "\u672A\u77E5\u9519\u8BEF"));
      else pushLog(`\u626B\u63CF\u5B8C\u6210\uFF1A${r.stats?.total ?? 0} \u4F1A\u8BDD / ${r.stats?.totalMB ?? 0}MB\uFF0C\u53D1\u73B0 ${r.issues?.length ?? 0} \u9879`);
    } catch (e) {
      pushLog("\u626B\u63CF\u5F02\u5E38: " + String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  import_react.default.useEffect(() => {
    runScan();
  }, [runScan]);
  const doFix = import_react.default.useCallback(async (id, fix, label) => {
    setApplying(id);
    try {
      const r = await rpc("optimizer/apply", { fix });
      pushLog(`${r.ok ? "\u2713" : "\u2717"} ${label}: ${r.message ?? ""}`);
      await runScan();
    } catch (e) {
      pushLog(`\u2717 ${label}: \u5F02\u5E38 ${String(e)}`);
    } finally {
      setApplying(null);
    }
  }, [runScan]);
  const fixAll = import_react.default.useCallback(async () => {
    if (!scan?.issues) return;
    setApplying("all");
    try {
      const todo = scan.issues.filter((i) => i.fix && i.fix !== "none");
      if (todo.length === 0) {
        pushLog("\u5F53\u524D\u6CA1\u6709\u53EF\u4E00\u952E\u4F18\u5316\u7684\u9879\uFF08\u8865\u4E01\u5DF2\u5E94\u7528\u3001\u4F1A\u8BDD\u5065\u5EB7\uFF09\u3002\u7B49\u51FA\u73B0\u7A7A\u4F1A\u8BDD/24h \u672A\u52A8\u7684\u5927\u4F1A\u8BDD/\u8865\u4E01\u5931\u6548\u540E\u518D\u8BD5\u3002");
      }
      for (const issue of todo) {
        const r = await rpc("optimizer/apply", { fix: issue.fix });
        pushLog(`${r.ok ? "\u2713" : "\u2717"} ${issue.title}: ${r.message ?? ""}`);
      }
      if (todo.length > 0) pushLog("\u4E00\u952E\u4F18\u5316\u5B8C\u6210");
      await runScan();
    } catch (e) {
      pushLog("\u4E00\u952E\u4F18\u5316\u5F02\u5E38: " + String(e));
    } finally {
      setApplying(null);
    }
  }, [scan, runScan]);
  const fixable = scan?.issues?.filter((i) => i.fix && i.fix !== "none") ?? [];
  const patch = scan?.patch;
  const stats = scan?.stats;
  return import_react.default.createElement(
    "div",
    { className: "dsh-opt-root" },
    import_react.default.createElement(
      "div",
      { className: "dsh-opt-card" },
      import_react.default.createElement("h3", null, "\u4E00\u952E\u4F18\u5316"),
      import_react.default.createElement(
        "div",
        { className: "dsh-opt-stats" },
        import_react.default.createElement(
          "div",
          { className: "dsh-opt-stat" },
          import_react.default.createElement("b", null, String(patch?.patched ?? "\u2014")),
          import_react.default.createElement("span", null, "\u5206\u9875\u8865\u4E01")
        ),
        import_react.default.createElement(
          "div",
          { className: "dsh-opt-stat" },
          import_react.default.createElement("b", null, String(stats?.total ?? "\u2014")),
          import_react.default.createElement("span", null, "\u4F1A\u8BDD\u603B\u6570")
        ),
        import_react.default.createElement(
          "div",
          { className: "dsh-opt-stat" },
          import_react.default.createElement("b", null, String(stats?.totalMB ?? "\u2014")),
          import_react.default.createElement("span", null, "\u5360\u7528 (MB)")
        ),
        import_react.default.createElement(
          "div",
          { className: "dsh-opt-stat" },
          import_react.default.createElement("b", null, String(stats?.empty ?? "\u2014")),
          import_react.default.createElement("span", null, "\u7A7A\u4F1A\u8BDD")
        )
      ),
      import_react.default.createElement(
        "div",
        { style: { display: "flex", gap: "8px", marginTop: "4px" } },
        import_react.default.createElement("button", {
          className: "dsh-opt-btn dsh-opt-btn-primary",
          disabled: loading,
          onClick: runScan
        }, loading ? "\u626B\u63CF\u4E2D\u2026" : "\u4E00\u952E\u626B\u63CF"),
        import_react.default.createElement("button", {
          className: "dsh-opt-btn",
          disabled: applying !== null,
          onClick: fixAll
        }, applying === "all" ? "\u4F18\u5316\u4E2D\u2026" : `\u4E00\u952E\u4F18\u5316\u5168\u90E8 (${fixable.length})`)
      )
    ),
    import_react.default.createElement(
      "div",
      { className: "dsh-opt-card" },
      import_react.default.createElement("h3", null, "\u53D1\u73B0\u7684\u53EF\u4F18\u5316\u95EE\u9898"),
      ...scan === null ? [import_react.default.createElement("div", { className: "dsh-opt-empty" }, "\u6B63\u5728\u626B\u63CF\u2026")] : scan.issues && scan.issues.length > 0 ? scan.issues.map(
        (issue) => import_react.default.createElement(
          "div",
          { className: "dsh-opt-row", key: issue.id },
          import_react.default.createElement(
            "div",
            { className: "dsh-opt-row-main" },
            import_react.default.createElement(
              "div",
              { className: "dsh-opt-row-title" },
              import_react.default.createElement("span", { className: `dsh-opt-badge dsh-opt-badge-${issue.severity}` }, severityLabel(issue.severity)),
              import_react.default.createElement("span", null, issue.title)
            ),
            import_react.default.createElement("div", { className: "dsh-opt-row-detail" }, issue.detail)
          ),
          issue.fix && issue.fix !== "none" ? import_react.default.createElement("button", {
            className: "dsh-opt-btn dsh-opt-btn-ghost",
            disabled: applying !== null,
            onClick: () => doFix(issue.id, issue.fix, issue.title)
          }, applying === issue.id ? "\u5904\u7406\u4E2D\u2026" : "\u4FEE\u590D") : null
        )
      ) : [import_react.default.createElement("div", { className: "dsh-opt-empty" }, "\u6682\u65E0\u6570\u636E")]
    ),
    import_react.default.createElement(
      "div",
      { className: "dsh-opt-card" },
      import_react.default.createElement("h3", null, "\u64CD\u4F5C\u65E5\u5FD7"),
      import_react.default.createElement(
        "div",
        { className: "dsh-opt-log" },
        log.length === 0 ? "\u6682\u65E0\u64CD\u4F5C\u3002\u70B9\u51FB\u300C\u4E00\u952E\u626B\u63CF\u300D\u5F00\u59CB\u3002" : log.join("\n")
      )
    )
  );
}
function apply(ctx) {
  try {
    if (typeof document !== "undefined") {
      if (document.getElementById("dsh-optimizer-css") === null) {
        const styleEl = document.createElement("style");
        styleEl.id = "dsh-optimizer-css";
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);
      }
    }
  } catch {
  }
  const slots = ctx.get("slots");
  if (slots === void 0) return;
  slots.inject(
    "settings.section",
    () => slots.register(
      { name: "settings.section", id: "optimizer", order: 50, label: "\u4F18\u5316" },
      (props) => import_react.default.createElement(OptimizerSettings, { close: props.close })
    )
  );
}
return module.exports; } });
