import type { Metadata } from "next";
import { Suspense } from "react";
import CheckoutForm from "../components/checkout-form";

export const metadata: Metadata = {
  title: "Checkout | InBlack Top-Up",
  robots: { index: false, follow: false }
};

async function CheckoutContent({ searchParams }: { searchParams: Promise<{ sku?: string }> }) {
  const { sku = "" } = await searchParams;
  return <CheckoutForm sku={sku} />;
}

export default function CheckoutPage({
  searchParams
}: {
  searchParams: Promise<{ sku?: string }>;
}) {
  return <Suspense fallback={<main className="page-shell"><div className="empty-state">กำลังโหลด…</div></main>}>
    <CheckoutContent searchParams={searchParams} />
  </Suspense>;
}
