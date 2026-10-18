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
        panel: "OC-bridge",
        title: "OC-bridge",
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
        countFiltered: "已选 {n} · 显示 {shown} / 共 {total}",
        dirty: "未保存更改 ×{n}",
        reloadConfirm: "有 {n} 项未保存更改，重新加载将丢弃这些更改。确定继续？",
        groupToggle: "整组切换",
        expand: "展开",
        collapse: "折叠",
        configError: "配置文件异常（已按默认过滤）：{msg}",
        serviceDown: "设置服务不可用：host 侧 connection 路由未注册",
      },
      en: {
        panel: "OC-bridge",
        title: "OC-bridge",
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
        countFiltered: "{n} selected · {shown} shown / {total} total",
        dirty: "×{n} unsaved",
        reloadConfirm: "You have {n} unsaved change(s); reload will discard them. Continue?",
        groupToggle: "Toggle group",
        expand: "Expand",
        collapse: "Collapse",
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
.obm-wrap { display:flex; justify-content:center; align-items:center; padding:20px 22px; height:100%; overflow:hidden; color:#fff; color-scheme:dark; font-family:inherit; background:radial-gradient(1100px 480px at 100% -10%, rgba(80,130,255,.10), transparent 60%), radial-gradient(900px 420px at -12% 112%, rgba(130,90,255,.08), transparent 55%); }
.obm-inner { display:flex; flex-direction:column; gap:14px; width:100%; max-width:880px; max-height:min(720px, 100%); min-height:0; }
.obm-head { display:flex; flex-direction:column; gap:6px; padding-bottom:12px; border-bottom:1px solid rgba(255,255,255,.08); }
.obm-title { font-size:17px; font-weight:650; letter-spacing:.01em; display:flex; align-items:center; gap:9px; }
.obm-title::before { content:""; width:9px; height:9px; border-radius:50%; background:linear-gradient(135deg,#4d8dff,#8b5cf6); box-shadow:0 0 12px rgba(90,140,255,.85); flex:none; }
.obm-sub { font-size:12px; color:rgba(255,255,255,.52); line-height:1.65; }
.obm-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.obm-search { flex:1; min-width:180px; padding:8px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.05); color:#fff; font-size:13px; outline:none; transition:border-color .15s, box-shadow .15s; }
.obm-search::placeholder { color:rgba(255,255,255,.34); }
.obm-search:focus { border-color:rgba(110,140,255,.75); box-shadow:0 0 0 3px rgba(110,140,255,.22); }
.obm-btn { padding:6px 14px; border-radius:9px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.06); color:#fff; cursor:pointer; font-size:12px; transition:background .15s, border-color .15s, transform .05s; }
.obm-btn:hover { background:rgba(255,255,255,.12); border-color:rgba(255,255,255,.24); }
.obm-btn:active { transform:translateY(1px); }
.obm-btn:disabled { opacity:.38; cursor:default; transform:none; }
.obm-btn-primary { background:linear-gradient(135deg,#3b82f6,#6366f1); border-color:transparent; font-weight:600; box-shadow:0 4px 16px rgba(80,120,255,.35); }
.obm-btn-primary:hover { background:linear-gradient(135deg,#528ef7,#7c7ff4); }
.obm-count { font-size:11px; color:rgba(255,255,255,.62); background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.09); padding:4px 11px; border-radius:999px; white-space:nowrap; }
.obm-list { flex:1; overflow:auto; border:1px solid rgba(255,255,255,.08); border-radius:12px; background:rgba(255,255,255,.028); }
.obm-list::-webkit-scrollbar { width:8px; }
.obm-list::-webkit-scrollbar-thumb { background:rgba(255,255,255,.16); border-radius:4px; }
.obm-list::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,.26); }
.obm-group-head { display:flex; align-items:center; gap:10px; padding:8px 14px; background:rgba(255,255,255,.055); backdrop-filter:blur(10px); position:sticky; top:0; z-index:1; cursor:default; border-bottom:1px solid rgba(255,255,255,.07); }
.obm-group-title { font-family:var(--dsw-font-mono,ui-monospace,monospace); font-size:11px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:rgba(255,255,255,.88); cursor:pointer; user-select:none; transition:color .12s; }
.obm-group-title:hover { color:#fff; }
.obm-group-count { font-size:11px; color:rgba(255,255,255,.55); background:rgba(255,255,255,.08); padding:2px 9px; border-radius:999px; }
.obm-chevron { margin-left:auto; border:none; background:none; color:rgba(255,255,255,.6); cursor:pointer; font-size:11px; padding:3px 8px; border-radius:6px; transition:background .12s, color .12s; }
.obm-chevron:hover { background:rgba(255,255,255,.1); color:#fff; }
.obm-row { display:flex; align-items:center; gap:12px; padding:9px 16px; border-bottom:1px solid rgba(255,255,255,.045); cursor:pointer; transition:background .12s; }
.obm-row:hover { background:rgba(255,255,255,.06); }
.obm-row input { width:15px; height:15px; accent-color:#6d7dff; cursor:pointer; flex:none; }
.obm-row-name { font-size:13px; color:#fff; font-weight:450; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.obm-row.off .obm-row-name { color:rgba(255,255,255,.52); font-weight:400; }
.obm-row-sub { font-family:var(--dsw-font-mono,ui-monospace,monospace); font-size:10px; color:rgba(255,255,255,.32); margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:52%; }
.obm-foot { display:flex; align-items:center; gap:12px; padding-top:2px; flex-wrap:wrap; }
.obm-status { font-size:12px; padding:4px 11px; border-radius:999px; max-width:100%; overflow-wrap:anywhere; }
.obm-status.dirty { color:#ffd88a; background:rgba(250,204,21,.12); border:1px solid rgba(250,204,21,.35); }
.obm-status.ok { color:#7ee2a8; background:rgba(52,199,123,.12); border:1px solid rgba(52,199,123,.3); }
.obm-status.err { color:#ff9d9d; background:rgba(255,90,90,.1); border:1px solid rgba(255,90,90,.32); }
.obm-warn { font-size:12px; padding:9px 12px; border-radius:10px; border:1px solid rgba(250,204,21,.35); background:rgba(250,204,21,.08); color:rgba(255,255,255,.85); line-height:1.5; }
.obm-empty { padding:30px 16px; text-align:center; color:rgba(255,255,255,.42); font-size:12px; border-bottom:none; cursor:default; }
.obm-empty:hover { background:none; }
/* ---- 宿主 UI 修补：/model、/permission 的 popupSelect 弹窗卡 ----
   宿主把它拉满 composer 浮层宽度（.EhuiKa_card { max-width:100%; left:0; right:0 }），
   大屏下横贯整页；这里限宽并居中。高度宿主已有 320px 锚定上限 + 内部滚动，刻意不去覆盖
   （其 maxHeight 是动态贴靠计算的，覆盖会破坏避让）。类名哈希取自
   dsh-client-ui-commands@0.2.0-rc.2（asar 实测）；DSH 升级更换哈希时本规则自动不命中，优雅降级。 */
[class~="EhuiKa_card"] { max-width:min(640px, calc(100vw - 32px)) !important; margin-inline:auto !important; }
`;
      document.head.appendChild(style);
    }

    // ---- 数据访问 ----
    async function loadState() {
      let res;
      try {
        res = await fetch(MODELS_URL, { method: "GET" });
      } catch (e) {
        throw new Error(t("serviceDown"));
      }
      if (res.status === 404) throw new Error(t("serviceDown"));
      let payload;
      try {
        payload = await res.json();
      } catch (e) {
        throw new Error(`${t("loadFailed")} (HTTP ${res.status})`);
      }
      if (!payload.ok) throw new Error(payload.error || t("loadFailed"));
      return payload.value;
    }
    async function saveSelection(selected) {
      let res;
      try {
        res = await fetch(FILTER_URL, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ selected }),
        });
      } catch (e) {
        throw new Error(t("serviceDown"));
      }
      if (res.status === 404) throw new Error(t("serviceDown"));
      let payload;
      try {
        payload = await res.json();
      } catch (e) {
        throw new Error(`${t("saveFailed")} (HTTP ${res.status})`);
      }
      if (!payload.ok) throw new Error(payload.error || t("saveFailed"));
      return payload.value;
    }

    // ---- 分组与行标签 ----
    /** 按 id 的第一个 `/` 前缀分组（opencode/*、opencode-go/*…），保持目录顺序。 */
    function groupByPrefix(models) {
      const order = [];
      const byKey = new Map();
      for (const m of models) {
        const slash = m.id.indexOf("/");
        const key = slash > 0 ? m.id.slice(0, slash) : "";
        if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
        byKey.get(key).push(m);
      }
      return order.map((key) => ({ key, label: key === "" ? "(no prefix)" : `${key}/*`, rows: byKey.get(key) }));
    }
    /** 目录里 name 通常就是 id：主标签用去前缀短名，完整 id 作次级弱化显示，避免一屏重复长串。 */
    function rowLabel(m) {
      const slash = m.id.indexOf("/");
      if (m.name && m.name !== m.id) return { primary: m.name, secondary: m.id };
      return { primary: slash > 0 ? m.id.slice(slash + 1) : m.id, secondary: m.id };
    }

    // ---- 面板组件 ----
    function ModelExposurePanel() {
      const [state, setState] = React.useState(null);
      const [checked, setChecked] = React.useState(() => new Set());
      const [query, setQuery] = React.useState("");
      const [expanded, setExpanded] = React.useState(() => new Set()); // 分组默认全部折叠，展开的组记在这里
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState(null); // {kind:"ok"|"err", text}
      const [saved, setSaved] = React.useState(() => new Set()); // 服务端可见集合基线（dirty 判定）
      const statusTimer = React.useRef(null);
      const clearStatus = React.useCallback(() => {
        if (statusTimer.current) { clearTimeout(statusTimer.current); statusTimer.current = null; }
        setStatus(null);
      }, []);
      const flash = React.useCallback((kind, text) => {
        if (statusTimer.current) { clearTimeout(statusTimer.current); statusTimer.current = null; }
        setStatus({ kind, text });
        if (kind === "ok") statusTimer.current = setTimeout(() => setStatus(null), 2500);
      }, []);
      React.useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);

      const load = React.useCallback(async () => {
        setBusy(true);
        clearStatus();
        try {
          const value = await loadState();
          const visible = new Set(value.models.filter((m) => m.visible).map((m) => m.id));
          setState(value);
          setChecked(new Set(visible));
          setSaved(new Set(visible));
        } catch (e) {
          flash("err", `${t("loadFailed")}: ${e && e.message ? e.message : e}`);
        } finally {
          setBusy(false);
        }
      }, [clearStatus, flash]);
      React.useEffect(() => { void load(); }, [load]);

      const models = state ? state.models : [];
      const q = query.trim().toLowerCase();
      const shown = q === "" ? models : models.filter((m) => (m.id + " " + (m.name || "")).toLowerCase().includes(q));
      const groups = groupByPrefix(shown);
      let dirtyCount = 0;
      for (const id of checked) if (!saved.has(id)) dirtyCount++;
      for (const id of saved) if (!checked.has(id)) dirtyCount++;
      const dirty = dirtyCount > 0;

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
      const toggleGroup = (rows, on) => setChecked((prev) => {
        const next = new Set(prev);
        for (const m of rows) { if (on) next.add(m.id); else next.delete(m.id); }
        return next;
      });
      const toggleCollapse = (key) => setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
      const save = async () => {
        setBusy(true);
        clearStatus();
        try {
          const value = await saveSelection([...checked]);
          const visible = new Set(value.models.filter((m) => m.visible).map((m) => m.id));
          setState(value);
          setChecked(new Set(visible));
          setSaved(new Set(visible));
          flash("ok", t("saved"));
        } catch (e) {
          flash("err", `${t("saveFailed")}: ${e && e.message ? e.message : e}`);
        } finally {
          setBusy(false);
        }
      };

      return h("div", { className: "obm-wrap" },
        h("div", { className: "obm-inner" },
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
          h("button", {
            className: "obm-btn", disabled: busy,
            onClick: () => {
              if (dirty && !window.confirm(t("reloadConfirm", { n: dirtyCount }))) return;
              void load();
            },
          }, t("reload")),
          h("span", { className: "obm-count" }, q === ""
            ? t("count", { n: checked.size, total: models.length })
            : t("countFiltered", { n: checked.size, shown: shown.length, total: models.length })),
        ),
        h("div", { className: "obm-list" },
          state === null
            ? h("div", { className: "obm-row obm-empty" }, busy ? t("loading") : "")
            : shown.length === 0
              ? h("div", { className: "obm-row obm-empty" }, t("empty"))
              : groups.map((g) => {
                  const total = g.rows.length;
                  const onCount = g.rows.filter((m) => checked.has(m.id)).length;
                  const allOn = total > 0 && onCount === total;
                  const isCollapsed = q === "" && !expanded.has(g.key);
                  return h("div", { key: g.key || "(no-prefix)", className: "obm-group" },
                    h("div", { className: "obm-group-head" },
                      h("input", {
                        type: "checkbox",
                        checked: allOn,
                        ref: (el) => { if (el) el.indeterminate = onCount > 0 && !allOn; },
                        onChange: () => toggleGroup(g.rows, !allOn),
                        title: t("groupToggle"),
                      }),
                      h("span", { className: "obm-group-title", onClick: () => toggleCollapse(g.key) }, g.label),
                      h("span", { className: "obm-group-count" }, t("count", { n: onCount, total })),
                      h("button", {
                        className: "obm-chevron",
                        onClick: () => toggleCollapse(g.key),
                        "aria-label": isCollapsed ? t("expand") : t("collapse"),
                      }, isCollapsed ? "▸" : "▾"),
                    ),
                    isCollapsed ? null : g.rows.map((m) => {
                      const label = rowLabel(m);
                      return h("label", { key: m.id, className: "obm-row" + (checked.has(m.id) ? "" : " off") },
                        h("input", {
                          type: "checkbox",
                          checked: checked.has(m.id),
                          onChange: () => toggle(m.id),
                        }),
                        h("span", { className: "obm-row-name" }, label.primary),
                        label.secondary ? h("span", { className: "obm-row-sub" }, label.secondary) : null,
                      );
                    }),
                  );
                }),
        ),
        h("div", { className: "obm-foot" },
          h("button", { className: "obm-btn obm-btn-primary", onClick: () => void save(), disabled: busy || state === null || !dirty }, busy ? t("saving") : t("save")),
          dirty ? h("span", { className: "obm-status dirty" }, t("dirty", { n: dirtyCount })) : null,
          status ? h("span", { className: "obm-status " + status.kind }, status.text) : null,
        ),
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
