"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Product = {
  sku: string;
  name: string;
  price_satang: number;
  stock: number;
  max_per_order: number;
  active: boolean;
};
type Order = {
  id: string;
  email: string;
  productName: string;
  totalSatang: number;
  status: string;
};
type Batch = {
  id: string;
  file_name: string;
  row_count: number;
  matched_count: number;
  mismatch_count: number;
  status: string;
  created_at: string;
};
type Report = Batch & {
  items: Array<{
    provider_event_id: string;
    order_id: string;
    amount_satang: string;
    status: string;
    detail: string;
  }>;
};
type ApiProblem = { detail?: string };

function formatBaht(satang: number | string) {
  const amount = BigInt(satang);
  return `฿${(amount / 100n).toLocaleString("th-TH")}.${String(amount % 100n).padStart(2, "0")}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & ApiProblem;
  if (!response.ok) throw new Error(body.detail || "คำขอไม่สำเร็จ");
  return body;
}

export default function AdminPanel() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [reason, setReason] = useState("Customer support refund");
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setProblem("");
    try {
      const meResponse = await fetch("/api/v1/auth/me", { cache: "no-store" });
      const me = await readJson<{ user: { role: string } }>(meResponse);
      if (me.user.role !== "admin") {
        setProblem("บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ");
        return;
      }
      const [productResponse, orderResponse, batchResponse] = await Promise.all([
        fetch("/api/v1/admin/products", { cache: "no-store" }),
        fetch("/api/v1/admin/orders", { cache: "no-store" }),
        fetch("/api/v1/admin/reconciliation", { cache: "no-store" })
      ]);
      const [nextProducts, nextOrders, nextBatches] = await Promise.all([
        readJson<Product[]>(productResponse),
        readJson<Order[]>(orderResponse),
        readJson<Batch[]>(batchResponse)
      ]);
      setProducts(nextProducts);
      setOrders(nextOrders);
      setBatches(nextBatches);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Sign in")) {
        router.replace("/login");
        return;
      }
      setProblem(error instanceof Error ? error.message : "โหลดข้อมูลผู้ดูแลไม่สำเร็จ");
    }
  }, [router]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function updateProduct(sku: string, patch: Partial<Product>) {
    setProducts((current) => current.map((product) => product.sku === sku ? { ...product, ...patch } : product));
  }

  async function saveProduct(product: Product) {
    setBusy(true);
    setProblem("");
    setNotice("");
    try {
      const response = await fetch(`/api/v1/admin/products/${encodeURIComponent(product.sku)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priceSatang: product.price_satang,
          stock: product.stock,
          active: product.active
        })
      });
      await readJson<Product>(response);
      setNotice(`บันทึก ${product.sku} แล้ว`);
      await load();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "บันทึกสินค้าไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function requestRefund(orderId: string) {
    setBusy(true);
    setProblem("");
    setNotice("");
    try {
      const response = await fetch(`/api/v1/admin/orders/${encodeURIComponent(orderId)}/refund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason })
      });
      await readJson(response);
      setNotice(`ส่งคำขอคืนเงินสำหรับ ${orderId} เข้าคิวแล้ว`);
      await load();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "ส่งคำขอคืนเงินไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function importSettlement(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.namedItem("settlement") as HTMLInputElement | null;
    const selected = file?.files?.[0];
    if (!selected) {
      setProblem("เลือกไฟล์ CSV ก่อนนำเข้า");
      return;
    }
    setBusy(true);
    setProblem("");
    setNotice("");
    setReport(null);
    try {
      const response = await fetch("/api/v1/admin/reconciliation/import", {
        method: "POST",
        headers: { "content-type": "text/csv", "X-File-Name": selected.name },
        body: await selected.text()
      });
      const batch = await readJson<Batch>(response);
      setNotice(`นำเข้าแล้ว: ตรงกัน ${batch.matched_count} รายการ, ต้องตรวจสอบ ${batch.mismatch_count} รายการ`);
      form.reset();
      await load();
      const detailResponse = await fetch(`/api/v1/admin/reconciliation/${encodeURIComponent(batch.id)}`, { cache: "no-store" });
      setReport(await readJson<Report>(detailResponse));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "นำเข้าไฟล์ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function openReport(id: string) {
    setProblem("");
    try {
      const response = await fetch(`/api/v1/admin/reconciliation/${encodeURIComponent(id)}`, { cache: "no-store" });
      setReport(await readJson<Report>(response));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "โหลดรายงานไม่สำเร็จ");
    }
  }

  async function logout() {
    const response = await fetch("/api/v1/auth/logout", { method: "POST" });
    if (!response.ok) {
      setProblem("ออกจากระบบไม่สำเร็จ");
      return;
    }
    router.replace("/login");
  }

  return (
    <main className="page-shell admin-layout">
      <div className="admin-heading">
        <div><p className="eyebrow">INBLACK OPERATIONS</p><h1>Admin dashboard</h1></div>
        <button className="button button-secondary" onClick={logout}>ออกจากระบบ</button>
      </div>
      {problem && <p className="notice notice-error" role="alert">{problem}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <section className="admin-card">
        <div className="section-heading"><div><p className="eyebrow">CATALOG</p><h2>สินค้าและสต็อก</h2></div></div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>สินค้า</th><th>ราคา (สตางค์)</th><th>สต็อก (-1 = ไม่จำกัด)</th><th>เปิดขาย</th><th /></tr></thead>
            <tbody>{products.map((product) => (
              <tr key={product.sku}>
                <td><strong>{product.name}</strong><small>{product.sku}</small></td>
                <td><input aria-label={`${product.sku} price in satang`} type="number" min="0" step="1" value={product.price_satang} onChange={(event) => updateProduct(product.sku, { price_satang: Number(event.target.value) })} /></td>
                <td><input aria-label={`${product.sku} stock`} type="number" min="-1" step="1" value={product.stock} onChange={(event) => updateProduct(product.sku, { stock: Number(event.target.value) })} /></td>
                <td><input aria-label={`${product.sku} active`} type="checkbox" checked={product.active} onChange={(event) => updateProduct(product.sku, { active: event.target.checked })} /></td>
                <td><button className="button button-small" disabled={busy} onClick={() => void saveProduct(product)}>บันทึก</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="admin-card">
        <div className="section-heading"><div><p className="eyebrow">ORDERS & FINANCE</p><h2>คำสั่งซื้อล่าสุด</h2></div></div>
        <label className="field-label" htmlFor="refund-reason">เหตุผลคืนเงิน</label>
        <input id="refund-reason" maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Order</th><th>สินค้า / อีเมล</th><th>ยอด</th><th>สถานะ</th><th /></tr></thead>
            <tbody>{orders.map((order) => (
              <tr key={order.id}>
                <td>{order.id}</td><td><strong>{order.productName}</strong><small>{order.email}</small></td>
                <td>{formatBaht(order.totalSatang)}</td><td><span className="status-badge status-muted">{order.status}</span></td>
                <td>{["PAID", "IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "NEEDS_REVIEW"].includes(order.status) &&
                  <button className="button button-small button-danger" disabled={busy || reason.trim().length < 3} onClick={() => void requestRefund(order.id)}>ขอคืนเงิน</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="admin-card">
        <div className="section-heading"><div><p className="eyebrow">FINANCE</p><h2>Payment reconciliation</h2></div></div>
        <p className="muted-copy">CSV ต้องมีคอลัมน์ event_id, order_id, amount_satang, currency และ type</p>
        <form className="reconciliation-form" onSubmit={importSettlement}>
          <input name="settlement" type="file" accept=".csv,text/csv" required />
          <button className="button button-primary" disabled={busy}>{busy ? "กำลังประมวลผล…" : "นำเข้าและกระทบยอด"}</button>
        </form>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>ไฟล์</th><th>รายการ</th><th>ตรงกัน</th><th>คลาดเคลื่อน</th><th>รายงาน</th></tr></thead>
            <tbody>{batches.map((batch) => (
              <tr key={batch.id}><td>{batch.file_name}</td><td>{batch.row_count}</td><td>{batch.matched_count}</td><td>{batch.mismatch_count}</td><td><button className="text-button" onClick={() => void openReport(batch.id)}>เปิด</button></td></tr>
            ))}</tbody>
          </table>
        </div>
        {report && <div className="reconciliation-report">
          <h3>{report.file_name} — {report.mismatch_count} รายการที่ต้องตรวจสอบ</h3>
          {report.items.map((item, index) => (
            <p key={`${item.provider_event_id}-${index}`}><strong>{item.status}</strong> · {item.order_id} · {formatBaht(item.amount_satang)} — {item.detail}</p>
          ))}
        </div>}
      </section>
    </main>
  );
}
