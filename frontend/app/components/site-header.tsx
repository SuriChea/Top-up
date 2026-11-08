"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { changeLocale, localizedPath, useLocale } from "./locale";

export default function SiteHeader() {
  const pathname = usePathname();
  const locale = useLocale();
  const isEnglish = locale === "en";
  const router = useRouter();
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);
  useEffect(() => {
    document.documentElement.lang = isEnglish ? "en" : "th";
  }, [isEnglish]);
  useEffect(() => {
    const controllers = new Set<AbortController>();
    const refreshUser = () => {
      for (const controller of controllers) controller.abort();
      const controller = new AbortController();
      controllers.add(controller);
      fetch("/api/v1/auth/me", { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (response.status === 401) {
            setUser(null);
            return;
          }
          if (!response.ok) throw new Error(`Session lookup returned HTTP ${response.status}`);
          const body = await response.json() as { user?: { email: string; role: string } };
          setUser(body.user || null);
        })
        .catch((error: Error) => {
          if (error.name !== "AbortError") console.error("Could not refresh signed-in user", error);
        })
        .finally(() => controllers.delete(controller));
    };
    refreshUser();
    window.addEventListener("inblack:auth-changed", refreshUser);
    return () => {
      window.removeEventListener("inblack:auth-changed", refreshUser);
      for (const controller of controllers) controller.abort();
    };
  }, [pathname]);
  async function logout() {
    try {
      const response = await fetch("/api/v1/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error(`Logout returned HTTP ${response.status}`);
      setUser(null);
      window.dispatchEvent(new Event("inblack:auth-changed"));
      router.replace(localizedPath("/", locale));
      router.refresh();
    } catch (error) {
      console.error("Could not sign out", error);
    }
  }
  return (
    <header className="site-header">
      <a className="brand" href={localizedPath("/", locale)}>
        <span className="brand-mark" aria-hidden="true">✦</span> InBlack <span>TOP-UP</span>
      </a>
      <nav className="header-links" aria-label="Main navigation">
        <a href={`${localizedPath("/", locale)}#packs`}>{isEnglish ? "Shop" : "ร้านค้า"}</a>
        <a href={localizedPath("/tracking", locale)}>{isEnglish ? "Track order" : "ติดตามออเดอร์"}</a>
        {user && <a href={localizedPath("/account", locale)}>{isEnglish ? "My account" : "บัญชีของฉัน"}</a>}
        {user && ["admin", "viewer", "support", "finance", "superadmin"].includes(user.role) &&
          <a href={localizedPath("/admin", locale)}>{isEnglish ? "Admin" : "ผู้ดูแล"}</a>}
        {!user && <a href={localizedPath("/login", locale)}>{isEnglish ? "Sign in" : "เข้าสู่ระบบ"}</a>}
        {user && <button className="header-logout" onClick={logout}>{isEnglish ? "Sign out" : "ออกจากระบบ"}</button>}
        <button
          className="language-switch"
          type="button"
          onClick={() => changeLocale(pathname, locale, router.push)}
          lang={isEnglish ? "th" : "en"}
          aria-label={isEnglish ? "เปลี่ยนภาษาเป็นไทย" : "Switch language to English"}
        >
          {isEnglish ? "TH" : "EN"}
        </button>
      </nav>
    </header>
  );
}
