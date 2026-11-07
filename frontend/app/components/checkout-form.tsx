"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { readOrderEvents, type OrderEvent, customerStatus } from "./order-events";

type Product = { sku: string; name: string; price_satang: number; stock: number; max_per_order: number };
type Quote = {
  subtotalSatang: number;
  discountSatang: number;
  feeSatang: number;
  vatSatang: number;
  totalSatang: number;
};
type Order = {
  id: string;
  productName: string;
  totalSatang: number;
  status: string;
  trackingToken: string;
};
type Problem = { detail?: string; code?: string };

const apiUrl = "";
const paymentUrl = "/mock-pay";

function formatBaht(satang: number | bigint) {
  const amount = typeof satang === "bigint" ? satang : BigInt(satang);
  return `฿${(amount / 100n).toLocaleString("th-TH")}.${String(amount % 100n).padStart(2, "0")}`;
}

export default function CheckoutForm({ sku }: { sku: string }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [email, setEmail] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [discountCode, setDiscountCode] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("promptpay");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [validationAttempted, setValidationAttempted] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/api/v1/products/${encodeURIComponent(sku)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("ไม่พบสินค้าที่เลือก");
        setProduct(await response.json() as Product);
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setProblem(error.message);
      });
    return () => controller.abort();
  }, [sku]);

  useEffect(() => {
    if (!product) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setQuote(null);
      try {
        const response = await fetch(`${apiUrl}/api/v1/orders/quote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sku,
            quantity,
            email: email || "quote@example.com",
            playerId: playerId || "quote",
            discountCode,
            paymentMethod
          }),
          signal: controller.signal
        });
        const body = await response.json() as Quote & Problem;
        if (!response.ok) throw new Error(body.detail || "คำนวณราคาไม่สำเร็จ");
        setQuote(body);
        setProblem("");
      } catch (error) {
        if (error instanceof Error && error.name !== "AbortError") setProblem(error.message);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [product, sku, quantity, email, playerId, discountCode, paymentMethod]);

  const orderId = order?.id;
  const trackingToken = order?.trackingToken;
  useEffect(() => {
    if (!orderId || !trackingToken) return;
    const controller = new AbortController();
    const url = `${apiUrl}/api/v1/orders/${encodeURIComponent(orderId)}/events`;
    readOrderEvents(url, (event) => {
      setEvents((previous) => previous.some((item) => item.id === event.id) ? previous : [...previous, event]);
      setOrder((current) => current ? { ...current, status: event.status } : current);
    }, controller.signal, trackingToken).catch((error: Error) => {
      if (error.name !== "AbortError") setProblem(error.message);
    });
    return () => controller.abort();
  }, [orderId, trackingToken]);

  const errors = useMemo(() => ({
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? "กรอกอีเมลให้ถูกต้อง" : "",
    playerId: !/^[A-Za-z0-9._-]{3,100}$/.test(playerId.trim()) ? "UID ต้องยาว 3–100 ตัวอักษร" : "",
    quantity: product && quantity > product.max_per_order ? `ซื้อได้สูงสุด ${product.max_per_order} ชิ้นต่อรายการ` : ""
  }), [email, playerId, product, quantity]);

  async function createOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationAttempted(true);
    if (errors.email || errors.playerId || errors.quantity || !quote) return;
    if (!sku) {
      setProblem("กรุณาเลือกสินค้าก่อน");
      return;
    }
    setBusy(true);
    setProblem("");
    try {
      const response = await fetch(`${apiUrl}/api/v1/orders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({ sku, quantity, email, playerId, discountCode, paymentMethod })
      });
      const body = await response.json() as Order & Problem;
      if (!response.ok) throw new Error(body.detail || "สร้างคำสั่งซื้อไม่สำเร็จ");
      setOrder(body);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "ไม่สามารถเชื่อมต่อระบบได้");
    } finally {
      setBusy(false);
    }
  }

  async function simulatePayment(mode: string) {
    if (!order) return;
    setPaymentBusy(true);
    setProblem("");
    try {
      const response = await fetch(`${paymentUrl}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: order.id,
          amountSatang: order.totalSatang,
          method: paymentMethod,
          mode
        })
      });
      const body = await response.json() as Problem;
      if (!response.ok) throw new Error(body.detail || "ส่งคำสั่งชำระเงินไม่สำเร็จ");
      setProblem(mode === "delayed"
        ? "จำลองส่ง webhook ล่าช้า 60 วินาทีแล้ว"
        : "ส่งผลการชำระเงินแล้ว กำลังรอการยืนยันจากระบบ");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "บริการชำระเงินไม่พร้อมใช้งาน");
    } finally {
      setPaymentBusy(false);
    }
  }

  if (!product && !problem) {
    return <main className="page-shell"><div className="empty-state" role="status">กำลังโหลดสินค้า…</div></main>;
  }
  if (!product) {
    return <main className="page-shell"><div className="notice notice-error" role="alert">{problem}</div><Link href="/th">กลับไปหน้าร้าน</Link></main>;
  }

  return (
    <main className="page-shell checkout-layout">
      <div className="checkout-back"><Link href="/th">← กลับไปหน้าร้าน</Link></div>
      <section className="checkout-panel">
        <div className="panel-heading">
          <p className="eyebrow">SECURE CHECKOUT</p>
          <h1>{order ? "คำสั่งซื้อของคุณ" : "ยืนยันแพ็กของคุณ"}</h1>
          <p>กรอกข้อมูลสำหรับจัดส่งไอเทมและรับใบเสร็จ</p>
        </div>
        <div className="checkout-product">
          <div className="product-mini-symbol" aria-hidden="true">✦</div>
          <div><span>{product.sku}</span><strong>{product.name}</strong></div>
          <b>{formatBaht(product.price_satang)}</b>
        </div>

        {!order ? (
          <form className="checkout-form" onSubmit={createOrder} noValidate>
            <label className="field-label" htmlFor="email">อีเมลรับใบเสร็จ</label>
            <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={Boolean(validationAttempted && errors.email)} aria-describedby={validationAttempted && errors.email ? "email-error" : undefined} required />
            {validationAttempted && errors.email && <span className="field-error" id="email-error">{errors.email}</span>}

            <label className="field-label" htmlFor="player-id">Game UID</label>
            <input id="player-id" value={playerId} onChange={(event) => setPlayerId(event.target.value)} aria-invalid={Boolean(validationAttempted && errors.playerId)} aria-describedby={validationAttempted && errors.playerId ? "player-id-error" : undefined} required />
            {validationAttempted && errors.playerId && <span className="field-error" id="player-id-error">{errors.playerId}</span>}

            <div className="form-row">
              <div>
                <label className="field-label" htmlFor="quantity">จำนวน</label>
                <input id="quantity" type="number" min={1} max={product.max_per_order} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} aria-invalid={Boolean(validationAttempted && errors.quantity)} aria-describedby={validationAttempted && errors.quantity ? "quantity-error" : undefined} />
                {validationAttempted && errors.quantity && <span className="field-error" id="quantity-error">{errors.quantity}</span>}
              </div>
              <div>
                <label className="field-label" htmlFor="discount">โค้ดส่วนลด</label>
                <input id="discount" value={discountCode} onChange={(event) => setDiscountCode(event.target.value.toUpperCase())} placeholder="เช่น SAVE10" />
              </div>
            </div>

            <fieldset className="payment-options">
              <legend className="field-label">ช่องทางชำระเงิน</legend>
              {[
                ["promptpay", "PromptPay", "ไม่มีค่าธรรมเนียม"],
                ["truemoney", "TrueMoney Wallet", "ค่าธรรมเนียม 1.5%"],
                ["card", "Credit Card", "ค่าธรรมเนียม 2.9% + ฿3"]
              ].map(([value, name, detail]) => (
                <label className={`payment-option ${paymentMethod === value ? "selected" : ""}`} key={value}>
                  <input type="radio" name="payment" value={value} checked={paymentMethod === value} onChange={() => setPaymentMethod(value)} />
                  <span><strong>{name}</strong><small>{detail}</small></span>
                  <span className="radio-dot" />
                </label>
              ))}
            </fieldset>

            <div className="price-breakdown" aria-live="polite">
              <div><span>ยอดสินค้า</span><span>{formatBaht(quote?.subtotalSatang ?? BigInt(product.price_satang) * BigInt(quantity))}</span></div>
              <div><span>ส่วนลด</span><span>−{formatBaht(quote?.discountSatang ?? 0)}</span></div>
              <div><span>ค่าธรรมเนียม</span><span>{formatBaht(quote?.feeSatang ?? 0)}</span></div>
              <div className="price-total"><strong>ยอดชำระรวม</strong><strong>{formatBaht(quote?.totalSatang ?? BigInt(product.price_satang) * BigInt(quantity))}</strong></div>
            </div>
            {problem && <div className="notice notice-error" role="alert">{problem}</div>}
            <button className="button button-primary button-wide" type="submit" disabled={busy || !quote}>
              {busy ? "กำลังสร้างรายการ…" : "ดำเนินการชำระเงิน"}
            </button>
            <p className="form-footnote">ราคาทั้งหมดเป็นบาทและรวม VAT แล้ว</p>
          </form>
        ) : (
          <div className="order-ready">
            <div className="order-id-block">
              <span>หมายเลขคำสั่งซื้อ</span>
              <strong>{order.id}</strong>
              <span className={`status-badge status-${customerStatus(order.status).tone}`} aria-live="polite">
                {customerStatus(order.status).label}
              </span>
            </div>
            <div className="payment-simulator">
              <h2>จำลองการชำระเงิน</h2>
              <p>เลือกผลการชำระเพื่อทดสอบ webhook และการติดตามสถานะ</p>
              <button className="button button-primary button-wide" onClick={() => simulatePayment("success")} disabled={paymentBusy}>จ่ายสำเร็จ</button>
              <button className="button button-secondary button-wide" onClick={() => simulatePayment("failure")} disabled={paymentBusy}>จ่ายไม่สำเร็จ</button>
              <details className="advanced-sim">
                <summary>กรณีทดสอบเพิ่มเติม</summary>
                <button className="button button-secondary button-wide" onClick={() => simulatePayment("duplicate")} disabled={paymentBusy}>ส่ง webhook ซ้ำ 5 ครั้ง</button>
                <button className="button button-secondary button-wide" onClick={() => simulatePayment("delayed")} disabled={paymentBusy}>ส่ง webhook ช้า 60 วินาที</button>
                <button className="button button-secondary button-wide" onClick={() => simulatePayment("mismatch")} disabled={paymentBusy}>ยอดชำระไม่ตรง</button>
              </details>
            </div>
            {problem && <div className="notice" role="status">{problem}</div>}
            <div className="timeline" aria-live="polite">
              <h2>สถานะคำสั่งซื้อ</h2>
              {events.map((event) => (
                <div className="timeline-item" key={event.id}>
                  <span className="timeline-dot" />
                  <div><strong>{customerStatus(event.status).label}</strong><p>{event.reason}</p><time>{new Date(event.created_at).toLocaleString("th-TH")}</time></div>
                </div>
              ))}
            </div>
            <Link href={`/tracking?id=${encodeURIComponent(order.id)}`} className="text-link">ติดตามคำสั่งซื้อนี้</Link>
          </div>
        )}
      </section>
    </main>
  );
}
