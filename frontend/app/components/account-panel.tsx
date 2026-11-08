"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { customerStatus } from "./order-events";
import { localizedPath, useLocale } from "./locale";

type AccountOrder = {
  id: string;
  productName: string;
  quantity: number;
  totalSatang: number;
  status: string;
  createdAt: string;
  refundRequestStatus: "pending" | "approved" | "rejected" | null;
};
type ApiProblem = { detail?: string };

function formatBaht(satang: number, locale: "en" | "th") {
  const amount = BigInt(satang);
  return `฿${(amount / 100n).toLocaleString(locale === "en" ? "en-US" : "th-TH")}.${String(amount % 100n).padStart(2, "0")}`;
}

export default function AccountPanel() {
  const router = useRouter();
  const locale = useLocale();
  const english = locale === "en";
  const [email, setEmail] = useState("");
  const [orders, setOrders] = useState<AccountOrder[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyOrder, setBusyOrder] = useState("");
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const meResponse = await fetch("/api/v1/auth/me", { cache: "no-store" });
      if (meResponse.status === 401) {
        router.replace(`${localizedPath("/login", locale)}?next=${encodeURIComponent(localizedPath("/account", locale))}`);
        return;
      }
      const me = await meResponse.json() as { user?: { email: string }; detail?: string };
      if (!meResponse.ok || !me.user) throw new Error(me.detail || "Could not load your account");
      setEmail(me.user.email);
      const response = await fetch("/api/v1/account/orders", { cache: "no-store" });
      const body = await response.json() as AccountOrder[] & ApiProblem;
      if (!response.ok) throw new Error(body.detail || "Could not load your order history");
      setOrders(body);
      setProblem("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not load your account");
    } finally {
      setLoading(false);
    }
  }, [locale, router]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function requestRefund(orderId: string) {
    setBusyOrder(orderId);
    setProblem("");
    setNotice("");
    try {
      const response = await fetch(`/api/v1/account/orders/${encodeURIComponent(orderId)}/refund-request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reasons[orderId] || "" })
      });
      const body = await response.json() as ApiProblem;
      if (!response.ok) throw new Error(body.detail || "Could not submit your refund request");
      setNotice(english ? "Refund request sent for review." : "ส่งคำขอคืนเงินเพื่อรอตรวจสอบแล้ว");
      await load();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not submit your refund request");
    } finally {
      setBusyOrder("");
    }
  }

  if (loading) {
    return <main className="page-shell"><div className="empty-state" role="status">{english ? "Loading account…" : "กำลังโหลดบัญชี…"}</div></main>;
  }

  return (
    <main className="page-shell account-layout">
      <div className="admin-heading">
        <div><p className="eyebrow">MY ACCOUNT</p><h1>{english ? "Your purchases" : "ประวัติการซื้อ"}</h1></div>
        <div className="account-email"><span>{english ? "Signed in as" : "เข้าสู่ระบบด้วย"}</span><strong>{email}</strong></div>
      </div>
      {problem && <p className="notice notice-error" role="alert">{problem}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {orders.length === 0 ? (
        <section className="admin-card">
          <p className="muted-copy">{english ? "You have no purchases yet." : "ยังไม่มีประวัติการซื้อ"}</p>
          <Link className="button button-primary" href={localizedPath("/", locale)}>{english ? "Browse products" : "เลือกซื้อสินค้า"}</Link>
        </section>
      ) : (
        <section className="admin-card">
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>{english ? "Order" : "คำสั่งซื้อ"}</th><th>{english ? "Product" : "สินค้า"}</th><th>{english ? "Total" : "ยอดรวม"}</th><th>{english ? "Status" : "สถานะ"}</th><th>{english ? "Refund" : "คืนเงิน"}</th></tr></thead>
              <tbody>{orders.map((order) => {
                const canRequest = ["PAID", "IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "NEEDS_REVIEW"].includes(order.status);
                return (
                  <tr key={order.id}>
                    <td><strong>{order.id}</strong><small>{new Date(order.createdAt).toLocaleString(english ? "en-US" : "th-TH")}</small></td>
                    <td><strong>{order.productName} × {order.quantity}</strong></td>
                    <td>{formatBaht(order.totalSatang, locale)}</td>
                    <td><span className={`status-badge status-${customerStatus(order.status, locale).tone}`}>{customerStatus(order.status, locale).label}</span></td>
                    <td>
                      {order.refundRequestStatus ? (
                        <span className="field-hint">
                          {order.refundRequestStatus === "pending"
                            ? (english ? "Under review" : "กำลังตรวจสอบ")
                            : order.refundRequestStatus === "approved"
                              ? (english ? "Approved; refund queued" : "อนุมัติแล้ว กำลังคืนเงิน")
                              : (english ? "Declined" : "ไม่อนุมัติ")}
                        </span>
                      ) : canRequest ? (
                        <div className="refund-request-control">
                          <input
                            aria-label={`${english ? "Reason for refund" : "เหตุผลขอคืนเงิน"} ${order.id}`}
                            maxLength={300}
                            placeholder={english ? "Reason for refund" : "เหตุผลขอคืนเงิน"}
                            value={reasons[order.id] || ""}
                            onChange={(event) => setReasons((current) => ({ ...current, [order.id]: event.target.value }))}
                          />
                          <button
                            className="button button-small button-danger"
                            disabled={busyOrder === order.id || (reasons[order.id] || "").trim().length < 3}
                            onClick={() => void requestRefund(order.id)}
                          >
                            {busyOrder === order.id ? (english ? "Sending…" : "กำลังส่ง…") : (english ? "Request refund" : "ขอคืนเงิน")}
                          </button>
                        </div>
                      ) : <span className="field-hint">—</span>}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
