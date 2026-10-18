/**
 * dsh-opencode-bridge client 半区：「模型暴露」设置面板。
 *
 * 形态：DSH 浏览器模块表模块（window.__ModuleLoader__，官方 decoration 模板同款），
 * id 必须等于包名。零构建链手写 vanilla JS + React.createElement（react 取自模块表）。
 *
 * 入口：左栏 sidebar.panellist（「插件」卡旁）+ main 面板 —— 点开是模型勾选列表，
 * 勾选结果经 /api/opencode-bridge.filter 写回 ~/.dsh-opencode-bridge/config.json，
 * host 的 createModelLister 每次列模型重读配置，下次打开模型选择器即生效。
 */
window.__ModuleLoader__.load({
  id: "@home-river/dsh-opencode-bridge",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const PANEL_ID = "opencode-bridge-models";
    const MODELS_URL = "/api/opencode-bridge.models";
    const FILTER_URL = "/api/opencode-bridge.filter";

    // ---- 自持字典（zh 优先；en 兜底）----
    const DICT = {
      zh: {
        panel: "模型暴露",
        title: "OpenCode 模型暴露设置",
        subtitle: "勾选要暴露到 DSH 模型选择器的模型；保存后下次打开选择器生效。",
        search: "筛选模型…",
        selectAll: "全选当前",
        clearAll: "清空当前",
        reload: "重新加载",
        save: "保存",
        saving: "保存中…",
        saved: "已保存",
        loading: "加载中…",
        loadFailed: "加载失败",
        saveFailed: "保存失败",
        empty: "没有匹配的模型",
        count: "已选 {n} / {total}",
        configError: "配置文件异常（已按默认过滤）：{msg}",
        serviceDown: "设置服务不可用：host 侧 connection 路由未注册",
      },
      en: {
        panel: "Models",
        title: "OpenCode model exposure",
        subtitle: "Tick the models to expose in the DSH model picker; saved changes apply on next open.",
        search: "Filter models…",
        selectAll: "Select shown",
        clearAll: "Clear shown",
        reload: "Reload",
        save: "Save",
        saving: "Saving…",
        saved: "Saved",
        loading: "Loading…",
        loadFailed: "Load failed",
        saveFailed: "Save failed",
        empty: "No matching models",
        count: "{n} / {total} selected",
        configError: "Config file unhealthy (defaults applied): {msg}",
        serviceDown: "Settings service unavailable: host connection routes not registered",
      },
    };
    const lang = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? "zh" : "en";
    const dict = DICT[lang] || DICT.en;
    function t(key, params) {
      let text = dict[key] || DICT.en[key] || key;
      for (const k of Object.keys(params || {})) text = text.replace(`{${k}}`, String(params[k]));
      return text;
    }

    // ---- 样式（幂等注入；只用皮肤 token，不硬编码色值）----
    function injectStyles() {
      if (typeof document === "undefined" || document.getElementById("opencode-bridge-model-css")) return;
      const style = document.createElement("style");
      style.id = "opencode-bridge-model-css";
      style.textContent = `
.obm-wrap { display:flex; flex-direction:column; gap:12px; padding:16px; height:100%; overflow:hidden; color:var(--dsw-alias-text-primary,#222); }
.obm-head { display:flex; flex-direction:column; gap:4px; }
.obm-title { font-size:15px; font-weight:600; }
.obm-sub { font-size:12px; opacity:.72; line-height:1.5; }
.obm-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.obm-search { flex:1; min-width:160px; padding:6px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-default,#8884); background:var(--dsw-alias-bg-elevated,transparent); color:inherit; }
.obm-btn { padding:5px 12px; border-radius:6px; border:1px solid var(--dsw-alias-border-default,#8884); background:var(--dsw-alias-bg-elevated,transparent); color:inherit; cursor:pointer; font-size:12px; }
.obm-btn:disabled { opacity:.5; cursor:default; }
.obm-btn-primary { background:var(--dsw-alias-state-primary,#2080ff); color:var(--dsw-alias-text-on-primary,#fff); border-color:transparent; }
.obm-count { font-size:12px; opacity:.72; white-space:nowrap; }
.obm-list { flex:1; overflow:auto; border:1px solid var(--dsw-alias-border-default,#8883); border-radius:8px; }
.obm-row { display:flex; align-items:center; gap:10px; padding:7px 12px; border-bottom:1px solid var(--dsw-alias-border-default,#8882); cursor:pointer; }
.obm-row:hover { background:var(--dsw-alias-bg-hover,#8881); }
.obm-row input { accent-color:var(--dsw-alias-state-primary,#2080ff); }
.obm-row-id { font-family:var(--dsw-font-mono,monospace); font-size:11px; opacity:.6; }
.obm-row-name { font-size:13px; }
.obm-row.off .obm-row-name { opacity:.55; }
.obm-foot { display:flex; align-items:center; gap:10px; }
.obm-status { font-size:12px; opacity:.75; }
.obm-status.err { color:var(--dsw-alias-state-error-primary,#c0392b); opacity:1; }
.obm-status.ok { color:var(--dsw-alias-state-success-primary,#1e8e3e); opacity:1; }
.obm-warn { font-size:12px; padding:8px 10px; border-radius:6px; border:1px solid var(--dsw-alias-state-warning-primary,#c98a12); opacity:.9; }
`;
      document.head.appendChild(style);
    }

    // ---- 数据访问 ----
    async function loadState() {
      const res = await fetch(MODELS_URL, { method: "GET" });
      const payload = await res.json();
      if (!payload.ok) throw new Error(payload.error || t("loadFailed"));
      return payload.value;
    }
    async function saveSelection(selected) {
      const res = await fetch(FILTER_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selected }),
      });
      const payload = await res.json();
      if (!payload.ok) throw new Error(payload.error || t("saveFailed"));
      return payload.value;
    }

    // ---- 面板组件 ----
    function ModelExposurePanel() {
      const [state, setState] = React.useState(null);
      const [checked, setChecked] = React.useState(() => new Set());
      const [query, setQuery] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState(null); // {kind:"ok"|"err", text}

      const load = React.useCallback(async () => {
        setBusy(true);
        setStatus(null);
        try {
          const value = await loadState();
          setState(value);
          setChecked(new Set(value.models.filter((m) => m.visible).map((m) => m.id)));
        } catch (e) {
          setStatus({ kind: "err", text: `${t("loadFailed")}: ${e && e.message ? e.message : e}` });
        } finally {
          setBusy(false);
        }
      }, []);
      React.useEffect(() => { void load(); }, [load]);

      const models = state ? state.models : [];
      const q = query.trim().toLowerCase();
      const shown = q === "" ? models : models.filter((m) => (m.id + " " + (m.name || "")).toLowerCase().includes(q));

      const toggle = (id) => setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      const markShown = (on) => setChecked((prev) => {
        const next = new Set(prev);
        for (const m of shown) { if (on) next.add(m.id); else next.delete(m.id); }
        return next;
      });
      const save = async () => {
        setBusy(true);
        setStatus(null);
        try {
          const value = await saveSelection([...checked]);
          setState(value);
          setChecked(new Set(value.models.filter((m) => m.visible).map((m) => m.id)));
          setStatus({ kind: "ok", text: t("saved") });
        } catch (e) {
          setStatus({ kind: "err", text: `${t("saveFailed")}: ${e && e.message ? e.message : e}` });
        } finally {
          setBusy(false);
        }
      };

      return h("div", { className: "obm-wrap" },
        h("div", { className: "obm-head" },
          h("div", { className: "obm-title" }, t("title")),
          h("div", { className: "obm-sub" }, t("subtitle")),
        ),
        state && state.configError
          ? h("div", { className: "obm-warn" }, t("configError", { msg: state.configError }))
          : null,
        h("div", { className: "obm-bar" },
          h("input", {
            className: "obm-search", value: query, placeholder: t("search"),
            onChange: (e) => setQuery(e.target.value),
          }),
          h("button", { className: "obm-btn", onClick: () => markShown(true), disabled: busy }, t("selectAll")),
          h("button", { className: "obm-btn", onClick: () => markShown(false), disabled: busy }, t("clearAll")),
          h("button", { className: "obm-btn", onClick: () => void load(), disabled: busy }, t("reload")),
          h("span", { className: "obm-count" }, t("count", { n: checked.size, total: models.length })),
        ),
        h("div", { className: "obm-list" },
          state === null
            ? h("div", { className: "obm-row" }, busy ? t("loading") : "")
            : shown.length === 0
              ? h("div", { className: "obm-row" }, t("empty"))
              : shown.map((m) =>
                  h("label", { key: m.id, className: "obm-row" + (checked.has(m.id) ? "" : " off") },
                    h("input", {
                      type: "checkbox",
                      checked: checked.has(m.id),
                      onChange: () => toggle(m.id),
                    }),
                    h("span", { className: "obm-row-name" }, m.name || m.id),
                    h("span", { className: "obm-row-id" }, m.id),
                  )),
        ),
        h("div", { className: "obm-foot" },
          h("button", { className: "obm-btn obm-btn-primary", onClick: () => void save(), disabled: busy || state === null }, busy ? t("saving") : t("save")),
          status ? h("span", { className: "obm-status " + status.kind }, status.text) : null,
        ),
      );
    }

    function PanelIcon() {
      return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" },
        h("rect", { x: 1, y: 3, width: 14, height: 2, rx: 1 }),
        h("rect", { x: 1, y: 7, width: 14, height: 2, rx: 1 }),
        h("rect", { x: 1, y: 11, width: 14, height: 2, rx: 1 }),
        h("circle", { cx: 5, cy: 4, r: 2, fill: "var(--dsw-alias-bg-elevated,#fff)" }),
        h("circle", { cx: 11, cy: 8, r: 2, fill: "var(--dsw-alias-bg-elevated,#fff)" }),
        h("circle", { cx: 6, cy: 12, r: 2, fill: "var(--dsw-alias-bg-elevated,#fff)" }),
      );
    }

    // ---- 注册 ----
    return {
      inject: ["slots"],
      apply(ctx) {
        injectStyles();
        const registrations = [];
        const safeRegister = (slot, descriptor, component) => {
          try {
            registrations.push(ctx.slots.inject(slot, () => ctx.slots.register(descriptor, component)));
          } catch (e) {
            console.warn("[dsh-opencode-bridge] slot registration failed:", slot, e);
          }
        };
        safeRegister("sidebar.panellist", { name: "sidebar.panellist", id: PANEL_ID, order: 1, label: t("panel") }, PanelIcon);
        safeRegister("main", { name: "main", key: PANEL_ID }, ModelExposurePanel);
        return () => {
          for (const dispose of registrations) {
            try {
              const fn = typeof dispose === "function" ? dispose : dispose && dispose.dispose;
              if (typeof fn === "function") fn();
            } catch { /* 卸载尽力而为 */ }
          }
        };
      },
    };
  },
});
