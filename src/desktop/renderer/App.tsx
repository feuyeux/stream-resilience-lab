import { Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { orderTraceEvents, type TraceEvent } from "../../shared/trace.js";
import type { Protocol, RunOptions, ScenarioName } from "../../shared/types.js";
import type { DesktopApi, ServerStatus } from "../types.js";

declare global {
  interface Window {
    streamDebugger: DesktopApi;
  }
}

const protocols: Protocol[] = ["openai-chat", "openai-responses", "anthropic"];
const scenarios: ScenarioName[] = ["normal", "midstream-close", "half-tool-json", "silent-hang", "rate-limit-retry-after"];

export function App() {
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ state: "stopped", url: "http://127.0.0.1:3000/v1" });
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [selected, setSelected] = useState<TraceEvent | undefined>();
  const [protocol, setProtocol] = useState<Protocol>("openai-chat");
  const [scenario, setScenario] = useState<ScenarioName>("midstream-close");
  const [query, setQuery] = useState("hello");

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

  async function run() {
    setEvents([]);
    setSelected(undefined);
    const options: RunOptions = {
      protocol,
      query,
      mode: "stream",
      scenario,
      model: "mock-model",
      baseUrl: serverStatus.url,
      maxAttempts: 2,
      idleTimeoutMs: 1000,
      wallTimeoutMs: 5000
    };
    await window.streamDebugger.runDebugSession(options);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <span className={`status status-${serverStatus.state}`}>{serverStatus.state}</span>
        <button onClick={() => void window.streamDebugger.startServer()}>Start</button>
        <button onClick={() => void window.streamDebugger.stopServer()}>Stop</button>
        <button className="primary" onClick={() => void run()}><Play size={16} />Run</button>
        <button><Square size={16} />Stop Run</button>
      </header>

      <section className="workspace">
        <aside className="params">
          <label>Protocol<select value={protocol} onChange={(event) => setProtocol(event.target.value as Protocol)}>{protocols.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Scenario<select value={scenario} onChange={(event) => setScenario(event.target.value as ScenarioName)}>{scenarios.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Query<textarea value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </aside>

        <section className="timeline-container">
          <div className="timeline-headers">
            <div className="timeline-header-cell"><h2>Server</h2></div>
            <div className="timeline-header-cell"><h2>Client</h2></div>
          </div>
          <div className="timeline-grid">
            {timelineEvents.map((event) => {
              const isServer = event.side === "server";
              const isSelected = selected?.id === event.id;
              return (
                <div key={event.id} className="timeline-row">
                  <div className="timeline-cell server-cell">
                    {isServer && (
                      <button
                        className={`event-row ${isSelected ? "active" : ""}`}
                        onClick={() => setSelected(event)}
                      >
                        <span>{event.timestamp.slice(11, 23)}</span>
                        <strong>{event.type}</strong>
                        <small>{event.summary}</small>
                      </button>
                    )}
                  </div>
                  <div className="timeline-cell client-cell">
                    {!isServer && (
                      <button
                        className={`event-row ${isSelected ? "active" : ""}`}
                        onClick={() => setSelected(event)}
                      >
                        <span>{event.timestamp.slice(11, 23)}</span>
                        <strong>{event.type}</strong>
                        <small>{event.summary}</small>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <aside className="inspector">
          <h2>Inspector</h2>
          <pre>{selected ? JSON.stringify(selected, null, 2) : "Select an event"}</pre>
        </aside>
      </section>
    </main>
  );
}
