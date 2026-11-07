import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import AuthForm from "../components/auth-form";

export const metadata: Metadata = { title: "Sign in" };

async function LoginContent() {
  await connection();
  return <AuthForm />;
}

export default function LoginPage() {
  return <Suspense fallback={<main className="page-shell"><div className="empty-state">กำลังโหลด…</div></main>}>
    <LoginContent />
  </Suspense>;
}
