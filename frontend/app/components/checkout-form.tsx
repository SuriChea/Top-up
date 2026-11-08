"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { readOrderEvents, type OrderEvent, customerStatus } from "./order-events";
import { localizedPath, useLocale } from "./locale";

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
  const locale = useLocale();
  const english = locale === "en";
  const router = useRouter();
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
  const [authLoading, setAuthLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/auth/me", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) return;
        if (!response.ok) throw new Error(english ? "Could not verify your sign-in" : "ตรวจสอบสถานะเข้าสู่ระบบไม่สำเร็จ");
        const body = await response.json() as { user?: { email: string } };
        if (!body.user) throw new Error(english ? "Could not verify your sign-in" : "ตรวจสอบสถานะเข้าสู่ระบบไม่สำเร็จ");
        setEmail(body.user.email);
        setSignedIn(true);
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setProblem(error.message);
      })
      .finally(() => setAuthLoading(false));
    return () => controller.abort();
  }, [english]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/api/v1/products/${encodeURIComponent(sku)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(english ? "The selected product was not found" : "ไม่พบสินค้าที่เลือก");
        setProduct(await response.json() as Product);
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setProblem(error.message);
      });
    return () => controller.abort();
  }, [sku, english]);

  useEffect(() => {
    if (!product || !signedIn) return;
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
            email,
            playerId: playerId || "quote",
            discountCode,
            paymentMethod
          }),
          signal: controller.signal
        });
        const body = await response.json() as Quote & Problem;
        if (!response.ok) throw new Error(body.detail || (english ? "Could not calculate the price" : "คำนวณราคาไม่สำเร็จ"));
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
  }, [product, signedIn, sku, quantity, email, playerId, discountCode, paymentMethod, english]);

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
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? (english ? "Your account email is invalid" : "อีเมลบัญชีไม่ถูกต้อง") : "",
    playerId: !/^[A-Za-z0-9._-]{3,100}$/.test(playerId.trim()) ? (english ? "UID must be 3–100 characters" : "UID ต้องยาว 3–100 ตัวอักษร") : "",
    quantity: product && quantity > product.max_per_order
      ? (english ? `Maximum ${product.max_per_order} per order` : `ซื้อได้สูงสุด ${product.max_per_order} ชิ้นต่อรายการ`)
      : ""
  }), [email, playerId, product, quantity, english]);

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
      if (response.status === 401) {
        router.push(localizedPath("/login", locale));
        return;
      }
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

  if (authLoading || (!product && !problem)) {
    return <main className="page-shell"><div className="empty-state" role="status">{english ? "Loading…" : "กำลังโหลดสินค้า…"}</div></main>;
  }
  if (!signedIn && !problem) {
    return (
      <main className="page-shell">
        <section className="auth-panel">
          <p className="eyebrow">SECURE CHECKOUT</p>
          <h1>{english ? "Sign in before checkout" : "กรุณาเข้าสู่ระบบก่อนชำระเงิน"}</h1>
          <p className="muted-copy">{english ? "Sign in with your email to continue and view your purchases later." : "เข้าสู่ระบบด้วยอีเมลก่อน เพื่อดำเนินการซื้อและดูประวัติภายหลัง"}</p>
          <Link className="button button-primary button-wide" href={localizedPath("/login", locale)}>
            {english ? "Sign in to continue" : "เข้าสู่ระบบเพื่อดำเนินการต่อ"}
          </Link>
        </section>
      </main>
    );
  }
  if (!product) {
    return <main className="page-shell"><div className="notice notice-error" role="alert">{problem}</div><Link href={localizedPath("/", locale)}>{english ? "Return to shop" : "กลับไปหน้าร้าน"}</Link></main>;
  }

  return (
    <main className="page-shell checkout-layout">
      <div className="checkout-back"><Link href={localizedPath("/", locale)}>← {english ? "Back to shop" : "กลับไปหน้าร้าน"}</Link></div>
      <section className="checkout-panel">
        <div className="panel-heading">
          <p className="eyebrow">SECURE CHECKOUT</p>
          <h1>{order ? (english ? "Your order" : "คำสั่งซื้อของคุณ") : (english ? "Confirm your pack" : "ยืนยันแพ็กของคุณ")}</h1>
          <p>{english ? "Enter the game account details for delivery." : "กรอกข้อมูลสำหรับจัดส่งไอเทมและรับใบเสร็จ"}</p>
        </div>
        <div className="checkout-product">
          <div className="product-mini-symbol" aria-hidden="true">✦</div>
          <div><span>{product.sku}</span><strong>{product.name}</strong></div>
          <b>{formatBaht(product.price_satang)}</b>
        </div>

        {!order ? (
          <form className="checkout-form" onSubmit={createOrder} noValidate>
            <label className="field-label" htmlFor="email">{english ? "Signed-in email" : "อีเมลบัญชีที่เข้าสู่ระบบ"}</label>
            <input id="email" type="email" autoComplete="email" value={email} readOnly aria-invalid={Boolean(validationAttempted && errors.email)} aria-describedby={validationAttempted && errors.email ? "email-error" : undefined} required />
            {validationAttempted && errors.email && <span className="field-error" id="email-error">{errors.email}</span>}

            <label className="field-label" htmlFor="player-id">Game UID</label>
            <input id="player-id" value={playerId} onChange={(event) => setPlayerId(event.target.value)} aria-invalid={Boolean(validationAttempted && errors.playerId)} aria-describedby={validationAttempted && errors.playerId ? "player-id-error" : undefined} required />
            {validationAttempted && errors.playerId && <span className="field-error" id="player-id-error">{errors.playerId}</span>}

            <div className="form-row">
              <div>
                <label className="field-label" htmlFor="quantity">{english ? "Quantity" : "จำนวน"}</label>
                <input id="quantity" type="number" min={1} max={product.max_per_order} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} aria-invalid={Boolean(validationAttempted && errors.quantity)} aria-describedby={validationAttempted && errors.quantity ? "quantity-error" : undefined} />
                {validationAttempted && errors.quantity && <span className="field-error" id="quantity-error">{errors.quantity}</span>}
              </div>
              <div>
                <label className="field-label" htmlFor="discount">{english ? "Discount code" : "โค้ดส่วนลด"}</label>
                <input id="discount" value={discountCode} onChange={(event) => setDiscountCode(event.target.value.toUpperCase())} placeholder="เช่น SAVE10" />
              </div>
            </div>

            <fieldset className="payment-options">
              <legend className="field-label">{english ? "Payment method" : "ช่องทางชำระเงิน"}</legend>
              {[
                ["promptpay", "PromptPay", english ? "No fee" : "ไม่มีค่าธรรมเนียม"],
                ["truemoney", "TrueMoney Wallet", english ? "1.5% fee" : "ค่าธรรมเนียม 1.5%"],
                ["card", "Credit Card", english ? "2.9% + ฿3 fee" : "ค่าธรรมเนียม 2.9% + ฿3"]
              ].map(([value, name, detail]) => (
                <label className={`payment-option ${paymentMethod === value ? "selected" : ""}`} key={value}>
                  <input type="radio" name="payment" value={value} checked={paymentMethod === value} onChange={() => setPaymentMethod(value)} />
                  <span><strong>{name}</strong><small>{detail}</small></span>
                  <span className="radio-dot" />
                </label>
              ))}
            </fieldset>

            <div className="price-breakdown" aria-live="polite">
              <div><span>{english ? "Subtotal" : "ยอดสินค้า"}</span><span>{formatBaht(quote?.subtotalSatang ?? BigInt(product.price_satang) * BigInt(quantity))}</span></div>
              <div><span>{english ? "Discount" : "ส่วนลด"}</span><span>−{formatBaht(quote?.discountSatang ?? 0)}</span></div>
              <div><span>{english ? "Fee" : "ค่าธรรมเนียม"}</span><span>{formatBaht(quote?.feeSatang ?? 0)}</span></div>
              <div className="price-total"><strong>{english ? "Total due" : "ยอดชำระรวม"}</strong><strong>{formatBaht(quote?.totalSatang ?? BigInt(product.price_satang) * BigInt(quantity))}</strong></div>
            </div>
            {problem && <div className="notice notice-error" role="alert">{problem}</div>}
            <button className="button button-primary button-wide" type="submit" disabled={busy || !quote}>
              {busy ? (english ? "Creating order…" : "กำลังสร้างรายการ…") : (english ? "Continue to payment" : "ดำเนินการชำระเงิน")}
            </button>
            <p className="form-footnote">{english ? "Prices are in baht and include VAT." : "ราคาทั้งหมดเป็นบาทและรวม VAT แล้ว"}</p>
          </form>
        ) : (
          <div className="order-ready">
            <div className="order-id-block">
              <span>{english ? "Order number" : "หมายเลขคำสั่งซื้อ"}</span>
              <strong>{order.id}</strong>
              <span className={`status-badge status-${customerStatus(order.status, locale).tone}`} aria-live="polite">
                {customerStatus(order.status, locale).label}
              </span>
            </div>
            <div className="payment-simulator">
              <h2>{english ? "Payment simulator" : "จำลองการชำระเงิน"}</h2>
              <p>{english ? "Choose a payment result to test updates." : "เลือกผลการชำระเพื่อทดสอบ webhook และการติดตามสถานะ"}</p>
              <button className="button button-primary button-wide" onClick={() => simulatePayment("success")} disabled={paymentBusy}>{english ? "Payment succeeded" : "จ่ายสำเร็จ"}</button>
              <button className="button button-secondary button-wide" onClick={() => simulatePayment("failure")} disabled={paymentBusy}>{english ? "Payment failed" : "จ่ายไม่สำเร็จ"}</button>
              <details className="advanced-sim">
                <summary>{english ? "Additional tests" : "กรณีทดสอบเพิ่มเติม"}</summary>
                <button className="button button-secondary button-wide" onClick={() => simulatePayment("duplicate")} disabled={paymentBusy}>{english ? "Send duplicate webhook" : "ส่ง webhook ซ้ำ 5 ครั้ง"}</button>
                <button className="button button-secondary button-wide" onClick={() => simulatePayment("delayed")} disabled={paymentBusy}>{english ? "Delay webhook" : "ส่ง webhook ช้า 60 วินาที"}</button>
                <button className="button button-secondary button-wide" onClick={() => simulatePayment("mismatch")} disabled={paymentBusy}>{english ? "Mismatched amount" : "ยอดชำระไม่ตรง"}</button>
              </details>
            </div>
            {problem && <div className="notice" role="status">{problem}</div>}
            <div className="timeline" aria-live="polite">
              <h2>{english ? "Order progress" : "สถานะคำสั่งซื้อ"}</h2>
              {events.map((event) => (
                <div className="timeline-item" key={event.id}>
                  <span className="timeline-dot" />
                  <div><strong>{customerStatus(event.status, locale).label}</strong><p>{event.reason}</p><time>{new Date(event.created_at).toLocaleString(english ? "en-US" : "th-TH")}</time></div>
                </div>
              ))}
            </div>
            <Link href={`${localizedPath("/tracking", locale)}?id=${encodeURIComponent(order.id)}`} className="text-link">{english ? "Track this order" : "ติดตามคำสั่งซื้อนี้"}</Link>
          </div>
        )}
      </section>
    </main>
  );
}
