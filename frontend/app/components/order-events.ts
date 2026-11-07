export type OrderEvent = {
  id: number;
  status: string;
  actor: string;
  reason: string;
  created_at: string;
};

export async function readOrderEvents(
  url: string,
  onEvent: (event: OrderEvent) => void,
  signal: AbortSignal,
  token: string
) {
  let lastEventId = "";
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const headers = new Headers({ Accept: "text/event-stream", Authorization: `Bearer ${token}` });
      if (lastEventId) headers.set("Last-Event-ID", lastEventId);
      const response = await fetch(url, { signal, headers });
      if (!response.ok || !response.body) {
        if (response.status < 500) throw new Error("Unable to connect to live order updates");
        throw new Error("Temporary live update service failure");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";
        for (const chunk of chunks) {
          const eventId = chunk.split("\n").find((line) => line.startsWith("id: "));
          const data = chunk.split("\n").find((line) => line.startsWith("data: "));
          if (eventId) lastEventId = eventId.slice(4);
          if (!data) continue;
          try {
            onEvent(JSON.parse(data.slice(6)) as OrderEvent);
            attempt = 0;
          } catch {
            throw new Error("The live order update was malformed");
          }
        }
      }
      attempt += 1;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof Error &&
          (error.message === "Unable to connect to live order updates" ||
           error.message === "The live order update was malformed")) {
        throw error;
      }
      attempt += 1;
    }
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(500 * (2 ** attempt), 10000) + Math.random() * 250));
  }
}

export function customerStatus(status: string) {
  const mapping: Record<string, { label: string; tone: string }> = {
    PENDING_PAYMENT: { label: "รอชำระเงิน", tone: "waiting" },
    PAID: { label: "ชำระเงินแล้ว", tone: "progress" },
    IN_QUEUE: { label: "อยู่ในคิว", tone: "progress" },
    IN_PROGRESS: { label: "กำลังเติมเกม", tone: "progress" },
    COMPLETED: { label: "เติมสำเร็จ", tone: "success" },
    EXPIRED: { label: "หมดเวลาชำระ", tone: "muted" },
    PAYMENT_FAILED: { label: "ชำระไม่สำเร็จ", tone: "danger" },
    FAILED: { label: "ต้องติดต่อทีมงาน", tone: "danger" },
    REFUNDED: { label: "คืนเงินแล้ว", tone: "muted" },
    NEEDS_REVIEW: { label: "กำลังตรวจสอบ", tone: "warning" }
  };
  return mapping[status] || { label: status, tone: "muted" };
}
