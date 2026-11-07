import type { Metadata } from "next";
import { Suspense } from "react";
import TrackingPanel from "../components/tracking-panel";

export const metadata: Metadata = {
  title: "Track an order | InBlack Top-Up",
  robots: { index: false, follow: false }
};

async function TrackingContent({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id = "" } = await searchParams;
  return <TrackingPanel initialId={id} />;
}

export default function TrackingPage({
  searchParams
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  return <Suspense fallback={<main className="page-shell"><div className="empty-state">กำลังโหลด…</div></main>}>
    <TrackingContent searchParams={searchParams} />
  </Suspense>;
}
