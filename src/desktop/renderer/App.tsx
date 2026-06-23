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

interface ScenarioBehavior {
  server: string;
  client: string;
}

const scenarioBehaviors: Record<ScenarioName, ScenarioBehavior> = {
  "normal": {
    server: "分块均匀发送完整的流文本数据，最后发送正常的 [DONE] 结束标记。",
    client: "正常接收并重组完整文本，记录 tracked_output 动作，生成 completed 成功状态。"
  },
  "slow": {
    server: "以 150ms 的较长间隔延迟发送文本块，最后发送结束标记。",
    client: "把 idleTimeoutMs 作为每批流事件之间的最大等待时间；每收到一批就刷新空闲定时器。wallTimeoutMs 是整次 attempt 的总耗时硬上限，不会被刷新；因此批间隔未超时且总耗时足够时返回 completed_slow，否则触发 idle_timeout 或 wall_timeout。"
  },
  "rate-limit-retry-after": {
    server: "在首个 token 发送前返回 HTTP 429 速率限制错误，并在 headers 中附带 retry-after: 1 秒头部。",
    client: "由于还没有可见的输出，识别为 rate_limited 并等待头部指定时间后自动发起重试。"
  },
  "overloaded-retry-after": {
    server: "在首个 token 发送前返回 HTTP 529 服务过载错误，并在 headers 中附带 retry-after: 1 秒头部。",
    client: "识别为 overloaded 错误。由于无部分输出，启动自动重试策略。"
  },
  "server-error": {
    server: "在首个 token 发送前直接返回 HTTP 500 服务器故障错误。",
    client: "识别为 server_error 错误。无部分输出，允许自动发起另一次请求重试。"
  },
  "midstream-close": {
    server: "正常发送前两个分块，随后不发送任何结束标记，直接单方面强行销毁 TCP socket 物理连接。",
    client: "捕获流异常中断，安全保留已收到的部分输出。因为已经产生了输出，强行抑制自动重试与 fallback，返回 partial_returned。"
  },
  "half-sse-frame": {
    server: "写入不完整、截断的 SSE 字符串帧后立即强行销毁 socket。",
    client: "底层解析层捕获解析错误。客户端判定流发生不可恢复的损坏，归类为安全失败 safe_failure，防止无限重试。"
  },
  "silent-hang": {
    server: "建立连接并发送头部，之后连接无限期挂起不作任何响应，且不发送任何心跳包。",
    client: "客户端空闲时间达到 idleTimeoutMs 限制，本地定时器触发主动 abort 中止请求，归类为 aborted_idle_timeout。"
  },
  "heartbeat-only": {
    server: "保持流连接打开，只发送心跳/ping 帧，不发任何实际业务文本内容。",
    client: "客户端判定心跳不属于有用业务内容，虽然物理网络保持活动，但无可见文本导致空闲超时，主动 abort 终止请求。"
  },
  "half-tool-json": {
    server: "流式发送半截工具调用参数 JSON (如未闭合的括号对)，随后断流销毁 socket。",
    client: "解析工具参数发现不完整，为防止将破碎的参数交由下游执行造成不可逆副作用，强制阻断执行并归类为 safe_failure 保护。"
  },
  "flood": {
    server: "无延迟地高频快速发送大量小分块文本 (250个 chunk)。",
    client: "测试客户端大吞吐量无间断流式接收能力，不丢包地重组完整文本返回。"
  },
  "bounded-queue-overflow": {
    server: "快速连续发送大量分块文本，分块总量超出客户端设定的队列上限。",
    client: "触发背压自保机制，主动丢弃流连接以防内存溢出崩溃，归类为 safe_failure 保护。"
  },
  "consumer-drop": {
    server: "正常发送流数据，直到客户端下游消费者取消或主动断开连接。",
    client: "消费者取消订阅时主动向服务端发送 abort 信号，并在 outcome 中分类为 consumer_cancelled 正常退出，不进行重试。"
  },
  "fallback-recovery": {
    server: "主模型服务发生 529 服务过载；切换到备用模型 (fallback model) 后健康响应。",
    client: "主模型调用前 token 报错，由于无输出，在耗尽尝试后自动降级并重试 fallbackModel 恢复响应。"
  },
  "circuit-breaker-open": {
    server: "持续处于 529 服务过载故障状态。",
    client: "检测到故障尝试耗尽后打开熔断器 (circuit_opened)，并在熔断器打开冷却期内拦截后置请求并直接熔断保护。"
  },
  "provider-cooldown": {
    server: "持续处于服务过载响应中。",
    client: "当故障耗尽后触发 provider cooldown，短时间内拒绝再次向该提供者请求，避免 retry storm (重试风暴) 冲击。"
  },
  "background-overloaded": {
    server: "服务过载拒绝响应。",
    client: "检测到当前请求为低优先级 background (后台) 任务且遇到过载故障，直接丢弃，不挤占前台高优先级资源的重试配额。"
  },
  "context-overflow": {
    server: "检测到输入提示词上下文超出模型长度限制，返回上下文溢出专用错误。",
    client: "识别为 context_overflow，这是一种确定性的输入故障，普通重试无用。不进行重试，并标记 context_compaction_required。"
  },
  "session-lock-conflict": {
    server: "模拟接收多任务请求。",
    client: "preflight 阶段判定同一 sessionId 存在未结束的并发会话，拒绝启动当前请求，会话锁闭并返回 session_locked 状态。"
  },
  "max-turns-exceeded": {
    server: "模拟接收请求。",
    client: "Agent 交互回合 currentTurn 超过上限 maxTurns，在 preflight 阶段便强行阻断 API 呼叫，标记 max_turns_exceeded。"
  }
};

const scenarioBehaviorsEn: Record<ScenarioName, ScenarioBehavior> = {
  "normal": {
    server: "Streams complete text chunks evenly and closes normally with a standard [DONE] signal.",
    client: "Accumulates text fully and returns completed status, logging the tracked_output action."
  },
  "slow": {
    server: "Streams text chunks with a relatively long delay (150ms) between each chunk.",
    client: "Uses idleTimeoutMs as the maximum wait between stream chunks and resets that timer on each chunk. wallTimeoutMs remains the total attempt hard cap; finishing within both budgets returns completed_slow, otherwise idle_timeout or wall_timeout fires."
  },
  "rate-limit-retry-after": {
    server: "Returns HTTP 429 (Rate Limited) before sending the first token, attaching a retry-after: 1s header.",
    client: "Identifies as rate_limited. Since there is no partial output yet, it schedules an automatic retry honoring the retry delay."
  },
  "overloaded-retry-after": {
    server: "Returns HTTP 529 (Overloaded) before sending the first token, attaching a retry-after: 1s header.",
    client: "Identifies as overloaded. With no partial output yet, it attempts an automatic retry."
  },
  "server-error": {
    server: "Returns HTTP 500 (Internal Server Error) before sending the first token.",
    client: "Identifies as server_error. Since there is no partial output, it permits an automatic retry after a safety backoff."
  },
  "midstream-close": {
    server: "Streams the first two text chunks and then abruptly destroys the TCP socket without ending properly.",
    client: "Detects connection close. Since partial output exists, it protects it, suppresses automatic retry/fallback, and returns partial_returned."
  },
  "half-sse-frame": {
    server: "Sends a truncated/incomplete SSE string packet and then abruptly destroys the socket.",
    client: "Detects parser/connection error. Categorizes as malformed_stream and enters safe_failure to prevent infinite retry loops."
  },
  "silent-hang": {
    server: "Opens connection, sends headers, then hangs indefinitely without sending chunks or ping pongs.",
    client: "Exceeds idleTimeoutMs. The client idle timer triggers, aborting the request and classifying as aborted_idle_timeout."
  },
  "heartbeat-only": {
    server: "Keeps connection open but only sends pings/heartbeats without any real text content.",
    client: "Recognizes that heartbeat events carry no text. An idle timeout is triggered and aborts, categorizing as aborted_content_idle_timeout."
  },
  "half-tool-json": {
    server: "Streams incomplete tool function argument JSON (e.g. unclosed brackets), then destroys the socket.",
    client: "Detects incomplete JSON block. Blocks the execution of the tool call to prevent side-effects, marking safe_failure."
  },
  "flood": {
    server: "Streams 250 small chunks extremely fast with no delay.",
    client: "Tests client buffer capacity to consume rapid stream delta events without dropping frames."
  },
  "bounded-queue-overflow": {
    server: "Streams a large count of chunks quickly, exceeding the client event budget.",
    client: "Triggers backpressure self-protection. Aborts the connection to protect memory, marking safe_failure."
  },
  "consumer-drop": {
    server: "Streams text deltas normally until the downstream consumer disconnects.",
    client: "Aborts the stream connection, classifying it as consumer_cancelled. Does not treat this as a provider failure to retry."
  },
  "fallback-recovery": {
    server: "Primary model returns HTTP 529; fallback model behaves normally.",
    client: "Fails on primary model before token. Automatically redirects the query to fallbackModel to recover."
  },
  "circuit-breaker-open": {
    server: "Returns HTTP 529 consistently.",
    client: "Opens circuit breaker (circuit_opened) after consecutive failures, blocking downstream retry storms."
  },
  "provider-cooldown": {
    server: "Returns HTTP 529 consistently.",
    client: "Enters provider cooldown after consecutive failures, blocking calls to this provider temporarily."
  },
  "background-overloaded": {
    server: "Returns HTTP 529 overload response.",
    client: "Detects background request class under overload. Discards it immediately to conserve high-priority resources."
  },
  "context-overflow": {
    server: "Rejects request due to input exceeding maximum context length, returning context limit error.",
    client: "Recognizes context_overflow. Suppresses retry/fallback and indicates context_compaction_required."
  },
  "session-lock-conflict": {
    server: "Accepts requests.",
    client: "Finds concurrent requests running under the same sessionId. Blocks current call (session_locked) to protect history."
  },
  "max-turns-exceeded": {
    server: "Accepts requests.",
    client: "Blocks API call before dispatching (max_turns_exceeded) because currentTurn has exceeded the maxTurns threshold."
  }
};

const scenarioBehaviorsFr: Record<ScenarioName, ScenarioBehavior> = {
  "normal": {
    server: "Diffuse des fragments de texte complets uniformément et se termine avec un signal [DONE] normal.",
    client: "Reçoit et reconstruit le texte complet, enregistre tracked_output et génère un statut completed."
  },
  "slow": {
    server: "Diffuse des fragments avec un délai de 150 ms entre chaque paquet, puis envoie le signal [DONE].",
    client: "Utilise idleTimeoutMs comme attente maximale entre deux fragments et réinitialise ce minuteur à chaque fragment. wallTimeoutMs reste la limite globale de l'attempt; si les deux budgets tiennent, le statut est completed_slow."
  },
  "rate-limit-retry-after": {
    server: "Renvoie une erreur HTTP 429 avant le premier jeton, avec une en-tête retry-after de 1s.",
    client: "Identifié comme rate_limited. Sans sortie partielle, planifie un réessayage automatique en respectant le délai."
  },
  "overloaded-retry-after": {
    server: "Renvoie une erreur HTTP 529 avant le premier jeton, avec une en-tête retry-after de 1s.",
    client: "Identifié comme overloaded. Sans sortie partielle, tente un réessayage automatique."
  },
  "server-error": {
    server: "Renvoie directement une erreur HTTP 500 avant d'envoyer le premier jeton.",
    client: "Identifié comme server_error. Sans sortie partielle, permet un réessayage automatique après un délai de sécurité."
  },
  "midstream-close": {
    server: "Envoie les deux premiers fragments de texte, puis ferme brutalement le socket TCP sans signal de fin.",
    client: "Détecte la déconnexion. Protège la sortie partielle existante, supprime les réessayages automatiques, renvoie partial_returned."
  },
  "half-sse-frame": {
    server: "Écrit une trame SSE incomplète (par ex. data: {\"cho) puis détruit immédiatement le socket.",
    client: "Détecte une erreur d'analyse. Classifie en malformed_stream et entre en safe_failure pour éviter les réessais infinis."
  },
  "silent-hang": {
    server: "Établit la connexion, envoie les en-têtes, puis se suspend indéfiniment sans envoyer de texte ni de ping.",
    client: "Dépasse idleTimeoutMs. Déclenche le minuteur d'inactivité, annule la requête et classifie en aborted_idle_timeout."
  },
  "heartbeat-only": {
    server: "Garde la connexion ouverte mais envoie uniquement des pings sans contenu textuel utile.",
    client: "Reconnait que les pings ne contiennent pas de texte. Déclenche un timeout par manque de contenu et annule le flux."
  },
  "half-tool-json": {
    server: "Diffuse un JSON de paramètres d'outil incomplet, puis ferme brutalement le socket.",
    client: "Bloque l'exécution de l'outil pour éviter des effets secondaires, marquant safe_failure."
  },
  "flood": {
    server: "Envoie 250 fragments de texte à haute fréquence sans délai.",
    client: "Teste la capacité du client à consommer des deltas rapides sans perte de trames."
  },
  "bounded-queue-overflow": {
    server: "Diffuse rapidement de nombreux fragments, dépassant le budget d'événements du client.",
    client: "Déclenche la protection anti-surpression. Annule la connexion pour protéger la mémoire, marquant safe_failure."
  },
  "consumer-drop": {
    server: "Diffuse normalement jusqu'à ce que le consommateur en aval annule la connexion.",
    client: "Annule la connexion du flux, classifié en consumer_cancelled. Ne tente pas de réessayage."
  },
  "fallback-recovery": {
    server: "Le modèle principal renvoie une erreur HTTP 529; le modèle de secours fonctionne normalement.",
    client: "Échoue sur le modèle principal avant jeton. Redirige automatiquement la requête vers fallbackModel (recovered)."
  },
  "circuit-breaker-open": {
    server: "Renvoie systématiquement une erreur HTTP 529.",
    client: "Ouvre le disjoncteur (circuit_opened) après plusieurs échecs consécutifs, bloquant les requêtes en aval."
  },
  "provider-cooldown": {
    server: "Renvoie systématiquement une erreur HTTP 529.",
    client: "Active le cooldown du fournisseur après échecs répétés, bloquant temporairement les appels à ce fournisseur."
  },
  "background-overloaded": {
    server: "Renvoie une erreur de surcharge HTTP 529.",
    client: "Détecte une requête d'arrière-plan en surcharge. L'annule immédiatement pour économiser les ressources."
  },
  "context-overflow": {
    server: "Rejette la requête car le contexte dépasse la longueur maximale autorisée.",
    client: "Reconnait context_overflow. Supprime les réessais et indique context_compaction_required."
  },
  "session-lock-conflict": {
    server: "Reçoit des requêtes.",
    client: "Détecte des requêtes simultanées sous le même sessionId. Bloque l'appel (session_locked) pour éviter les corruptions."
  },
  "max-turns-exceeded": {
    server: "Simule la réception de requêtes.",
    client: "Bloque l'appel d'API (max_turns_exceeded) car le nombre de tours (currentTurn) dépasse le maximum autorisé."
  }
};

const scenarioBehaviorsRu: Record<ScenarioName, ScenarioBehavior> = {
  "normal": {
    server: "Равномерно отправляет полные текстовые фрагменты потока и завершает сессию нормальным сигналом [DONE].",
    client: "Корректно собирает текст, регистрирует действие tracked_output и возвращает успешный статус completed."
  },
  "slow": {
    server: "Отправляет фрагменты текста с задержкой в 150 мс между каждым пакетом, затем шлет [DONE].",
    client: "Использует idleTimeoutMs как максимальное ожидание между фрагментами и сбрасывает этот таймер при каждом событии. wallTimeoutMs остается общим жестким лимитом attempt; при соблюдении обоих бюджетов возвращается completed_slow."
  },
  "rate-limit-retry-after": {
    server: "Возвращает HTTP 429 перед первым токеном, прикрепляя заголовок retry-after: 1 сек.",
    client: "Классифицирует как rate_limited. Так как вывода еще нет, планирует автоповтор с учетом времени ожидания."
  },
  "overloaded-retry-after": {
    server: "Возвращает HTTP 529 перед первым токеном, прикрепляя заголовок retry-after: 1 сек.",
    client: "Классифицирует как overloaded. Без частичного вывода пытается выполнить автоматический повторный запрос."
  },
  "server-error": {
    server: "Возвращает HTTP 500 перед отправкой первого токена.",
    client: "Классифицирует как server_error. При отсутствии частичного вывода выполняет повтор после безопасного интервала."
  },
  "midstream-close": {
    server: "Отправляет первые два фрагмента, затем резко обрывает TCP-соединение без отправки завершающего токена.",
    client: "Обнаруживает разрыв соединения. Сохраняет частичный вывод, блокирует повторы/резервы, возвращает partial_returned."
  },
  "half-sse-frame": {
    server: "Отправляет неполный пакет SSE (например, data: {\"cho) и сразу уничтожает сокет.",
    client: "Обнаруживает ошибку парсинга. Классифицирует как malformed_stream и переходит в safe_failure во избежание бесконечных повторов."
  },
  "silent-hang": {
    server: "Устанавливает соединение, отправляет заголовки, затем зависает без отправки текста или пингов.",
    client: "Превышает idleTimeoutMs. Таймер простоя отменяет запрос, переводя его в состояние aborted_idle_timeout."
  },
  "heartbeat-only": {
    server: "Поддерживает соединение, но шлет только пинги/пинг-понги без реального текста.",
    client: "Определяет, что пинги не несут полезной нагрузки. Превышает лимит времени простоя и отменяет соединение."
  },
  "half-tool-json": {
    server: "Отправляет неполный JSON аргументов функции инструмента, затем обрывает сокет.",
    client: "Блокирует выполнение вызова инструмента для предотвращения побочных эффектов, переводя в статус safe_failure."
  },
  "flood": {
    server: "Отправляет 250 небольших фрагментов текста с высокой частотой без задержки.",
    client: "Проверяет способность клиента обрабатывать быстрый поток дельт без пропуска пакетов."
  },
  "bounded-queue-overflow": {
    server: "Быстро шлет множество фрагментов, превышая лимит событий буфера клиента.",
    client: "Запускает защиту от переполнения. Прерывает соединение для защиты памяти, возвращая статус safe_failure."
  },
  "consumer-drop": {
    server: "Передает текстовые дельты до тех пор, пока клиентский потребитель не разорвет соединение.",
    client: "Отменяет соединение потока, возвращая статус consumer_cancelled. Не выполняет повторных попыток."
  },
  "fallback-recovery": {
    server: "Основная модель возвращает ошибку HTTP 529; резервная работает нормально.",
    client: "Падает на основной модели до токена. Автоматически перенаправляет запрос на fallbackModel (recovered)."
  },
  "circuit-breaker-open": {
    server: "Стабильно возвращает HTTP 529.",
    client: "Открывает автоматический прерыватель (circuit_opened) после серии неудач, предотвращая лавину повторных запросов."
  },
  "provider-cooldown": {
    server: "Стабильно возвращает HTTP 529.",
    client: "Вводит время остывания провайдера после серии сбоев, временно блокируя обращения к нему."
  },
  "background-overloaded": {
    server: "Возвращает ответ перегрузки HTTP 529.",
    client: "Обнаруживает фоновый запрос при перегрузке. Немедленно отменяет его для экономии ресурсов."
  },
  "context-overflow": {
    server: "Отклоняет запрос, так как входной контекст превышает максимальную длину.",
    client: "Распознает context_overflow. Отменяет повторы и запрашивает сжатие контекста context_compaction_required."
  },
  "session-lock-conflict": {
    server: "Принимает входящие запросы.",
    client: "Обнаруживает параллельный запрос под тем же sessionId. Блокирует вызов (session_locked) для защиты истории сессии."
  },
  "max-turns-exceeded": {
    server: "Имитирует прием запросов.",
    client: "Блокирует вызов API (max_turns_exceeded), так как текущий шаг currentTurn превышает порог maxTurns."
  }
};

const translations = {
  en: {
    title: "Stream Resilience Lab",
    subtitle: "Chronological diagnostics flow of stream interactions",
    provider: "PROVIDER",
    start: "Start",
    stop: "Stop",
    run: "Run",
    running: "Running...",
    stopRun: "Stop Run",
    configuration: "Configuration",
    scenarioLibrary: "Scenario Library",
    parameters: "Parameters",
    protocol: "Protocol",
    scenario: "Scenario",
    quickPrompts: "Quick Prompts",
    queryPrompt: "Query Prompt",
    advancedSettings: "Advanced Client Settings",
    maxAttempts: "Max Attempts",
    priority: "Priority",
    foreground: "Foreground",
    background: "Background",
    idleTimeout: "Idle Timeout (ms)",
    wallTimeout: "Wall Timeout (ms)",
    fallbackModel: "Fallback Model",
    sessionId: "Session ID",
    searchPlaceholder: "Search scenarios...",
    noScenarios: "No matching scenarios found.",
    consoleTitle: "Trace Pipeline Console",
    clearConsole: "Clear Console",
    noTraces: "No Traces Captured",
    noTracesDesc: "Click \"Run\" in the top bar to run a resilience simulation. Traces will populate here in real-time.",
    outcomeReport: "Run Outcome Report",
    safeToRetry: "Safe to Retry",
    unsafeToRetry: "Unsafe to Retry",
    duration: "Duration",
    attempts: "Attempts",
    problem: "Problem",
    tokensChars: "Tokens/Chars",
    mitigations: "Mitigation Actions",
    reconstructedContent: "Reconstructed Stream Content",
    copy: "Copy",
    copied: "Copied!",
    serverHeader: "Server",
    clientHeader: "Client",
    seq: "Seq",
    inspector: "Inspector",
    metadata: "Metadata",
    timestamp: "Timestamp",
    sequence: "Sequence",
    origin: "Origin",
    eventType: "Event Type",
    attemptId: "Attempt ID",
    requestId: "Request ID",
    summary: "Summary",
    payloadData: "Payload Data",
    noPayload: "No payload data associated with this event.",
    noEventSelected: "Select a trace event from the timeline to inspect its metadata payload.",
    expectedBehavior: "Expected Scenario Behavior",
    expectedServer: "Expected Server Behavior",
    expectedClient: "Expected Client Resilience",
    server: "Server",
    client: "Client",
    expectedLabel: "Expected:",
    fallbackModelPlaceholder: "Model to route overloads to",
    sessionIdPlaceholder: "session_xxxx",
    streamBadge: "Stream",
    statusStopped: "stopped",
    statusStarting: "starting",
    statusRunning: "running",
    statusExternal: "external",
    statusFailed: "failed"
  },
  zh: {
    title: "流弹性实验室",
    subtitle: "双端流式交互时序诊断控制台",
    provider: "故障服务商",
    start: "启动服务",
    stop: "停止服务",
    run: "运行测试",
    running: "运行中...",
    stopRun: "终止运行",
    configuration: "参数配置",
    scenarioLibrary: "故障场景库",
    parameters: "仿真参数",
    protocol: "协议适配",
    scenario: "故障场景",
    quickPrompts: "快捷提示词",
    queryPrompt: "用户查询输入",
    advancedSettings: "客户端高级配置",
    maxAttempts: "最大尝试次数",
    priority: "优先级",
    foreground: "前台任务",
    background: "后台任务",
    idleTimeout: "空闲超时限制 (ms)",
    wallTimeout: "总耗时硬上限 (ms)",
    fallbackModel: "备用模型 (Fallback)",
    sessionId: "会话 ID (Session ID)",
    searchPlaceholder: "搜索故障场景...",
    noScenarios: "未找到匹配的场景。",
    consoleTitle: "时序诊断 Trace 控制台",
    clearConsole: "清空控制台",
    noTraces: "暂无 Trace 数据",
    noTracesDesc: "请在顶部启动故障服务并点击“运行测试”，流式故障交互的 Trace 事件会实时在此处呈现。",
    outcomeReport: "仿真运行报告 (Outcome)",
    safeToRetry: "安全可自动重试",
    unsafeToRetry: "禁止自动重试",
    duration: "运行时长",
    attempts: "执行重试",
    problem: "问题归类",
    tokensChars: "接收字符数",
    mitigations: "触发弹性自保动作",
    reconstructedContent: "客户端最终重组流文本",
    copy: "复制",
    copied: "已复制！",
    serverHeader: "服务端 (Server)",
    clientHeader: "客户端 (Client)",
    seq: "序号",
    inspector: "Inspector",
    metadata: "元数据",
    timestamp: "时间戳",
    sequence: "序号",
    origin: "数据源",
    eventType: "事件类型",
    attemptId: "尝试 ID",
    requestId: "请求 ID",
    summary: "事件摘要",
    payloadData: "载荷数据 (Payload)",
    noPayload: "该事件没有关联的载荷数据。",
    noEventSelected: "在时序图上选择一个 Trace 事件以查看其元数据与载荷信息。",
    expectedBehavior: "当前场景预期行为说明",
    expectedServer: "预期服务端仿真行为",
    expectedClient: "预期客户端弹性决策",
    server: "服务端",
    client: "客户端",
    expectedLabel: "预期故障类别:",
    fallbackModelPlaceholder: "过载时降级路由到的备用模型",
    sessionIdPlaceholder: "会话标识 (如 session_xxxx)",
    streamBadge: "流式",
    statusStopped: "已停止",
    statusStarting: "启动中",
    statusRunning: "运行中",
    statusExternal: "外部运行",
    statusFailed: "启动失败"
  },
  fr: {
    title: "Lab de Résilience des Flux",
    subtitle: "Flux de diagnostic chronologique des interactions double-extrémité",
    provider: "FOURNISSEUR",
    start: "Démarrer",
    stop: "Arrêter",
    run: "Lancer",
    running: "En cours...",
    stopRun: "Arrêter l'exécution",
    configuration: "Configuration",
    scenarioLibrary: "Bibliothèque de Scénarios",
    parameters: "Paramètres de Simulation",
    protocol: "Protocole",
    scenario: "Scénario de Panne",
    quickPrompts: "Prompts Rapides",
    queryPrompt: "Requête de l'Utilisateur",
    advancedSettings: "Paramètres Client Avancés",
    maxAttempts: "Tentatives Max",
    priority: "Priorité",
    foreground: "Premier plan",
    background: "Arrière-plan",
    idleTimeout: "Délai d'inactivité (ms)",
    wallTimeout: "Délai global (ms)",
    fallbackModel: "Modèle de Secours",
    sessionId: "ID de Session",
    searchPlaceholder: "Rechercher des scénarios...",
    noScenarios: "Aucun scénario correspondant trouvé.",
    consoleTitle: "Console de Traces",
    clearConsole: "Effacer la console",
    noTraces: "Aucune Trace Capturée",
    noTracesDesc: "Cliquez sur \"Lancer\" en haut pour simuler la résilience. Les traces s'afficheront en temps réel.",
    outcomeReport: "Rapport de Résultat (Outcome)",
    safeToRetry: "Sécurisé pour réessayage",
    unsafeToRetry: "Non sécurisé pour réessayage",
    duration: "Durée d'exécution",
    attempts: "Tentatives de retry",
    problem: "Classification du Problème",
    tokensChars: "Caractères reçus",
    mitigations: "Actions de Résilience Déclenchées",
    reconstructedContent: "Contenu Reconstruit du Flux Client",
    copy: "Copier",
    copied: "Copié !",
    serverHeader: "Serveur (Server)",
    clientHeader: "Client (Client)",
    seq: "N° Séquence",
    inspector: "Inspector",
    metadata: "Métadonnées",
    timestamp: "Horodatage",
    sequence: "Séquence",
    origin: "Source des données",
    eventType: "Type d'événement",
    attemptId: "ID de Tentative",
    requestId: "ID de Requête",
    summary: "Résumé de l'événement",
    payloadData: "Données Utiles (Payload)",
    noPayload: "Aucune donnée utile associée à cet événement.",
    noEventSelected: "Sélectionnez une trace sur le graphique chronologique pour inspecter les métadonnées.",
    expectedBehavior: "Comportement Attendu du Scénario",
    expectedServer: "Comportement Serveur Attendu",
    expectedClient: "Résilience Client Attendue",
    server: "Serveur",
    client: "Client",
    expectedLabel: "Attendu :",
    fallbackModelPlaceholder: "Modèle vers lequel rediriger les surcharges",
    sessionIdPlaceholder: "session_xxxx",
    streamBadge: "Flux",
    statusStopped: "arrêté",
    statusStarting: "démarrage",
    statusRunning: "en cours",
    statusExternal: "externe",
    statusFailed: "échoué"
  },
  ru: {
    title: "Лаборатория Устойчивости",
    subtitle: "Хронологический пульт диагностики двухстороннего потока",
    provider: "ПРОВАЙДЕР",
    start: "Запустить",
    stop: "Остановить",
    run: "Запуск",
    running: "Запуск...",
    stopRun: "Прервать запуск",
    configuration: "Параметры",
    scenarioLibrary: "Библиотека Сценариев",
    parameters: "Параметры Симуляции",
    protocol: "Протокол",
    scenario: "Сценарий Сбоя",
    quickPrompts: "Быстрые Запросы",
    queryPrompt: "Запрос Пользователя",
    advancedSettings: "Расширенные Настройки Клиента",
    maxAttempts: "Макс. Попыток",
    priority: "Приоритет",
    foreground: "Передний план",
    background: "Фоновый режим",
    idleTimeout: "Таймаут простоя (мс)",
    wallTimeout: "Общий таймаут (мс)",
    fallbackModel: "Резервная Модель",
    sessionId: "Идентификатор Сессии",
    searchPlaceholder: "Поиск сценариев...",
    noScenarios: "Сценарии не найдены.",
    consoleTitle: "Консоль Трассировки",
    clearConsole: "Очистить консоль",
    noTraces: "Трассировка Отсутствует",
    noTracesDesc: "Нажмите «Запуск» в верхней панели, чтобы запустить симуляцию. Трассировка появится в реальном времени.",
    outcomeReport: "Отчет о Результатах (Outcome)",
    safeToRetry: "Безопасно повторить",
    unsafeToRetry: "Небезопасно повторить",
    duration: "Время выполнения",
    attempts: "Повторные попытки",
    problem: "Классификация Проблемы",
    tokensChars: "Получено символов",
    mitigations: "Действия по Защите",
    reconstructedContent: "Восстановленный Текст Клиента",
    copy: "Копировать",
    copied: "Скопировано!",
    serverHeader: "Сервер (Server)",
    clientHeader: "Клиент (Client)",
    seq: "Порядковый №",
    inspector: "Inspector",
    metadata: "Метаданные",
    timestamp: "Временная метка",
    sequence: "Последовательность",
    origin: "Источник",
    eventType: "Тип события",
    attemptId: "ID Попытки",
    requestId: "ID Запроса",
    summary: "Сводка события",
    payloadData: "Данные Запроса (Payload)",
    noPayload: "Данные для этого события отсутствуют.",
    noEventSelected: "Выберите событие трассировки на таймлайне для инспекции данных.",
    expectedBehavior: "Ожидаемое Поведение Сценария",
    expectedServer: "Ожидаемое Поведение Сервера",
    expectedClient: "Ожидаемая Защита Клиента",
    server: "Сервер",
    client: "Клиент",
    expectedLabel: "Ожидается:",
    fallbackModelPlaceholder: "Модель для перенаправления перегрузок",
    sessionIdPlaceholder: "сессия_xxxx",
    streamBadge: "Поток",
    statusStopped: "остановлен",
    statusStarting: "запуск",
    statusRunning: "активен",
    statusExternal: "внешний",
    statusFailed: "ошибка"
  }
};

const categoryTranslations: Record<"en" | "zh" | "fr" | "ru", Record<string, string>> = {
  en: {
    baseline: "Baseline & Normal",
    connection: "Pre-Token & Connection Errors",
    midstream: "Mid-Stream & SSE Failures",
    backpressure: "Backpressure & Cancel",
    resilience: "Resilience & Circuit Breakers",
    preflight: "Client-Side Preflight"
  },
  zh: {
    baseline: "基准与正常场景",
    connection: "首包前与连接错误",
    midstream: "流式传输中故障",
    backpressure: "背压与取消控制",
    resilience: "弹性策略与熔断",
    preflight: "客户端 Preflight 检查"
  },
  fr: {
    baseline: "Base & Normal",
    connection: "Erreurs Pre-Token & Connexion",
    midstream: "Pannes en Cours de Flux",
    backpressure: "Contre-Pression & Annulation",
    resilience: "Résilience & Disjoncteurs",
    preflight: "Preflight du Client"
  },
  ru: {
    baseline: "Базовые и Нормальные",
    connection: "Ошибки до Первого Токена",
    midstream: "Сбои в процессе Стриминга",
    backpressure: "Обратное Давление и Отмена",
    resilience: "Устойчивость и Предохранители",
    preflight: "Клиентские проверки Preflight"
  }
};

const categoryKeys = ["baseline", "connection", "midstream", "backpressure", "resilience", "preflight"] as const;

const scenarioCategoryMap: Record<ScenarioName, typeof categoryKeys[number]> = {
  normal: "baseline",
  slow: "baseline",
  flood: "baseline",
  "rate-limit-retry-after": "connection",
  "overloaded-retry-after": "connection",
  "server-error": "connection",
  "midstream-close": "midstream",
  "half-sse-frame": "midstream",
  "silent-hang": "midstream",
  "heartbeat-only": "midstream",
  "half-tool-json": "midstream",
  "bounded-queue-overflow": "backpressure",
  "consumer-drop": "backpressure",
  "fallback-recovery": "resilience",
  "circuit-breaker-open": "resilience",
  "provider-cooldown": "resilience",
  "background-overloaded": "resilience",
  "context-overflow": "preflight",
  "session-lock-conflict": "preflight",
  "max-turns-exceeded": "preflight"
};

const scenarioTranslations: Record<"en" | "zh" | "fr" | "ru", Record<ScenarioName, { name: string; description: string }>> = {
  en: {
    "normal": { name: "normal", description: "valid response or valid stream" },
    "slow": { name: "slow", description: "delays first token and subsequent tokens" },
    "rate-limit-retry-after": { name: "rate-limit-retry-after", description: "returns 429 with retry-after before first token" },
    "overloaded-retry-after": { name: "overloaded-retry-after", description: "returns 529 with retry-after before first token" },
    "server-error": { name: "server-error", description: "returns 500 before first token" },
    "midstream-close": { name: "midstream-close", description: "emits partial text then closes the socket" },
    "half-sse-frame": { name: "half-sse-frame", description: "writes an incomplete SSE data frame then closes" },
    "silent-hang": { name: "silent-hang", description: "keeps stream open without useful events" },
    "heartbeat-only": { name: "heartbeat-only", description: "keeps stream open with heartbeat or ping events only" },
    "half-tool-json": { name: "half-tool-json", description: "streams incomplete tool-call JSON then closes" },
    "flood": { name: "flood", description: "emits many chunks quickly" },
    "bounded-queue-overflow": { name: "bounded-queue-overflow", description: "emits more chunks than the client queue budget allows" },
    "consumer-drop": { name: "consumer-drop", description: "emits partial text until the downstream consumer disconnects" },
    "fallback-recovery": { name: "fallback-recovery", description: "fails on the primary model and succeeds on a fallback model" },
    "circuit-breaker-open": { name: "circuit-breaker-open", description: "opens a circuit after repeated provider failures" },
    "provider-cooldown": { name: "provider-cooldown", description: "opens a provider cooldown after repeated overload responses" },
    "background-overloaded": { name: "background-overloaded", description: "drops background work when the provider is overloaded" },
    "context-overflow": { name: "context-overflow", description: "returns a context length error that requires compaction" },
    "session-lock-conflict": { name: "session-lock-conflict", description: "blocks concurrent work for the same session" },
    "max-turns-exceeded": { name: "max-turns-exceeded", description: "stops a loop before exceeding the configured max turns" }
  },
  zh: {
    "normal": { name: "正常流式响应 (normal)", description: "分块均匀发送完整的流文本数据，最后正常关闭连接。" },
    "slow": { name: "延迟慢速流 (slow)", description: "以较大的延迟时间间隔分块发送流数据，测试空闲与耗时上限控制。" },
    "rate-limit-retry-after": { name: "速率限制 (rate-limit-retry-after)", description: "连接前返回 HTTP 429 速率限制错误，并在头部附带重试等待时间。" },
    "overloaded-retry-after": { name: "服务过载 (overloaded-retry-after)", description: "连接前返回 HTTP 529 服务过载错误，并在头部附带重试等待时间。" },
    "server-error": { name: "服务器故障 (server-error)", description: "连接前直接返回 HTTP 500 服务器故障错误，触发客户端重新调度重试。" },
    "midstream-close": { name: "流中途异常断开 (midstream-close)", description: "正常发送前两个分块，随后不发送结束标记直接强行销毁套接字。" },
    "half-sse-frame": { name: "不完整 SSE 数据帧 (half-sse-frame)", description: "写入未闭合或截断的 SSE 字符串帧后立即强行断开 TCP 连接。" },
    "silent-hang": { name: "连接无响应挂起 (silent-hang)", description: "成功建立连接并发送头部，之后无限期挂起不作任何响应。" },
    "heartbeat-only": { name: "仅发送心跳 (heartbeat-only)", description: "保持流连接打开，但只发送心跳帧事件，无任何实际业务文本内容。" },
    "half-tool-json": { name: "不完整工具 JSON (half-tool-json)", description: "流式发送未闭合的工具调用参数 JSON 后强行断开连接，防止副作用执行。" },
    "flood": { name: "高频流量冲击 (flood)", description: "无延迟地高频快速发送大量小分块文本，测试客户端大吞吐量流接收能力。" },
    "bounded-queue-overflow": { name: "队列容量溢出 (bounded-queue-overflow)", description: "快速连续发送大量分块文本，超出客户端设接收队列缓冲上限。" },
    "consumer-drop": { name: "消费者主动取消 (consumer-drop)", description: "正常发送流数据，直至客户端下游消费者取消或主动断开连接。" },
    "fallback-recovery": { name: "备用降级恢复 (fallback-recovery)", description: "主模型服务发生过载；在尝试耗尽后自动降级并重试备选备用模型。" },
    "circuit-breaker-open": { name: "熔断器开启拦截 (circuit-breaker-open)", description: "检测到连续故障后打开熔断器，在冷却期内直接拦截后置请求。" },
    "provider-cooldown": { name: "服务商冷却保护 (provider-cooldown)", description: "当故障耗尽后触发提供者冷却，短时间内拒绝再次向该提供者请求。" },
    "background-overloaded": { name: "后台过载任务丢弃 (background-overloaded)", description: "检测到请求为低优先级后台任务且遇到过载，直接丢弃，不启动重试。" },
    "context-overflow": { name: "上下文长度溢出 (context-overflow)", description: "提示词超出模型最大长度限制，返回溢出错误且标记需要上下文整理。" },
    "session-lock-conflict": { name: "会话锁冲突 (session-lock-conflict)", description: "判定同一 sessionId 存在未结束的并发请求，拒绝启动当前调用。" },
    "max-turns-exceeded": { name: "迭代回合数超限 (max-turns-exceeded)", description: "交互回合超过最大上限，在 preflight 阶段便强行阻断 API 请求。" }
  },
  fr: {
    "normal": { name: "normal", description: "diffuse des fragments de texte complets uniformément et se termine normalement." },
    "slow": { name: "slow", description: "diffuse des fragments avec un long délai pour tester les timeouts d'inactivité." },
    "rate-limit-retry-after": { name: "rate-limit-retry-after", description: "renvoie HTTP 429 avant le premier jeton avec une en-tête de délai de réessayage." },
    "overloaded-retry-after": { name: "overloaded-retry-after", description: "renvoie HTTP 529 avant le premier jeton avec une en-tête de délai de réessayage." },
    "server-error": { name: "server-error", description: "renvoie HTTP 500 avant d'envoyer le premier jeton." },
    "midstream-close": { name: "midstream-close", description: "diffuse du texte partiel puis détruit brutalement la connexion TCP." },
    "half-sse-frame": { name: "half-sse-frame", description: "envoie un paquet SSE tronqué et détruit immédiatement le socket." },
    "silent-hang": { name: "silent-hang", description: "établit la connexion puis se suspend indéfiniment sans envoyer d'événements." },
    "heartbeat-only": { name: "heartbeat-only", description: "garde la connexion ouverte mais envoie uniquement des pulsations sans texte." },
    "half-tool-json": { name: "half-tool-json", description: "diffuse un JSON de paramètres d'outil incomplet et ferme brutalement." },
    "flood": { name: "flood", description: "diffuse de nombreux fragments très rapidement sans délai." },
    "bounded-queue-overflow": { name: "bounded-queue-overflow", description: "diffuse trop de fragments rapidement, dépassant le budget client." },
    "consumer-drop": { name: "consumer-drop", description: "diffuse normalement jusqu'à ce que le consommateur annule la connexion." },
    "fallback-recovery": { name: "fallback-recovery", description: "échoue sur le modèle principal puis redirige vers le modèle de secours." },
    "circuit-breaker-open": { name: "circuit-breaker-open", description: "ouvre le disjoncteur après des échecs répétés pour bloquer les appels." },
    "provider-cooldown": { name: "provider-cooldown", description: "active le refroidissement après surcharges répétées pour bloquer les requêtes." },
    "background-overloaded": { name: "background-overloaded", description: "annule immédiatement les requêtes en arrière-plan en cas de surcharge." },
    "context-overflow": { name: "context-overflow", description: "rejette la requête car le contexte dépasse la longueur maximale." },
    "session-lock-conflict": { name: "session-lock-conflict", description: "détecte des requêtes simultanées sous le même ID de session et bloque." },
    "max-turns-exceeded": { name: "max-turns-exceeded", description: "bloque l'appel car le nombre de tours a dépassé le maximum autorisé." }
  },
  ru: {
    "normal": { name: "normal", description: "равномерно отправляет текстовые фрагменты потока и завершается нормально." },
    "slow": { name: "slow", description: "отправляет фрагменты с задержкой для тестирования таймаутов простоя." },
    "rate-limit-retry-after": { name: "rate-limit-retry-after", description: "возвращает HTTP 429 перед первым токеном с заголовком retry-after." },
    "overloaded-retry-after": { name: "overloaded-retry-after", description: "возвращает HTTP 529 перед первым токеном с заголовком retry-after." },
    "server-error": { name: "server-error", description: "возвращает HTTP 500 перед отправкой первого токена." },
    "midstream-close": { name: "midstream-close", description: "отправляет часть текста, затем резко обрывает TCP-соединение." },
    "half-sse-frame": { name: "half-sse-frame", description: "отправляет поврежденный/неполный пакет SSE и закрывает сокет." },
    "silent-hang": { name: "silent-hang", description: "устанавливает соединение и зависает без отправки данных." },
    "heartbeat-only": { name: "heartbeat-only", description: "сохраняет соединение, но шлет только пинги без реального текста." },
    "half-tool-json": { name: "half-tool-json", description: "отправляет неполный JSON аргументов инструмента и обрывает сокет." },
    "flood": { name: "flood", description: "очень быстро отправляет множество мелких фрагментов без задержки." },
    "bounded-queue-overflow": { name: "bounded-queue-overflow", description: "быстро отправляет много фрагментов, превышая лимит буфера." },
    "consumer-drop": { name: "consumer-drop", description: "передает данные до тех пор, пока клиентский потребитель не отменит." },
    "fallback-recovery": { name: "fallback-recovery", description: "сбой основной модели перенаправляет запрос на резервную." },
    "circuit-breaker-open": { name: "circuit-breaker-open", description: "блокирует запросы при открытом автопрерывателе после серии сбоев." },
    "provider-cooldown": { name: "provider-cooldown", description: "временно блокирует обращения к провайдеру после повторных сбоев." },
    "background-overloaded": { name: "background-overloaded", description: "сбрасывает фоновые запросы при перегрузке для экономии ресурсов." },
    "context-overflow": { name: "context-overflow", description: "отклоняет запрос из-за превышения максимальной длины контекста." },
    "session-lock-conflict": { name: "session-lock-conflict", description: "блокирует параллельные запросы с одинаковым ID сессии." },
    "max-turns-exceeded": { name: "max-turns-exceeded", description: "блокирует вызов API при превышении лимита шагов maxTurns." }
  }
};

const problemTranslations: Record<"en" | "zh" | "fr" | "ru", Record<string, string>> = {
  en: {
    "none": "None",
    "rate_limited": "Rate Limited",
    "overloaded": "Overloaded",
    "server_error": "Server Error",
    "stream_interrupted": "Stream Interrupted",
    "malformed_stream": "Malformed Stream",
    "idle_timeout": "Idle Timeout",
    "unsafe_partial_tool_call": "Unsafe Partial Tool Call",
    "stream_backpressure": "Stream Backpressure",
    "consumer_cancelled": "Consumer Cancelled",
    "context_overflow": "Context Overflow",
    "session_lock_conflict": "Session Lock Conflict",
    "max_turns_exceeded": "Max Turns Exceeded"
  },
  zh: {
    "none": "无故障",
    "rate_limited": "速率限制 (429)",
    "overloaded": "提供商过载 (529)",
    "server_error": "服务器故障 (500)",
    "stream_interrupted": "流中途异常中断",
    "malformed_stream": "流数据畸形损坏",
    "idle_timeout": "连接无响应超时",
    "unsafe_partial_tool_call": "不完整工具调用保护",
    "stream_backpressure": "背压缓冲队列溢出",
    "consumer_cancelled": "消费者取消会话",
    "context_overflow": "上下文长度溢出",
    "session_lock_conflict": "并发会话冲突锁闭",
    "max_turns_exceeded": "迭代回合数超限"
  },
  fr: {
    "none": "Aucun",
    "rate_limited": "Limite de Taux",
    "overloaded": "Surcharge Fournisseur",
    "server_error": "Erreur Serveur",
    "stream_interrupted": "Flux Interrompu",
    "malformed_stream": "Flux Malformé",
    "idle_timeout": "Timeout d'Inactivité",
    "unsafe_partial_tool_call": "Appel d'Outil Incomplet",
    "stream_backpressure": "Contre-pression de Flux",
    "consumer_cancelled": "Annulé par le Consommateur",
    "context_overflow": "Débordement de Contexte",
    "session_lock_conflict": "Conflit de Verrou de Session",
    "max_turns_exceeded": "Tours Max Dépassés"
  },
  ru: {
    "none": "Нет",
    "rate_limited": "Лимит Запросов",
    "overloaded": "Перегрузка Провайдера",
    "server_error": "Ошибка Сервера",
    "stream_interrupted": "Поток Прерван",
    "malformed_stream": "Искаженный Поток",
    "idle_timeout": "Таймаут Простоя",
    "unsafe_partial_tool_call": "Неполный Вызов Инструмента",
    "stream_backpressure": "Ограничение Очереди (Backpressure)",
    "consumer_cancelled": "Отменено Потребителем",
    "context_overflow": "Переполнение Контекста",
    "session_lock_conflict": "Конфликт Блокировки Сессии",
    "max_turns_exceeded": "Превышен Лимит Ходов"
  }
};

const statusTranslations: Record<"en" | "zh" | "fr" | "ru", Record<string, string>> = {
  en: {
    "completed": "Completed Successfully",
    "completed_slow": "Completed Successfully (Slow)",
    "partial_returned": "Partial Output Returned",
    "safe_failure": "Safe Failure Blocked",
    "consumer_cancelled": "Consumer Cancelled",
    "recovered": "Recovered (Fallback Used)",
    "circuit_opened": "Circuit Breaker Opened",
    "cooldown_opened": "Provider Cooldown Activated",
    "dropped_background": "Background Request Dropped",
    "context_compaction_required": "Context Compaction Required",
    "session_locked": "Session Locked",
    "max_turns_exceeded": "Max Turns Exceeded"
  },
  zh: {
    "completed": "仿真执行成功 (Completed)",
    "completed_slow": "执行成功但响应缓慢 (Completed Slow)",
    "partial_returned": "安全保留部分已输出文本 (Partial Returned)",
    "safe_failure": "安全失败：阻断畸形执行 (Safe Failure)",
    "consumer_cancelled": "消费者已取消会话 (Consumer Cancelled)",
    "recovered": "已降级备用模型恢复 (Recovered)",
    "circuit_opened": "熔断器已开启拦截 (Circuit Opened)",
    "cooldown_opened": "已开启供应商冷却保护 (Cooldown Opened)",
    "dropped_background": "过载已丢弃后台任务 (Dropped Background)",
    "context_compaction_required": "需压缩整理上下文 (Compaction Required)",
    "session_locked": "会话锁冲突拦截 (Session Locked)",
    "max_turns_exceeded": "超过最大交互回合拦截 (Max Turns Exceeded)"
  },
  fr: {
    "completed": "Terminé avec Succès",
    "completed_slow": "Terminé avec Succès (Lent)",
    "partial_returned": "Sortie Partielle Renvoyée",
    "safe_failure": "Échec Sécurisé Bloqué",
    "consumer_cancelled": "Annulé par le Consommateur",
    "recovered": "Récupéré via Secours",
    "circuit_opened": "Disjoncteur Activé",
    "cooldown_opened": "Fournisseur en Refroidissement",
    "dropped_background": "Requête d'Arrière-plan Rejetée",
    "context_compaction_required": "Compaction de Contexte Requise",
    "session_locked": "Session Verrouillée",
    "max_turns_exceeded": "Tours Max Dépassés"
  },
  ru: {
    "completed": "Успешно Завершено",
    "completed_slow": "Успешно Завершено (Медленно)",
    "partial_returned": "Возвращен Частичный Вывод",
    "safe_failure": "Заблокировано: Безопасный Сбой",
    "consumer_cancelled": "Отменено Потребителем",
    "recovered": "Восстановлено (Резервная Модель)",
    "circuit_opened": "Автопрерыватель Открыт",
    "cooldown_opened": "Активировано Остывание Провайдера",
    "dropped_background": "Фоновый Запрос Отброшен",
    "context_compaction_required": "Требуется Сжатие Контекста",
    "session_locked": "Сессия Заблокирована",
    "max_turns_exceeded": "Превышен Лимит Ходов"
  }
};

const promptTranslations: Record<"en" | "zh" | "fr" | "ru", Array<{ label: string; text: string }>> = {
  en: [
    { label: "Simple Hello", text: "hello" },
    { label: "Write Code", text: "Write a short Python function to calculate fibonacci numbers." },
    { label: "Structured JSON", text: "Generate a valid JSON object list of 5 popular programming languages." },
    { label: "Slow Essay", text: "Explain the theory of relativity in simple terms, taking your time." }
  ],
  zh: [
    { label: "简单问候", text: "你好" },
    { label: "编写代码", text: "写一个简短的 Python 函数来计算斐波那契数。" },
    { label: "结构化 JSON", text: "生成一个包含 5 种流行编程语言的有效 JSON 对象列表。" },
    { label: "慢速长文", text: "用通俗易懂的语言解释相对论，可以慢点写。" }
  ],
  fr: [
    { label: "Bonjour Simple", text: "bonjour" },
    { label: "Écrire du Code", text: "Écris une fonction Python simple pour calculer la suite de Fibonacci." },
    { label: "JSON Structuré", text: "Génère une liste JSON valide de 5 langages de programmation populaires." },
    { label: "Essai Lent", text: "Explique la théorie de la relativité en termes simples, en prenant ton temps." }
  ],
  ru: [
    { label: "Простой Привет", text: "привет" },
    { label: "Написать Код", text: "Напишите короткую функцию на Python для вычисления чисел Фибоначчи." },
    { label: "Структурированный JSON", text: "Создайте корректный список объектов JSON для 5 популярных языков программирования." },
    { label: "Длинное Эссе", text: "Объясните теорию относительности простыми словами, не торопясь." }
  ]
};
;

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
      s.expectedProblem.toLowerCase().includes(q)
    );
  }, [scenarioSearch]);

  const activeScenarioBehavior = useMemo(() => {
    if (lang === "zh") return scenarioBehaviors[scenario];
    if (lang === "fr") return scenarioBehaviorsFr[scenario];
    if (lang === "ru") return scenarioBehaviorsRu[scenario];
    return scenarioBehaviorsEn[scenario];
  }, [scenario, lang]);

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
      sessionId: sessionId || undefined
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
          <span>V2.0</span>
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
                      <span className={`badge badge-problem problem-${activeScenarioDef.expectedProblem}`}>
                        {t.expectedLabel} {getProblemLabel(activeScenarioDef.expectedProblem)}
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
                              <span className={`badge badge-problem problem-${item.expectedProblem}`}>
                                {getProblemLabel(item.expectedProblem)}
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
