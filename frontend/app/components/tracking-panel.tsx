"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { customerStatus, readOrderEvents, type OrderEvent } from "./order-events";

type TrackedOrder = {
  id: string;
  productName: string;
  quantity: number;
  totalSatang: number;
  status: string;
};
type TrackingResponse = { order: TrackedOrder; trackingToken: string };
type Problem = { detail?: string };

const apiUrl = "";

function isValidOrderId(id: string) {
  const match = /^ORD-(\d{13})-(\d{3})$/.exec(id.trim());
  return Boolean(match && String(Number(match[1]) % 997).padStart(3, "0") === match[2]);
}

function formatBaht(satang: number) {
  const amount = BigInt(satang);
  return `฿${(amount / 100n).toLocaleString("th-TH")}.${String(amount % 100n).padStart(2, "0")}`;
}

export default function TrackingPanel({ initialId }: { initialId: string }) {
  const [id, setId] = useState(initialId);
  const [email, setEmail] = useState("");
  const [tracking, setTracking] = useState<TrackingResponse | null>(null);
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const trackedId = tracking?.order.id;
  const trackingToken = tracking?.trackingToken;
  useEffect(() => {
    if (!trackedId || !trackingToken) return;
    const controller = new AbortController();
    const url = `${apiUrl}/api/v1/orders/${encodeURIComponent(trackedId)}/events`;
    readOrderEvents(url, (event) => {
      setEvents((previous) => previous.some((item) => item.id === event.id) ? previous : [...previous, event]);
      setTracking((current) => current
        ? { ...current, order: { ...current.order, status: event.status } }
        : current);
    }, controller.signal, trackingToken).catch((cause: Error) => {
      if (cause.name !== "AbortError") setError(cause.message);
    });
    return () => controller.abort();
  }, [trackedId, trackingToken]);

  async function trackOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setTracking(null);
    setEvents([]);
    if (!isValidOrderId(id)) {
      setError("เลขคำสั่งซื้อไม่ถูกต้อง กรุณาตรวจสอบรูปแบบและ checksum");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiUrl}/api/v1/orders/track`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order_id: id.trim(), email: email.trim() })
      });
      const body = await response.json() as TrackingResponse & Problem;
      if (!response.ok) throw new Error(body.detail || "ไม่พบคำสั่งซื้อหรืออีเมลไม่ตรงกัน");
      setTracking(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ไม่สามารถเชื่อมต่อระบบได้");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-shell tracking-layout">
      <Link className="back-link" href="/th">← กลับไปหน้าร้าน</Link>
      <section className="tracking-panel">
        <div className="panel-heading">
          <p className="eyebrow">ORDER TRACKING</p>
          <h1>ติดตามคำสั่งซื้อ</h1>
          <p>กรอกเลขคำสั่งซื้อและอีเมลที่ใช้ซื้อ เราจะอัปเดตสถานะแบบเรียลไทม์</p>
        </div>
        <form className="tracking-form" onSubmit={trackOrder} noValidate>
          <label className="field-label" htmlFor="order-id">เลขคำสั่งซื้อ</label>
          <input id="order-id" value={id} onChange={(event) => setId(event.target.value)} placeholder="ORD-2587965432159-229" aria-describedby="order-id-hint" required />
          <span className="field-hint" id="order-id-hint">รูปแบบ ORD-XXXXXXXXXXXXX-CCC พร้อม checksum ที่ถูกต้อง</span>
          <label className="field-label" htmlFor="tracking-email">อีเมลที่ใช้สั่งซื้อ</label>
          <input id="tracking-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <button className="button button-primary button-wide" type="submit" disabled={busy}>
            {busy ? "กำลังค้นหา…" : "ค้นหาคำสั่งซื้อ"}
          </button>
        </form>

        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {tracking && (
          <section className="tracking-result" aria-live="polite">
            <div className="tracking-order-card">
              <span className="field-hint">คำสั่งซื้อ {tracking.order.id}</span>
              <h2>{tracking.order.productName} <span>× {tracking.order.quantity}</span></h2>
              <div className="tracking-order-meta">
                <strong>{formatBaht(tracking.order.totalSatang)}</strong>
                <span className={`status-badge status-${customerStatus(tracking.order.status).tone}`}>{customerStatus(tracking.order.status).label}</span>
              </div>
            </div>
            <div className="timeline">
              <div className="timeline-heading"><h2>ความคืบหน้า</h2><span className="live-indicator"><i /> LIVE</span></div>
              {events.length === 0 && <p className="field-hint">กำลังรอสถานะจากระบบ…</p>}
              {events.map((event) => (
                <div className="timeline-item" key={event.id}>
                  <span className="timeline-dot" />
                  <div>
                    <strong>{customerStatus(event.status).label}</strong>
                    <p>{event.reason}</p>
                    <time>{new Date(event.created_at).toLocaleString("th-TH")}</time>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
