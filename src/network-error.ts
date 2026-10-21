export type NetworkErrorCode = "NETWORK_CONNECTION_CLOSED" | "NETWORK_TIMEOUT" | "NETWORK_UNAVAILABLE";

/** Inspect bounded cause chains without returning URLs, headers or payloads. */
export function networkErrorCode(error: unknown): NetworkErrorCode | undefined {
  const chain: { message?: unknown; name?: unknown; code?: unknown; cause?: unknown }[] = [];
  let current = error;
  while (current && typeof current === "object" && chain.length < 6 && !chain.includes(current)) {
    const entry = current as typeof chain[number]; chain.push(entry); current = entry.cause;
  }
  for (const entry of chain.reverse()) {
    const code = typeof entry.code === "string" ? entry.code : "";
    const message = typeof entry.message === "string" ? entry.message : "";
    if (/^(?:ECONNRESET|ECONNABORTED|EPIPE|UND_ERR_SOCKET|UND_ERR_RES_CONTENT_LENGTH_MISMATCH)$/u.test(code) || /other side closed|socket hang up|premature close|^terminated$/iu.test(message)) return "NETWORK_CONNECTION_CLOSED";
    if (/^(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/u.test(code) || entry.name === "TimeoutError") return "NETWORK_TIMEOUT";
    if (/^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/u.test(code) || /^fetch failed$/iu.test(message)) return "NETWORK_UNAVAILABLE";
  }
  return undefined;
}

export function networkErrorMessage(code: NetworkErrorCode): string {
  if (code === "NETWORK_CONNECTION_CLOSED") return "Сервер прервал соединение до получения полного ответа. Повторите запрос немного позже.";
  if (code === "NETWORK_TIMEOUT") return "Сервер не ответил вовремя. Проверьте его доступность и повторите запрос.";
  return "Не удалось связаться с сервером. Проверьте подключение и доступность сервиса.";
}
