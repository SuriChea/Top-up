import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import AccountPanel from "../components/account-panel";

export const metadata: Metadata = { title: "My account", robots: { index: false, follow: false } };

async function AccountContent() {
  await connection();
  return <AccountPanel />;
}

export default function AccountPage() {
  return (
    <Suspense fallback={<main className="page-shell"><div className="empty-state">Loading account…</div></main>}>
      <AccountContent />
    </Suspense>
  );
}
