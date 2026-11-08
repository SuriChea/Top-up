"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { localizedPath, useLocale } from "./locale";

type AuthResponse = {
  detail?: string;
  user?: { email: string; role: string };
  expiresInSeconds?: number;
};

export default function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const english = locale === "en";
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function requestCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/v1/auth/request-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email })
      });
      const body = await response.json() as AuthResponse;
      if (!response.ok) throw new Error(body.detail || "ส่งรหัสยืนยันไม่สำเร็จ");
      setSent(true);
      setMessage(english
        ? `A six-digit code was sent to ${email.trim()}.`
        : `ส่งรหัส 6 หลักไปที่ ${email.trim()} แล้ว`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "ไม่สามารถส่งรหัสได้");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/auth/verify-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code })
      });
      const body = await response.json() as AuthResponse;
      if (!response.ok || !body.user) throw new Error(body.detail || "รหัสยืนยันไม่ถูกต้อง");
      setMessage(english ? "Signed in successfully." : "เข้าสู่ระบบสำเร็จ");
      window.dispatchEvent(new Event("inblack:auth-changed"));
      const requestedPath = searchParams.get("next");
      const nextPath = requestedPath?.startsWith("/") && !requestedPath.startsWith("//")
        ? requestedPath
        : localizedPath(
          ["admin", "viewer", "support", "finance", "superadmin"].includes(body.user.role)
            ? "/admin"
            : "/account",
          locale
        );
      router.push(nextPath);
      router.refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "เข้าสู่ระบบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="auth-panel">
        <p className="eyebrow">SECURE SIGN IN</p>
        <h1>{english ? "Sign in with email" : "เข้าสู่ระบบด้วยอีเมล"}</h1>
        <p className="muted-copy">{english ? "We’ll email you a one-time code that expires in 10 minutes." : "เราจะส่งรหัส OTP ที่ใช้ได้ครั้งเดียวและหมดอายุใน 10 นาที"}</p>
        {!sent ? (
          <form className="auth-form" onSubmit={requestCode}>
            <label className="field-label" htmlFor="login-email">{english ? "Email" : "อีเมล"}</label>
            <input id="login-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
            <button className="button button-primary" disabled={busy}>{busy ? (english ? "Sending…" : "กำลังส่ง…") : (english ? "Send OTP" : "ส่งรหัส OTP")}</button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={verifyCode}>
            <label className="field-label" htmlFor="login-email">{english ? "Email" : "อีเมล"}</label>
            <input id="login-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
            <label className="field-label" htmlFor="login-code">{english ? "Six-digit OTP" : "รหัส OTP 6 หลัก"}</label>
            <input id="login-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
            <button className="button button-primary" disabled={busy || code.length !== 6}>{busy ? (english ? "Verifying…" : "กำลังตรวจสอบ…") : (english ? "Verify and sign in" : "ยืนยันและเข้าสู่ระบบ")}</button>
            <button className="text-button" type="button" disabled={busy} onClick={() => { setSent(false); setCode(""); setMessage(""); }}>{english ? "Use a different email" : "ใช้อีเมลอื่น"}</button>
          </form>
        )}
        {message && <p className="notice" role="status">{message}</p>}
        {error && <p className="notice notice-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
