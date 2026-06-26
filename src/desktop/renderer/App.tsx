import {
  Play,
  Square,
  Activity,
  Settings,
  Terminal,
  Copy,
  Check,
  AlertTriangle,
  Search,
  Database,
  Sparkles,
  RefreshCw,
  Cpu,
  Clock,
  ArrowRightLeft,
  Trash2,
  Sliders,
  X,
  VolumeX,
  AlertCircle,
  HelpCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listScenarios } from "../../shared/scenarios.js";
import { orderTraceEvents, type TraceEvent } from "../../shared/trace.js";
import type { Protocol, RunOptions, ScenarioName, RunOutcome } from "../../shared/types.js";
import { desktopBuildVersion } from "../buildInfo.js";
import {
  categoryKeys,
  categoryTranslations,
  problemTranslations,
  promptTranslations,
  scenarioBehaviors,
  scenarioBehaviorsEn,
  scenarioBehaviorsFr,
  scenarioBehaviorsRu,
  scenarioCategoryMap,
  scenarioTranslations,
  statusTranslations,
  translations,
  type ScenarioBehavior
} from "./scenarioData.js";
import type { DesktopApi, ServerStatus } from "../types.js";

declare global {
  interface Window {
    streamDebugger: DesktopApi;
  }
}

const protocols: Protocol[] = ["openai-chat", "openai-responses", "anthropic"];
const scenarioCatalog = listScenarios();

const promptTemplates = [
  { label: "Simple Hello", text: "hello" },
  { label: "Write Code", text: "Write a short Python function to calculate fibonacci numbers." },
  { label: "Structured JSON", text: "Generate a valid JSON object list of 5 popular programming languages." },
  { label: "Slow Essay", text: "Explain the theory of relativity in simple terms, taking your time." }
];

export function App() {
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ state: "stopped", url: "http://127.0.0.1:3000/v1" });
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [selected, setSelected] = useState<TraceEvent | undefined>();
  const [protocol, setProtocol] = useState<Protocol>("openai-chat");
  const [scenario, setScenario] = useState<ScenarioName>("normal");
  const [query, setQuery] = useState("hello");

  // Advanced configurations
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState(1000);
  const [wallTimeoutMs, setWallTimeoutMs] = useState(5000);
  const [fallbackModel, setFallbackModel] = useState("mock-fallback-model");
  const [priority, setPriority] = useState<"foreground" | "background">("foreground");
  const [sessionId, setSessionId] = useState("");

  // UI state
  const [isRunning, setIsRunning] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<RunOutcome | undefined>();
  const [activeTab, setActiveTab] = useState<"config" | "library">("config");
  const [scenarioSearch, setScenarioSearch] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Resizable layout state
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(380);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);

  const startResizingLeft = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingLeft(true);
    const startX = e.clientX;
    const startWidth = leftWidth;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const doDrag = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = Math.max(200, Math.min(450, startWidth + deltaX));
      setLeftWidth(newWidth);
    };

    const stopDrag = () => {
      setIsResizingLeft(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", doDrag);
      document.removeEventListener("mouseup", stopDrag);
    };

    document.addEventListener("mousemove", doDrag);
    document.addEventListener("mouseup", stopDrag);
  };

  const startResizingRight = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingRight(true);
    const startX = e.clientX;
    const startWidth = rightWidth;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const doDrag = (moveEvent: MouseEvent) => {
      const deltaX = startX - moveEvent.clientX;
      const newWidth = Math.max(250, Math.min(550, startWidth + deltaX));
      setRightWidth(newWidth);
    };

    const stopDrag = () => {
      setIsResizingRight(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", doDrag);
      document.removeEventListener("mouseup", stopDrag);
    };

    document.addEventListener("mousemove", doDrag);
    document.addEventListener("mouseup", stopDrag);
  };

  // Localization detection: Default to Chinese for user, but default to English for Vitest test environment
  const isTestEnv = useMemo(() => {
    return typeof process !== "undefined" && (process.env.NODE_ENV === "test" || typeof (globalThis as any).vi !== "undefined");
  }, []);
  const [lang, setLang] = useState<"en" | "zh" | "fr" | "ru">(isTestEnv ? "en" : "zh");

  const t = useMemo(() => translations[lang], [lang]);

  function getScenarioName(name: ScenarioName): string {
    return scenarioTranslations[lang]?.[name]?.name ?? name;
  }

  function getScenarioDescription(name: ScenarioName): string {
    return scenarioTranslations[lang]?.[name]?.description ?? "";
  }

  function getProblemLabel(problem: string): string {
    return problemTranslations[lang]?.[problem] ?? problem;
  }

  function getStatusLabel(status: string): string {
    return statusTranslations[lang]?.[status] ?? status;
  }

  function getServerStatusLabel(state: string): string {
    switch (state) {
      case "stopped": return t.statusStopped;
      case "starting": return t.statusStarting;
      case "running": return t.statusRunning;
      case "external": return t.statusExternal;
      case "failed": return t.statusFailed;
      default: return state;
    }
  }

  function formatAttemptId(id: string | undefined): string {
    if (!id) return "";
    const num = id.replace("attempt_", "");
    if (lang === "zh") return `尝试 ${num}`;
    if (lang === "fr") return `Tentative ${num}`;
    if (lang === "ru") return `Попытка ${num}`;
    return `Attempt ${num}`;
  }

  useEffect(() => {
    void window.streamDebugger.getServerStatus().then(setServerStatus);
    const offTrace = window.streamDebugger.onTraceEvent((event) => setEvents((current) => [...current, event]));
    const offStatus = window.streamDebugger.onServerStatus(setServerStatus);
    return () => {
      offTrace();
      offStatus();
    };
  }, []);

  const orderedEvents = useMemo(() => orderTraceEvents(events), [events]);
  const timelineEvents = useMemo(() => {
    return orderedEvents.filter((event) => event.side === "server" || event.side === "client");
  }, [orderedEvents]);

  const activeScenarioDef = useMemo(() => {
    return scenarioCatalog.find(s => s.name === scenario);
  }, [scenario]);

  const filteredScenarios = useMemo(() => {
    if (!scenarioSearch) return scenarioCatalog;
    const q = scenarioSearch.toLowerCase();
    return scenarioCatalog.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.injectedProblem.toLowerCase().includes(q) ||
      s.expectedFinalProblem.toLowerCase().includes(q) ||
      s.expectedStatus.toLowerCase().includes(q)
    );
  }, [scenarioSearch]);

  const activeScenarioBehavior = useMemo(() => {
    if (lang === "zh") return scenarioBehaviors[scenario];
    if (lang === "fr") return scenarioBehaviorsFr[scenario];
    if (lang === "ru") return scenarioBehaviorsRu[scenario];
    return scenarioBehaviorsEn[scenario];
  }, [scenario, lang]);

  function scenarioDefaultOptions(selectedScenario: ScenarioName): Partial<RunOptions> {
    if (selectedScenario === "bounded-queue-overflow") {
      return { maxStreamEvents: 100, wallTimeoutMs: Math.max(wallTimeoutMs, 8000) };
    }
    if (selectedScenario === "flood") {
      return { wallTimeoutMs: Math.max(wallTimeoutMs, 8000) };
    }
    if (selectedScenario === "consumer-drop") {
      return { consumerDropAfterEvents: 3 };
    }
    if (selectedScenario === "fallback-recovery") {
      return { fallbackModel: fallbackModel || "mock-fallback-model" };
    }
    if (selectedScenario === "background-overloaded") {
      return { priority: "background" };
    }
    if (selectedScenario === "session-lock-conflict") {
      return { sessionId: sessionId || "desktop-session-lock" };
    }
    if (selectedScenario === "max-turns-exceeded") {
      return { currentTurn: 4, maxTurns: 3 };
    }
    return {};
  }

  async function run() {
    setEvents([]);
    setSelected(undefined);
    setLastOutcome(undefined);
    setIsRunning(true);
    const options: RunOptions = {
      protocol,
      query,
      mode: "stream",
      scenario,
      model: "mock-model",
      baseUrl: serverStatus.url,
      maxAttempts,
      idleTimeoutMs,
      wallTimeoutMs,
      fallbackModel: fallbackModel || undefined,
      priority,
      sessionId: sessionId || undefined,
      ...scenarioDefaultOptions(scenario)
    };
    try {
      const result = await window.streamDebugger.runDebugSession(options);
      setLastOutcome(result.outcome);
    } catch (err) {
      console.error("Debug run failed", err);
    } finally {
      setIsRunning(false);
    }
  }

  function getEventDetails(type: string) {
    let title = type;
    if (lang === "zh") {
      switch (type) {
        case "client.run_started": title = "运行启动"; break;
        case "client.attempt_started": title = "尝试启动"; break;
        case "client.attempt_succeeded": title = "尝试成功"; break;
        case "client.attempt_failed": title = "尝试失败"; break;
        case "client.retry_scheduled": title = "已调度重试"; break;
        case "client.timeout_triggered": title = "触发超时"; break;
        case "client.run_finished": title = "运行结束"; break;
        case "client.stream_event_received": title = "收到分块"; break;
        case "server.request_received": title = "收到请求"; break;
        case "server.scenario_selected": title = "配置场景"; break;
        case "server.stream_opened": title = "流连接开启"; break;
        case "server.sse_event_sent": title = "发送 SSE 标记"; break;
        case "server.json_response_sent": title = "发送 JSON 响应"; break;
        case "server.response_completed": title = "响应已完成"; break;
        case "server.stream_hung": title = "流连接挂起"; break;
        case "server.malformed_frame_sent": title = "畸形 SSE 包"; break;
        case "server.socket_destroyed": title = "套接字断开"; break;
      }
    } else if (lang === "fr") {
      switch (type) {
        case "client.run_started": title = "Lancement Exécution"; break;
        case "client.attempt_started": title = "Tentative Lancée"; break;
        case "client.attempt_succeeded": title = "Tentative Réussie"; break;
        case "client.attempt_failed": title = "Tentative Échouée"; break;
        case "client.retry_scheduled": title = "Réessayage Planifié"; break;
        case "client.timeout_triggered": title = "Délai Dépassé"; break;
        case "client.run_finished": title = "Exécution Terminée"; break;
        case "client.stream_event_received": title = "Fragment Reçu"; break;
        case "server.request_received": title = "Requête Reçue"; break;
        case "server.scenario_selected": title = "Scénario Configuré"; break;
        case "server.stream_opened": title = "Flux Ouvert"; break;
        case "server.sse_event_sent": title = "Jeton SSE Envoyé"; break;
        case "server.json_response_sent": title = "Réponse JSON Envoyée"; break;
        case "server.response_completed": title = "Réponse Terminée"; break;
        case "server.stream_hung": title = "Flux Suspendu"; break;
        case "server.malformed_frame_sent": title = "Trame SSE Invalide"; break;
        case "server.socket_destroyed": title = "Socket Déconnecté"; break;
      }
    } else if (lang === "ru") {
      switch (type) {
        case "client.run_started": title = "Запуск Симуляции"; break;
        case "client.attempt_started": title = "Попытка Начета"; break;
        case "client.attempt_succeeded": title = "Попытка Успешна"; break;
        case "client.attempt_failed": title = "Попытка Сбой"; break;
        case "client.retry_scheduled": title = "Повтор Запланирован"; break;
        case "client.timeout_triggered": title = "Таймаут Сработал"; break;
        case "client.run_finished": title = "Завершено"; break;
        case "client.stream_event_received": title = "Пакет Принят"; break;
        case "server.request_received": title = "Запрос Получен"; break;
        case "server.scenario_selected": title = "Сценарий Выбран"; break;
        case "server.stream_opened": title = "Поток Открыт"; break;
        case "server.sse_event_sent": title = "Токен SSE Отправлен"; break;
        case "server.json_response_sent": title = "JSON Ответ Отправлен"; break;
        case "server.response_completed": title = "Ответ Завершен"; break;
        case "server.stream_hung": title = "Поток Завис"; break;
        case "server.malformed_frame_sent": title = "Искаженный Пакет"; break;
        case "server.socket_destroyed": title = "Сокет Закрыт"; break;
      }
    } else {
      switch (type) {
        case "client.run_started": title = "Run Started"; break;
        case "client.attempt_started": title = "Attempt Started"; break;
        case "client.attempt_succeeded": title = "Attempt Succeeded"; break;
        case "client.attempt_failed": title = "Attempt Failed"; break;
        case "client.retry_scheduled": title = "Retry Scheduled"; break;
        case "client.timeout_triggered": title = "Timeout Triggered"; break;
        case "client.run_finished": title = "Run Finished"; break;
        case "client.stream_event_received": title = "Chunk Received"; break;
        case "server.request_received": title = "Request Received"; break;
        case "server.scenario_selected": title = "Scenario Configured"; break;
        case "server.stream_opened": title = "Stream Connection Opened"; break;
        case "server.sse_event_sent": title = "SSE Token Sent"; break;
        case "server.json_response_sent": title = "JSON Response Sent"; break;
        case "server.response_completed": title = "Response Completed"; break;
        case "server.stream_hung": title = "Stream Connection Hung"; break;
        case "server.malformed_frame_sent": title = "Malformed SSE Packet"; break;
        case "server.socket_destroyed": title = "Socket Disconnected"; break;
      }
    }

    let icon = <HelpCircle size={13} />;
    switch (type) {
      case "client.run_started":
      case "client.run_finished":
        icon = <Sparkles size={13} />; break;
      case "client.attempt_started":
      case "server.request_received":
        icon = <ArrowRightLeft size={13} />; break;
      case "client.attempt_succeeded":
      case "server.response_completed":
        icon = <Check size={13} />; break;
      case "client.attempt_failed":
      case "client.timeout_triggered":
      case "server.malformed_frame_sent":
      case "server.socket_destroyed":
        icon = type.includes("failed") || type.includes("timeout") || type.includes("destroyed")
          ? <AlertCircle size={13} />
          : <AlertTriangle size={13} />;
        break;
      case "client.retry_scheduled":
        icon = <RefreshCw size={13} />; break;
      case "server.stream_opened":
        icon = <Play size={13} />; break;
      case "client.stream_event_received":
        icon = <Terminal size={13} />; break;
      case "server.scenario_selected":
        icon = <Settings size={13} />; break;
      case "server.sse_event_sent":
      case "server.json_response_sent":
        icon = <Cpu size={13} />; break;
      case "server.stream_hung":
        icon = <Clock size={13} />; break;
    }

    return { icon, title };
  }

  function renderJson(data: any): React.ReactNode {
    if (data === undefined || data === null) {
      return <span className="json-null">null</span>;
    }
    if (typeof data === "number") {
      return <span className="json-number">{data}</span>;
    }
    if (typeof data === "boolean") {
      return <span className="json-boolean">{data ? "true" : "false"}</span>;
    }
    if (typeof data === "string") {
      return <span className="json-string">"{data}"</span>;
    }
    if (Array.isArray(data)) {
      if (data.length === 0) return <span>[]</span>;
      return (
        <span className="json-array">
          [
          <span className="json-indent">
            {data.map((val, idx) => (
              <span key={idx} className="json-item">
                {renderJson(val)}
                {idx < data.length - 1 && ","}
              </span>
            ))}
          </span>
          ]
        </span>
      );
    }
    if (typeof data === "object") {
      const keys = Object.keys(data);
      if (keys.length === 0) return <span>{"{}"}</span>;
      return (
        <span className="json-object">
          {"{"}
          <span className="json-indent">
            {keys.map((key, idx) => (
              <span key={key} className="json-prop">
                <span className="json-key">"{key}"</span>: {renderJson(data[key])}
                {idx < keys.length - 1 && ","}
              </span>
            ))}
          </span>
          {"}"}
        </span>
      );
    }
    return <span>{String(data)}</span>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <Activity size={18} className="topbar-logo" />
          <h1>{t.title}</h1>
          <span>{desktopBuildVersion}</span>
        </div>

        <div className="topbar-controls">
          <div className="server-status-group">
            <span className="server-label">{t.provider}:</span>
            <div className="status-badge">
              <span className={`status-dot ${serverStatus.state}`}></span>
              <span className="status-text">{getServerStatusLabel(serverStatus.state)}</span>
            </div>
            <span className="server-url">({serverStatus.url})</span>
          </div>

          <button onClick={() => void window.streamDebugger.startServer()}>{t.start}</button>
          <button onClick={() => void window.streamDebugger.stopServer()}>{t.stop}</button>

          {/* Explicit Language Dropdown Selector */}
          <div className="server-status-group" style={{ padding: "1px 6px" }}>
            <span className="server-label" style={{ fontSize: "9px" }}>LANG:</span>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as "en" | "zh" | "fr" | "ru")}
              style={{
                background: "transparent",
                border: "0",
                fontSize: "11px",
                fontWeight: "bold",
                padding: "0 4px 0 0",
                cursor: "pointer",
                width: "auto"
              }}
            >
              <option value="zh">简体中文</option>
              <option value="en">English</option>
              <option value="fr">Français</option>
              <option value="ru">Русский</option>
            </select>
          </div>

          <button
            className="primary"
            onClick={() => void run()}
            disabled={isRunning || serverStatus.state === "stopped"}
          >
            <Play size={14} />
            {isRunning ? t.running : t.run}
          </button>
          <button disabled={!isRunning} className="stop-btn">
            <Square size={14} />
            {t.stopRun}
          </button>
        </div>
      </header>

      <section
        className="workspace"
        style={{ gridTemplateColumns: `${leftWidth}px 4px 1fr 4px ${rightWidth}px` }}
      >
        <aside className="params-panel">
          <div className="panel-tabs">
            <button
              className={`panel-tab-btn ${activeTab === "config" ? "active" : ""}`}
              onClick={() => setActiveTab("config")}
            >
              {t.configuration}
            </button>
            <button
              className={`panel-tab-btn ${activeTab === "library" ? "active" : ""}`}
              onClick={() => setActiveTab("library")}
            >
              {t.scenarioLibrary}
            </button>
          </div>

          <div className="panel-content">
            {activeTab === "config" ? (
              <div className="params-form">
                <h3 className="form-section-title">
                  <Sliders size={12} />
                  {t.parameters}
                </h3>

                <label>
                  {t.protocol}
                  <div className="segmented-control">
                    {protocols.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={`segment-btn ${protocol === item ? "active" : ""}`}
                        onClick={() => setProtocol(item)}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </label>

                <label>
                  {t.scenario}
                  <select
                    value={scenario}
                    onChange={(event) => setScenario(event.target.value as ScenarioName)}
                  >
                    {categoryKeys.map((catKey) => {
                      const scenariosInCat = scenarioCatalog.filter(
                        (item) => scenarioCategoryMap[item.name] === catKey
                      );
                      if (scenariosInCat.length === 0) return null;
                      return (
                        <optgroup key={catKey} label={categoryTranslations[lang][catKey]}>
                          {scenariosInCat.map((item) => (
                            <option key={item.name} value={item.name}>
                              {getScenarioName(item.name)}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </label>

                {activeScenarioDef && (
                  <div className="scenario-meta-card">
                    <div className="scenario-meta-header">
                      <span className="scenario-meta-title">{getScenarioName(activeScenarioDef.name)}</span>
                      {activeScenarioDef.streamOnly && <span className="badge badge-stream-only">{t.streamBadge}</span>}
                    </div>
                    <p className="scenario-meta-desc">{getScenarioDescription(activeScenarioDef.name)}</p>
                    <div className="scenario-meta-footer">
                      <span className={`badge badge-problem problem-${activeScenarioDef.expectedFinalProblem}`}>
                        {t.expectedLabel} {getProblemLabel(activeScenarioDef.expectedFinalProblem)} · {activeScenarioDef.expectedStatus}
                      </span>
                    </div>
                  </div>
                )}

                <div className="quick-prompts">
                  <span className="quick-prompt-label">{t.quickPrompts}</span>
                  <div className="quick-prompt-btns">
                    {promptTranslations[lang].map((tpl, i) => (
                      <button
                        key={i}
                        type="button"
                        className="quick-prompt-btn"
                        onClick={() => setQuery(tpl.text)}
                      >
                        {tpl.label}
                      </button>
                    ))}
                  </div>
                </div>

                <label>
                  {t.queryPrompt}
                  <textarea value={query} onChange={(event) => setQuery(event.target.value)} />
                </label>

                <div>
                  <button
                    type="button"
                    className="collapsible-trigger"
                    onClick={() => setAdvancedOpen(!advancedOpen)}
                  >
                    <span>{t.advancedSettings}</span>
                    <span>{advancedOpen ? "▼" : "▶"}</span>
                  </button>

                  {advancedOpen && (
                    <div className="collapsible-content">
                      <div className="advanced-row">
                        <label>
                          {t.maxAttempts}
                          <select value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))}>
                            {[1, 2, 3, 4, 5].map(v => <option key={v} value={v}>{v}</option>)}
                          </select>
                        </label>
                        <label>
                          {t.priority}
                          <select value={priority} onChange={(e) => setPriority(e.target.value as "foreground" | "background")}>
                            <option value="foreground">{t.foreground}</option>
                            <option value="background">{t.background}</option>
                          </select>
                        </label>
                      </div>

                      <div className="advanced-row">
                        <label>
                          {t.idleTimeout}
                          <input type="number" value={idleTimeoutMs} onChange={(e) => setIdleTimeoutMs(Number(e.target.value))} />
                        </label>
                        <label>
                          {t.wallTimeout}
                          <input type="number" value={wallTimeoutMs} onChange={(e) => setWallTimeoutMs(Number(e.target.value))} />
                        </label>
                      </div>

                      <label>
                        {t.fallbackModel}
                        <input type="text" value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)} placeholder={t.fallbackModelPlaceholder} />
                      </label>

                      <label>
                        {t.sessionId}
                        <input type="text" value={sessionId} onChange={(e) => setSessionId(e.target.value)} placeholder={t.sessionIdPlaceholder} />
                      </label>
                    </div>
                  )}
                </div>

                {/* Scenario behavior descriptions */}
                {activeScenarioDef && activeScenarioBehavior && (
                  <div className="inspector-section" style={{ marginTop: "12px", marginBottom: "0" }}>
                    <div className="inspector-section-header" style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <HelpCircle size={10} />
                      {t.expectedBehavior}
                    </div>
                    <div className="inspector-section-body" style={{ padding: "8px 10px", fontSize: "11px", display: "flex", flexDirection: "column", gap: "6px" }}>
                      <div>
                        <strong style={{ color: "var(--accent-blue)" }}>{t.expectedServer}：</strong>
                        <span style={{ color: "var(--text-secondary)" }}>
                          {activeScenarioBehavior.server}
                        </span>
                      </div>
                      <div style={{ borderTop: "1px dashed var(--border-color)", paddingTop: "6px" }}>
                        <strong style={{ color: "var(--accent-purple)" }}>{t.expectedClient}：</strong>
                        <span style={{ color: "var(--text-secondary)" }}>
                          {activeScenarioBehavior.client}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="scenario-search-container">
                  <div className="search-input-wrapper">
                    <Search size={14} className="search-icon" />
                    <input
                      type="text"
                      className="search-input"
                      placeholder={t.searchPlaceholder}
                      value={scenarioSearch}
                      onChange={(e) => setScenarioSearch(e.target.value)}
                    />
                  </div>
                </div>

                <div className="scenario-list">
                  {categoryKeys.map((catKey) => {
                    const scenariosInCat = filteredScenarios.filter(
                      (item) => scenarioCategoryMap[item.name] === catKey
                    );
                    if (scenariosInCat.length === 0) return null;
                    return (
                      <div key={catKey} className="scenario-category-list">
                        <div className="scenario-category-header">
                          {categoryTranslations[lang][catKey]}
                        </div>
                        {scenariosInCat.map((item) => (
                          <button
                            key={item.name}
                            className={`scenario-card-btn ${scenario === item.name ? "active" : ""}`}
                            onClick={() => setScenario(item.name)}
                          >
                            <div className="scenario-card-header">
                              <span className="scenario-card-name">{getScenarioName(item.name)}</span>
                              {item.streamOnly && <span className="badge badge-stream-only">{t.streamBadge}</span>}
                            </div>
                            <div className="scenario-card-desc">{getScenarioDescription(item.name)}</div>
                            <div className="scenario-meta-footer">
                              <span className={`badge badge-problem problem-${item.expectedFinalProblem}`}>
                                {getProblemLabel(item.expectedFinalProblem)} · {item.expectedStatus}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                  {filteredScenarios.length === 0 && (
                    <div className="no-event-state">{t.noScenarios}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>

        <div className={`resizer ${isResizingLeft ? "active" : ""}`} onMouseDown={startResizingLeft} />

        <section className="timeline-panel">
          <div className="timeline-panel-header">
            <div className="timeline-panel-title-group">
              <h2>
                <Activity size={14} style={{ color: "var(--accent-blue)" }} />
                {t.consoleTitle}
              </h2>
              <p>{t.subtitle}</p>
            </div>
            <button className="clear-btn" onClick={() => { setEvents([]); setSelected(undefined); setLastOutcome(undefined); }}>
              <Trash2 size={12} />
              {t.clearConsole}
            </button>
          </div>

          {lastOutcome && (
            <div className={`outcome-dashboard status-${lastOutcome.result.status}`}>
              <div className="outcome-header">
                <div className="outcome-title-group">
                  <span className="outcome-subtitle">{t.outcomeReport}</span>
                  <div className="outcome-badge-container">
                    <span className="outcome-status-title">{getStatusLabel(lastOutcome.result.status)}</span>
                    <span className={`outcome-badge ${lastOutcome.result.safe_to_retry_automatically ? "success" : "failure"}`}>
                      {lastOutcome.result.safe_to_retry_automatically ? t.safeToRetry : t.unsafeToRetry}
                    </span>
                  </div>
                </div>
                <button className="outcome-close-btn" onClick={() => setLastOutcome(undefined)}>
                  <X size={14} />
                </button>
              </div>

              <div className="outcome-metrics">
                <div className="metric-card">
                  <span className="metric-label">{t.duration}</span>
                  <span className="metric-value">{lastOutcome.timing.duration_ms} ms</span>
                </div>
                <div className="metric-card">
                  <span className="metric-label">{t.attempts}</span>
                  <span className="metric-value">{lastOutcome.mitigation.retry_attempts}</span>
                </div>
                <div className="metric-card">
                  <span className="metric-label">{t.problem}</span>
                  <span className="metric-value">{getProblemLabel(lastOutcome.problem.kind)}</span>
                </div>
                <div className="metric-card">
                  <span className="metric-label">{t.tokensChars}</span>
                  <span className="metric-value">{lastOutcome.problem.received_chars}</span>
                </div>
              </div>

              {lastOutcome.mitigation.actions.length > 0 && (
                <div className="outcome-mitigations">
                  <span className="mitigation-label">{t.mitigations}:</span>
                  {lastOutcome.mitigation.actions.map((act, i) => (
                    <span key={i} className="mitigation-action-tag">{act}</span>
                  ))}
                </div>
              )}

              {lastOutcome.output_text && (
                <div className="outcome-text-panel">
                  <div className="outcome-text-header">
                    <span>{t.reconstructedContent}</span>
                    <button
                      className="clear-btn"
                      style={{ padding: "2px 6px", fontSize: "9px" }}
                      onClick={() => {
                        void navigator.clipboard.writeText(lastOutcome.output_text || "");
                      }}
                    >
                      <Copy size={10} /> {t.copy}
                    </button>
                  </div>
                  <div className="outcome-text-body">
                    {lastOutcome.output_text}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="timeline-content-area">
            <div className="timeline-headers">
              <div className="timeline-header-cell"><h2>{t.serverHeader}</h2></div>
              <div className="timeline-header-cell"><h2>{t.clientHeader}</h2></div>
            </div>

            {timelineEvents.length === 0 ? (
              <div className="empty-state">
                <Terminal size={36} className="empty-state-icon" />
                <h3>{t.noTraces}</h3>
                <p>{t.noTracesDesc}</p>
              </div>
            ) : (
              <div className="timeline-grid">
                {timelineEvents.map((event) => {
                  const isServer = event.side === "server";
                  const isSelected = selected?.id === event.id;
                  const details = getEventDetails(event.type);
                  return (
                    <div key={event.id} className={`timeline-row side-${event.side} type-${event.type.replace(/\./g, "-")}`}>
                      <div className="timeline-node"></div>

                      <div className="timeline-cell server-cell">
                        {isServer && (
                          <button
                            className={`event-card ${isSelected ? "active" : ""}`}
                            onClick={() => setSelected(event)}
                          >
                            <div className="event-card-header">
                              <span className="event-type-badge">
                                <span className="event-type-icon">{details.icon}</span>
                                {details.title}
                              </span>
                              <span className="event-timestamp">{event.timestamp.slice(11, 23)}</span>
                            </div>
                            <div className="event-summary">{event.summary}</div>
                            <div className="event-meta-line">
                              <span>{t.seq}: {event.sequence}</span>
                              {event.attemptId && <span>{formatAttemptId(event.attemptId)}</span>}
                            </div>
                          </button>
                        )}
                      </div>

                      <div className="timeline-cell client-cell">
                        {!isServer && (
                          <button
                            className={`event-card ${isSelected ? "active" : ""}`}
                            onClick={() => setSelected(event)}
                          >
                            <div className="event-card-header">
                              <span className="event-type-badge">
                                <span className="event-type-icon">{details.icon}</span>
                                {details.title}
                              </span>
                              <span className="event-timestamp">{event.timestamp.slice(11, 23)}</span>
                            </div>
                            <div className="event-summary">{event.summary}</div>
                            <div className="event-meta-line">
                              <span>{t.seq}: {event.sequence}</span>
                              {event.attemptId && <span>{formatAttemptId(event.attemptId)}</span>}
                            </div>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <div className={`resizer ${isResizingRight ? "active" : ""}`} onMouseDown={startResizingRight} />

        <aside className="inspector-panel">
          <div className="inspector-header">
            <h2>{t.inspector}</h2>
            {selected && (
              <div className="inspector-actions">
                <button onClick={() => {
                  void navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
                  setIsCopied(true);
                  setTimeout(() => setIsCopied(false), 2000);
                }}>
                  {isCopied ? <Check size={11} /> : <Copy size={11} />}
                  {isCopied ? t.copied : t.copy + " JSON"}
                </button>
              </div>
            )}
          </div>

          <div className="inspector-content">
            {selected ? (
              <div>
                <div className="inspector-section">
                  <div className="inspector-section-header">{t.metadata}</div>
                  <div className="inspector-section-body">
                    <div className="inspector-grid">
                      <span className="inspector-grid-label">{t.timestamp}</span>
                      <span className="inspector-grid-value">{selected.timestamp}</span>

                      <span className="inspector-grid-label">{t.sequence}</span>
                      <span className="inspector-grid-value">{selected.sequence}</span>

                      <span className="inspector-grid-label">{t.origin}</span>
                      <span
                        className="inspector-grid-value"
                        style={{ color: selected.side === "server" ? "var(--accent-blue)" : "var(--accent-purple)", fontWeight: 600 }}
                      >
                        {selected.side === "server" ? t.server : t.client}
                      </span>

                      <span className="inspector-grid-label">{t.eventType}</span>
                      <span className="inspector-grid-value" style={{ fontWeight: 700 }}>
                        {selected.type}
                      </span>

                      {selected.attemptId && (
                        <>
                          <span className="inspector-grid-label">{t.attemptId}</span>
                          <span className="inspector-grid-value">{formatAttemptId(selected.attemptId)}</span>
                        </>
                      )}

                      {selected.requestId && (
                        <>
                          <span className="inspector-grid-label">{t.requestId}</span>
                          <span className="inspector-grid-value">{selected.requestId}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="inspector-section">
                  <div className="inspector-section-header">{t.summary}</div>
                  <div className="inspector-section-body">
                    <div style={{ fontSize: "12px", lineHeight: "1.4" }}>
                      {selected.summary}
                    </div>
                  </div>
                </div>

                <div className="inspector-section">
                  <div className="inspector-section-header">{t.payloadData}</div>
                  <div className="inspector-section-body" style={{ overflow: "hidden" }}>
                    {selected.data ? (
                      <div className="json-viewer-container">
                        {renderJson(selected.data)}
                      </div>
                    ) : (
                      <div className="no-event-state">{t.noPayload}</div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="no-event-state">
                <Database size={24} style={{ opacity: 0.1, marginBottom: "8px" }} />
                {t.noEventSelected}
              </div>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
