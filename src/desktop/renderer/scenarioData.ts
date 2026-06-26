import type { ScenarioName } from "../../shared/types.js";

export interface ScenarioBehavior {
  server: string;
  client: string;
}

export const scenarioBehaviors: Record<ScenarioName, ScenarioBehavior> = {
  "normal": {
    server: "无故障。正常发送完整流式响应。",
    client: "正常消费所有 chunk，累积文本，报告成功。"
  },
  "slow": {
    server: "将 chunk 间隔从 5ms 提升到 150ms，模拟 provider 响应缓慢。",
    client: "用 wall/idle timeout 区分「正常慢」和「需要中止的超时」。在预算内允许慢流完成；超出则 abort。"
  },
  "rate-limit-retry-after": {
    server: "返回 HTTP 429 + retry-after: 1，模拟 provider 限流。每次请求都返回 429，不释放。",
    client: "解析 retry-after header，在首 token 前安全窗口内有限重试，耗尽后返回 exhausted。"
  },
  "overloaded-retry-after": {
    server: "返回 HTTP 529 + retry-after: 1，模拟 provider 过载。",
    client: "将 529 归类为 overloaded，重试逻辑与限流场景一致。"
  },
  "server-error": {
    server: "返回 HTTP 500，无 retry-after header，模拟通用服务端崩溃。",
    client: "归类为 server_error，走本地指数退避 + jitter 重试，不记录 honored_retry_after。"
  },
  "midstream-close": {
    server: "发送 2 个文本 chunk 后销毁 socket，不发送协议结束事件。模拟 provider 网络中断或进程崩溃。",
    client: "SDK 捕获连接错误，Runner 附加已累积的 partial state，策略层保留 partial text 并抑制自动重试。"
  },
  "half-sse-frame": {
    server: "写入半截 SSE 数据帧（不完整 JSON + 无分隔符）后销毁 socket。模拟 provider 崩溃时发出了不完整协议数据。",
    client: "显式安全失败：SDK 报错时 blocked_malformed_stream，SDK 返回空文本时 blocked_malformed_empty_stream。不重试。"
  },
  "silent-hang": {
    server: "发送协议起始帧后不再发送任何内容，保持连接直到客户端关闭。模拟 provider 卡死或网关保持连接。",
    client: "通过 idle timeout（无事件刷新）或 wall timeout（总时间超限）中止，归类为 idle_timeout。"
  },
  "heartbeat-only": {
    server: "只发送心跳/ping 事件，不发文本增量。模拟 provider 连接存活但模型未开始生成。",
    client: "不将心跳当作业务文本。若 SDK 暴露心跳为事件则刷新 idle timer，否则不刷新。最终由超时或空文本路径终止。"
  },
  "half-tool-json": {
    server: "发送工具调用起始事件 + 不完整参数 {\"city\":\"Par 后销毁 socket。模拟 provider 在工具调用中途崩溃。",
    client: "识别半截工具 JSON 为安全底线：不执行工具，不当普通网络错误重试，直接 safe_failure。"
  },
  "flood": {
    server: "快速发送 250 个 chunk（每 5ms 一个），模拟 provider 高吞吐量输出。",
    client: "Runner 持续消费所有 chunk，验证不因高频而丢数据。未设事件预算时无背压干预。"
  },
  "bounded-queue-overflow": {
    server: "快速发送 250 个 chunk，与 flood 相同。故障不在服务端，而在客户端本地背压预算（--max-stream-events 100）。",
    client: "检测到事件数超过预算上限，主动取消消费并安全失败。背压保护优先于输出成功。"
  },
  "consumer-drop": {
    server: "故障方是消费端（用户关闭页面、UI 停止读取），不是服务端；服务端继续正常发流，取消由客户端下游触发。",
    client: "SDK runner 在 consumerDropAfterEvents 达到阈值后模拟下游取消，策略返回 consumer_cancelled 且不重试。"
  },
  "fallback-recovery": {
    server: "对 primary model 返回 529，对 fallback model 正常返回。模拟 primary provider 过载但备用可用。",
    client: "重试耗尽后检查无 partial，切换到 fallback model 重新发起请求，成功则报告 recovered。"
  },
  "circuit-breaker-open": {
    server: "持续返回 529。但熔断器的真正作用在客户端 preflight：后续请求在到达服务端前就被拦截。",
    client: "重试耗尽后打开熔断器，写入进程内 Map。后续同一 provider key 的请求在 preflight 阶段直接返回 circuit_opened。"
  },
  "provider-cooldown": {
    server: "持续返回 529。与熔断器类似，但 cooldown 语义上表示「请求速率过高需要冷却」。",
    client: "重试耗尽后打开 cooldown，后续同一 provider key 的请求在 preflight 被拦截，返回 cooldown_opened。"
  },
  "background-overloaded": {
    server: "返回 529 + retry-after: 1。故障本身与 overloaded-retry-after 相同。",
    client: "检测到优先级为 background + 错误为 overloaded，直接丢弃后台任务，不挤占前台请求的 provider 预算。"
  },
  "context-overflow": {
    server: "返回 HTTP 400 + context_length_exceeded，模拟 provider 拒绝过大的上下文。",
    client: "识别为 context_overflow，不重试（原样重试必然再次失败），要求上层先执行上下文压缩。"
  },
  "session-lock-conflict": {
    server: "无服务端故障。故障方是客户端本地状态：同一 session 已有请求在进行，并发冲突。",
    client: "preflight 检查 activeSessionLocks，发现 session 已占用，不调用 SDK Runner，直接返回 session_locked。"
  },
  "max-turns-exceeded": {
    server: "无服务端故障。故障方是客户端本地状态：Agent 循环已达到配置的最大轮次。",
    client: "preflight 检查 currentTurn > maxTurns，在进入 SDK Runner 前终止，返回 max_turns_exceeded。"
  }
};

export const scenarioBehaviorsEn: Record<ScenarioName, ScenarioBehavior> = {
  "normal": {
    server: "No fault. Server sends complete streaming response normally.",
    client: "Consumes all chunks, accumulates text, and reports success."
  },
  "slow": {
    server: "Increases chunk interval from 5ms to 150ms, simulating slow provider response.",
    client: "Uses wall/idle timeout to distinguish 'normal slow' from 'needs-abort timeout'. Allows slow stream to finish within budget; aborts when exceeded."
  },
  "rate-limit-retry-after": {
    server: "Returns HTTP 429 + retry-after: 1, simulating provider rate limiting. Every request returns 429.",
    client: "Parses retry-after header, performs limited retries in the pre-token safe window, returns exhausted when depleted."
  },
  "overloaded-retry-after": {
    server: "Returns HTTP 529 + retry-after: 1, simulating provider overload.",
    client: "Classifies 529 as overloaded, retry logic mirrors rate-limit scenario."
  },
  "server-error": {
    server: "Returns HTTP 500 without retry-after header, simulating generic server crash.",
    client: "Classifies as server_error, uses local exponential backoff + jitter retry, does not record honored_retry_after."
  },
  "midstream-close": {
    server: "Sends 2 text chunks then destroys socket without sending protocol end event. Simulates provider network interruption or process crash.",
    client: "SDK captures connection error, Runner attaches accumulated partial state, policy preserves partial text and suppresses auto-retry."
  },
  "half-sse-frame": {
    server: "Writes incomplete SSE data frame (truncated JSON + no delimiter) then destroys socket. Simulates incomplete protocol data from provider crash.",
    client: "Explicit safe failure: blocked_malformed_stream when SDK errors, blocked_malformed_empty_stream when SDK returns empty text. No retry."
  },
  "silent-hang": {
    server: "Sends protocol start frame then stops sending anything, keeping connection until client closes. Simulates provider freeze or gateway holding connection.",
    client: "Aborts via idle timeout (no event refresh) or wall timeout (total time exceeded), classified as idle_timeout."
  },
  "heartbeat-only": {
    server: "Only sends heartbeat/ping events, no text deltas. Simulates live connection but model has not started generating.",
    client: "Does not treat heartbeats as business text. Refreshes idle timer only if SDK exposes heartbeats as events. Terminates via timeout or empty text path."
  },
  "half-tool-json": {
    server: "Sends tool call start event + incomplete parameter {\"city\":\"Par then destroys socket. Simulates provider crash mid-tool-call.",
    client: "Identifies truncated tool JSON as safety baseline: does not execute tool, does not retry as generic network error, direct safe_failure."
  },
  "flood": {
    server: "Rapidly sends 250 chunks (one every 5ms), simulating high-throughput provider output.",
    client: "Runner continuously consumes all chunks, verifying no data loss from high frequency. No backpressure when no event budget is set."
  },
  "bounded-queue-overflow": {
    server: "Rapidly sends 250 chunks, same as flood. Fault is not in server but in client-side backpressure budget (--max-stream-events 100).",
    client: "Detects event count exceeds budget limit, proactively cancels consumption and fails safely. Backpressure protection takes priority over output success."
  },
  "consumer-drop": {
    server: "Fault is the consumer (user closes page, UI stops reading), not the server; the server keeps streaming normally and client-side downstream cancellation triggers the abort.",
    client: "SDK runner simulates downstream cancellation after consumerDropAfterEvents, policy returns consumer_cancelled and does not retry."
  },
  "fallback-recovery": {
    server: "Returns 529 for primary model, normal for fallback model. Simulates primary provider overload with backup available.",
    client: "After retry exhaustion, checks no partial exists, switches to fallback model and re-issues request, reports recovered on success."
  },
  "circuit-breaker-open": {
    server: "Persistently returns 529. But the circuit breaker's real role is client-side preflight: subsequent requests are blocked before reaching the server.",
    client: "Opens circuit breaker after retry exhaustion, writes to in-process Map. Subsequent requests for the same provider key return circuit_opened at preflight."
  },
  "provider-cooldown": {
    server: "Persistently returns 529. Similar to circuit breaker but cooldown semantically means 'request rate too high, needs cooling'.",
    client: "Opens cooldown after retry exhaustion. Subsequent requests for the same provider key are blocked at preflight, returning cooldown_opened."
  },
  "background-overloaded": {
    server: "Returns 529 + retry-after: 1. Fault is identical to overloaded-retry-after.",
    client: "Detects background priority + overloaded error, discards background task immediately to preserve foreground request provider budget."
  },
  "context-overflow": {
    server: "Returns HTTP 400 + context_length_exceeded, simulating provider rejecting oversized context.",
    client: "Identifies as context_overflow, does not retry (same retry would fail again), requires upstream context compaction."
  },
  "session-lock-conflict": {
    server: "No server fault. Fault is client-side local state: same session already has an active request, concurrent conflict.",
    client: "preflight checks activeSessionLocks, finds session occupied, does not call SDK Runner, returns session_locked directly."
  },
  "max-turns-exceeded": {
    server: "No server fault. Fault is client-side local state: Agent loop has reached the configured maximum turns.",
    client: "preflight checks currentTurn > maxTurns, terminates before entering SDK Runner, returns max_turns_exceeded."
  }
};

export const scenarioBehaviorsFr: Record<ScenarioName, ScenarioBehavior> = {
  "normal": {
    server: "Aucune faute. Le serveur envoie une réponse en streaming complète normalement.",
    client: "Consomme tous les fragments, accumule le texte et signale le succès."
  },
  "slow": {
    server: "Augmente l'intervalle entre fragments de 5ms à 150ms, simulant une réponse lente du fournisseur.",
    client: "Utilise les timeouts wall/idle pour distinguer « lenteur normale » et « timeout nécessitant un arrêt ». Permet au flux lent de finir dans le budget ; sinon abort."
  },
  "rate-limit-retry-after": {
    server: "Renvoie HTTP 429 + retry-after: 1, simulant une limitation de débit. Chaque requête renvoie 429.",
    client: "Analyse l'en-tête retry-after, effectue des tentatives limitées dans la fenêtre sûre avant le premier token, renvoie exhausted une fois épuisé."
  },
  "overloaded-retry-after": {
    server: "Renvoie HTTP 529 + retry-after: 1, simulant une surcharge du fournisseur.",
    client: "Classifie 529 comme overloaded, la logique de tentative reproduit le scénario de limitation de débit."
  },
  "server-error": {
    server: "Renvoie HTTP 500 sans en-tête retry-after, simulant un crash serveur générique.",
    client: "Classifie comme server_error, utilise une tentative locale à repli exponentiel + jitter, n'enregistre pas honored_retry_after."
  },
  "midstream-close": {
    server: "Envoie 2 fragments de texte puis détruit le socket sans envoyer d'événement de fin de protocole. Simule une interruption réseau ou un crash du fournisseur.",
    client: "Le SDK capture l'erreur de connexion, le Runner attache l'état partiel accumulé, la stratégie préserve le texte partiel et supprime les tentatives automatiques."
  },
  "half-sse-frame": {
    server: "Écrit une trame SSE incomplète (JSON tronqué + aucun séparateur) puis détruit le socket. Simule des données de protocole incomplètes d'un crash du fournisseur.",
    client: "Échec sûr explicite : blocked_malformed_stream quand le SDK signale une erreur, blocked_malformed_empty_stream quand le SDK renvoie un texte vide. Aucune tentative."
  },
  "silent-hang": {
    server: "Envoie la trame de départ du protocole puis n'envoie plus rien, gardant la connexion jusqu'à la fermeture par le client. Simule un gel du fournisseur ou une passerelle maintenant la connexion.",
    client: "Annule via idle timeout (aucun rafraîchissement d'événement) ou wall timeout (temps total dépassé), classifié comme idle_timeout."
  },
  "heartbeat-only": {
    server: "Envoie uniquement des événements heartbeat/ping, aucun delta de texte. Simule une connexion vivante mais le modèle n'a pas commencé à générer.",
    client: "Ne traite pas les heartbeats comme du texte métier. Rafraîchit le timer idle seulement si le SDK expose les heartbeats comme événements. Termine par timeout ou chemin texte vide."
  },
  "half-tool-json": {
    server: "Envoie l'événement de début d'appel d'outil + paramètre incomplet {\"city\":\"Par puis détruit le socket. Simule un crash du fournisseur en plein appel d'outil.",
    client: "Identifie le JSON d'outil tronqué comme limite de sécurité : n'exécute pas l'outil, ne tente pas comme erreur réseau générique, safe_failure directe."
  },
  "flood": {
    server: "Envoie rapidement 250 fragments (un toutes les 5ms), simulant un débit élevé du fournisseur.",
    client: "Le Runner consomme tous les fragments en continu, vérifiant l'absence de perte de données. Aucune contre-pression sans budget d'événements."
  },
  "bounded-queue-overflow": {
    server: "Envoie rapidement 250 fragments, identique à flood. La faute n'est pas côté serveur mais dans le budget de contre-pression client (--max-stream-events 100).",
    client: "Détecte que le nombre d'événements dépasse la limite du budget, annule proactivement la consommation et échoue en sécurité. La protection contre-pression prime sur le succès de la sortie."
  },
  "consumer-drop": {
    server: "La faute est le consommateur (utilisateur ferme la page, l'UI arrête de lire), pas le serveur ; le serveur continue le flux et l'annulation aval côté client déclenche l'abort.",
    client: "Le runner SDK simule l'annulation aval après consumerDropAfterEvents ; la stratégie renvoie consumer_cancelled sans retry."
  },
  "fallback-recovery": {
    server: "Renvoie 529 pour le modèle principal, normal pour le modèle de secours. Simule la surcharge du fournisseur principal avec une sauvegarde disponible.",
    client: "Après épuisement des tentatives, vérifie qu'il n'y a pas de partiel, bascule vers le modèle de secours et relance la requête, signale recovered en cas de succès."
  },
  "circuit-breaker-open": {
    server: "Renvoie systématiquement 529. Mais le vrai rôle du disjoncteur est le preflight côté client : les requêtes ultérieures sont bloquées avant d'atteindre le serveur.",
    client: "Ouvre le disjoncteur après épuisement des tentatives, écrit dans la Map du processus. Les requêtes ultérieures pour la même clé fournisseur renvoient circuit_opened au preflight."
  },
  "provider-cooldown": {
    server: "Renvoie systématiquement 529. Similaire au disjoncteur mais le cooldown signifie sémantiquement « taux de requêtes trop élevé, nécessite un refroidissement ».",
    client: "Ouvre le cooldown après épuisement des tentatives. Les requêtes ultérieures pour la même clé fournisseur sont bloquées au preflight, renvoyant cooldown_opened."
  },
  "background-overloaded": {
    server: "Renvoie 529 + retry-after: 1. La faute est identique à overloaded-retry-after.",
    client: "Détecte la priorité arrière-plan + erreur overloaded, abandonne la tâche d'arrière-plan immédiatement pour préserver le budget fournisseur des requêtes d'avant-plan."
  },
  "context-overflow": {
    server: "Renvoie HTTP 400 + context_length_exceeded, simulant le fournisseur rejetant un contexte trop volumineux.",
    client: "Identifie comme context_overflow, ne tente pas (la même tentative échouerait à nouveau), nécessite une compaction de contexte en amont."
  },
  "session-lock-conflict": {
    server: "Aucune faute serveur. La faute est l'état local côté client : la même session a déjà une requête active, conflit concurrent.",
    client: "Le preflight vérifie activeSessionLocks, trouve la session occupée, n'appelle pas le Runner SDK, renvoie directement session_locked."
  },
  "max-turns-exceeded": {
    server: "Aucune faute serveur. La faute est l'état local côté client : la boucle Agent a atteint le nombre maximum de tours configuré.",
    client: "Le preflight vérifie currentTurn > maxTurns, termine avant d'entrer dans le Runner SDK, renvoie max_turns_exceeded."
  }
};

export const scenarioBehaviorsRu: Record<ScenarioName, ScenarioBehavior> = {
  "normal": {
    server: "Нет неисправности. Сервер нормально отправляет полный потоковый ответ.",
    client: "Потребляет все фрагменты, накапливает текст и сообщает об успехе."
  },
  "slow": {
    server: "Увеличивает интервал между фрагментами с 5мс до 150мс, имитируя медленный ответ провайдера.",
    client: "Использует wall/idle тайм-аут для различения «нормально медленно» и «требуется прерывание». Позволяет медленному потоку завершиться в бюджете; при превышении — abort."
  },
  "rate-limit-retry-after": {
    server: "Возвращает HTTP 429 + retry-after: 1, имитируя ограничение скорости провайдера. Каждый запрос возвращает 429.",
    client: "Разбирает заголовок retry-after, выполняет ограниченные попытки в безопасном окне до первого токена, возвращает exhausted при исчерпании."
  },
  "overloaded-retry-after": {
    server: "Возвращает HTTP 529 + retry-after: 1, имитируя перегрузку провайдера.",
    client: "Классифицирует 529 как overloaded, логика повторения аналогична сценарию ограничения скорости."
  },
  "server-error": {
    server: "Возвращает HTTP 500 без заголовка retry-after, имитируя общий сбой сервера.",
    client: "Классифицирует как server_error, использует локальный экспоненциальный откат + jitter повтор, не записывает honored_retry_after."
  },
  "midstream-close": {
    server: "Отправляет 2 текстовых фрагмента, затем уничтожает сокет без отправки завершающего события протокола. Имитирует прерывание сети или сбой процесса провайдера.",
    client: "SDK фиксирует ошибку соединения, Runner прикрепляет накопленное частичное состояние, стратегия сохраняет частичный текст и подавляет автоповтор."
  },
  "half-sse-frame": {
    server: "Записывает неполный кадр SSE (усечённый JSON + без разделителя) и уничтожает сокет. Имитирует неполные данные протокола при сбое провайдера.",
    client: "Явный безопасный отказ: blocked_malformed_stream при ошибке SDK, blocked_malformed_empty_stream при пустом тексте SDK. Повторы не выполняются."
  },
  "silent-hang": {
    server: "Отправляет начальное событие протокола, затем прекращает отправку, сохраняя соединение до закрытия клиентом. Имитирует зависание провайдера или шлюз, удерживающий соединение.",
    client: "Прерывает через idle timeout (нет обновления событий) или wall timeout (превышено общее время), классифицируется как idle_timeout."
  },
  "heartbeat-only": {
    server: "Отправляет только события heartbeat/ping без текстовых инкрементов. Имитирует живое соединение, но модель не начала генерацию.",
    client: "Не считает heartbeat-события бизнес-текстом. Обновляет idle-таймер только если SDK экспонирует heartbeat как события. Завершается через тайм-аут или путь пустого текста."
  },
  "half-tool-json": {
    server: "Отправляет начальное событие вызова инструмента + неполное содержимое параметра и уничтожает сокет. Имитирует сбой провайдера во время вызова инструмента.",
    client: "Определяет усечённый JSON инструмента как границу безопасности: не выполняет инструмент, не повторяет как общую сетевую ошибку, прямой safe_failure."
  },
  "flood": {
    server: "Быстро отправляет 250 фрагментов (один каждые 5мс), имитируя высокую пропускную способность провайдера.",
    client: "Runner непрерывно потребляет все фрагменты, проверяя отсутствие потерь данных. Нет обратного давления без установленного бюджета событий."
  },
  "bounded-queue-overflow": {
    server: "Быстро отправляет 250 фрагментов, как и flood. Неисправность не на сервере, а в клиентском бюджете обратного давления (--max-stream-events 100).",
    client: "Обнаруживает превышение лимита бюджета событий, проактивно отменяет потребление и безопасно отказывает. Защита от перегрузки приоритетнее успеха вывода."
  },
  "consumer-drop": {
    server: "Неисправность — потребитель (пользователь закрывает страницу, UI перестаёт читать), не сервер; сервер продолжает поток, а downstream-отмена на стороне клиента вызывает abort.",
    client: "SDK runner имитирует downstream-отмену после consumerDropAfterEvents; policy возвращает consumer_cancelled без retry."
  },
  "fallback-recovery": {
    server: "Возвращает 529 для основной модели, нормально для резервной. Имитирует перегрузку основного провайдера при доступном резерве.",
    client: "После исчерпания повторов проверяет отсутствие частичного вывода, переключается на резервную модель и повторно отправляет запрос, при успехе сообщает recovered."
  },
  "circuit-breaker-open": {
    server: "Постоянно возвращает 529. Но настоящая роль предохранителя — preflight на стороне клиента: последующие запросы блокируются до достижения сервера.",
    client: "Открывает предохранитель после исчерпания повторов, записывает в Map процесса. Последующие запросы для того же ключа провайдера возвращают circuit_opened на этапе preflight."
  },
  "provider-cooldown": {
    server: "Постоянно возвращает 529. Аналогично предохранителю, но cooldown семантически означает «слишком высокая скорость запросов, требуется охлаждение».",
    client: "Открывает cooldown после исчерпания повторов. Последующие запросы для того же ключа провайдера блокируются на preflight, возвращая cooldown_opened."
  },
  "background-overloaded": {
    server: "Возвращает 529 + retry-after: 1. Неисправность идентична overloaded-retry-after.",
    client: "Обнаруживает фоновый приоритет + ошибку overloaded, немедленно отбрасывает фоновую задачу для сохранения бюджета провайдера запросов переднего плана."
  },
  "context-overflow": {
    server: "Возвращает HTTP 400 + context_length_exceeded, имитируя отклонение провайдером слишком большого контекста.",
    client: "Определяет как context_overflow, не повторяет (повторный запрос снова потерпит неудачу), требует сжатия контекста на верхнем уровне."
  },
  "session-lock-conflict": {
    server: "Нет неисправности сервера. Неисправность — локальное состояние клиента: в той же сессии уже есть активный запрос, конфликт параллелизма.",
    client: "preflight проверяет activeSessionLocks, обнаруживает занятую сессию, не вызывает SDK Runner, напрямую возвращает session_locked."
  },
  "max-turns-exceeded": {
    server: "Нет неисправности сервера. Неисправность — локальное состояние клиента: цикл Agent достиг настроенного максимального числа оборотов.",
    client: "preflight проверяет currentTurn > maxTurns, завершает до входа в SDK Runner, возвращает max_turns_exceeded."
  }
};

export const translations = {
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

export const categoryTranslations: Record<"en" | "zh" | "fr" | "ru", Record<string, string>> = {
  en: {
    baseline: "Baseline & Normal",
    "pre-token": "Pre-Token Errors",
    "stream-interruption": "Stream Interruption",
    "consumer-cancellation": "Consumer Cancellation",
    malformed: "Malformed Frames",
    "hung-stream": "Hung Streams & Heartbeats",
    "tool-call": "Incomplete Tool Calls",
    backpressure: "Backpressure & Queue Overflow",
    "agent-safety": "Agent Self-Protection"
  },
  zh: {
    baseline: "基准与正常场景",
    "pre-token": "首 Token 前错误",
    "stream-interruption": "流中断",
    "consumer-cancellation": "消费者取消",
    malformed: "畸形帧",
    "hung-stream": "挂起流与心跳流",
    "tool-call": "半截工具调用",
    backpressure: "背压保护与队列溢出",
    "agent-safety": "Agent 自保场景"
  },
  fr: {
    baseline: "Base & Normal",
    "pre-token": "Erreurs Pre-Token",
    "stream-interruption": "Interruption de Flux",
    "consumer-cancellation": "Annulation Consommateur",
    malformed: "Trames Malformées",
    "hung-stream": "Flux Suspendus & Signaux de Vie",
    "tool-call": "Appels d'Outils Incomplets",
    backpressure: "Contre-Pression & File d'Attente",
    "agent-safety": "Auto-Protection de l'Agent"
  },
  ru: {
    baseline: "Базовые и Нормальные",
    "pre-token": "Ошибки до Первого Токена",
    "stream-interruption": "Прерывание Стрима",
    "consumer-cancellation": "Отмена Потребителем",
    malformed: "Повреждённые Кадры",
    "hung-stream": "Зависшие Стримы и Сердцебиения",
    "tool-call": "Незавершённые Вызовы Инструментов",
    backpressure: "Обратное Давление и Очередь",
    "agent-safety": "Самозащита Агента"
  }
};

export const categoryKeys = ["baseline", "pre-token", "stream-interruption", "consumer-cancellation", "malformed", "hung-stream", "tool-call", "backpressure", "agent-safety"] as const;

export const scenarioCategoryMap: Record<ScenarioName, typeof categoryKeys[number]> = {
  normal: "baseline",
  slow: "baseline",
  flood: "baseline",
  "rate-limit-retry-after": "pre-token",
  "overloaded-retry-after": "pre-token",
  "server-error": "pre-token",
  "midstream-close": "stream-interruption",
  "consumer-drop": "consumer-cancellation",
  "half-sse-frame": "malformed",
  "silent-hang": "hung-stream",
  "heartbeat-only": "hung-stream",
  "half-tool-json": "tool-call",
  "bounded-queue-overflow": "backpressure",
  "fallback-recovery": "agent-safety",
  "circuit-breaker-open": "agent-safety",
  "provider-cooldown": "agent-safety",
  "background-overloaded": "agent-safety",
  "context-overflow": "agent-safety",
  "session-lock-conflict": "agent-safety",
  "max-turns-exceeded": "agent-safety"
};

export const scenarioTranslations: Record<"en" | "zh" | "fr" | "ru", Record<ScenarioName, { name: string; description: string }>> = {
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
    "consumer-drop": { name: "consumer-drop", description: "client-side downstream consumer cancels after partial stream consumption" },
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
    "consumer-drop": { name: "消费者主动取消 (consumer-drop)", description: "下游消费者在部分流消费后取消；客户端主动中止 inference stream。" },
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
    "consumer-drop": { name: "consumer-drop", description: "le consommateur aval côté client annule après une consommation partielle du flux." },
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
    "consumer-drop": { name: "consumer-drop", description: "downstream-потребитель на стороне клиента отменяет после частичного чтения потока." },
    "fallback-recovery": { name: "fallback-recovery", description: "сбой основной модели перенаправляет запрос на резервную." },
    "circuit-breaker-open": { name: "circuit-breaker-open", description: "блокирует запросы при открытом автопрерывателе после серии сбоев." },
    "provider-cooldown": { name: "provider-cooldown", description: "временно блокирует обращения к провайдеру после повторных сбоев." },
    "background-overloaded": { name: "background-overloaded", description: "сбрасывает фоновые запросы при перегрузке для экономии ресурсов." },
    "context-overflow": { name: "context-overflow", description: "отклоняет запрос из-за превышения максимальной длины контекста." },
    "session-lock-conflict": { name: "session-lock-conflict", description: "блокирует параллельные запросы с одинаковым ID сессии." },
    "max-turns-exceeded": { name: "max-turns-exceeded", description: "блокирует вызов API при превышении лимита шагов maxTurns." }
  }
};

export const problemTranslations: Record<"en" | "zh" | "fr" | "ru", Record<string, string>> = {
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

export const statusTranslations: Record<"en" | "zh" | "fr" | "ru", Record<string, string>> = {
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

export const promptTranslations: Record<"en" | "zh" | "fr" | "ru", Array<{ label: string; text: string }>> = {
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
