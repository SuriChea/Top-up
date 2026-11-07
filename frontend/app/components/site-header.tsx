"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function SiteHeader() {
  const isEnglish = usePathname().startsWith("/en");
  const router = useRouter();
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);
  useEffect(() => {
    document.documentElement.lang = isEnglish ? "en" : "th";
  }, [isEnglish]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/auth/me", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { user?: { email: string; role: string } };
        if (body.user) setUser(body.user);
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") console.error("Could not load signed-in user", error);
      });
    return () => controller.abort();
  }, []);
  async function logout() {
    try {
      const response = await fetch("/api/v1/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error(`Logout returned HTTP ${response.status}`);
      setUser(null);
      router.refresh();
    } catch (error) {
      console.error("Could not sign out", error);
    }
  }
  return (
    <header className="site-header">
      <a className="brand" href={isEnglish ? "/en" : "/th"}>
        <span className="brand-mark" aria-hidden="true">✦</span> InBlack <span>TOP-UP</span>
      </a>
      <nav className="header-links" aria-label="Main navigation">
        <a href={`${isEnglish ? "/en" : "/th"}#packs`}>{isEnglish ? "Shop" : "ร้านค้า"}</a>
        <a href="/tracking">{isEnglish ? "Track order" : "ติดตามออเดอร์"}</a>
        {user?.role === "admin" && <a href="/admin">{isEnglish ? "Admin" : "ผู้ดูแล"}</a>}
        {!user && <a href="/login">{isEnglish ? "Sign in" : "เข้าสู่ระบบ"}</a>}
        {user && <button className="header-logout" onClick={logout}>{isEnglish ? "Sign out" : "ออกจากระบบ"}</button>}
        <a
          className="language-switch"
          href={isEnglish ? "/th" : "/en"}
          lang={isEnglish ? "th" : "en"}
          hrefLang={isEnglish ? "th" : "en"}
          aria-label={isEnglish ? "เปลี่ยนภาษาเป็นไทย" : "Switch language to English"}
        >
          {isEnglish ? "TH" : "EN"}
        </a>
      </nav>
    </header>
  );
}
