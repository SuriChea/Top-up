import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import AdminPanel from "../components/admin-panel";

export const metadata: Metadata = { title: "Admin" };

async function AdminContent() {
  await connection();
  return <AdminPanel />;
}

export default function AdminPage() {
  return <Suspense fallback={<main className="page-shell"><div className="empty-state">กำลังโหลด…</div></main>}>
    <AdminContent />
  </Suspense>;
}
