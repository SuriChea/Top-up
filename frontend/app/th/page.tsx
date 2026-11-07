import type { Metadata } from "next";
import { Suspense } from "react";
import { Catalog, CatalogLoading } from "../components/catalog";

export const metadata: Metadata = {
  title: "InBlack Top-Up | เติมเกมง่าย ได้ไว",
  description: "เลือกแพ็กเกมที่ใช่ ชำระเงินปลอดภัย และติดตามสถานะการเติมได้ทันที",
  alternates: { canonical: "/th", languages: { th: "/th", en: "/en" } },
  openGraph: { title: "InBlack Top-Up", locale: "th_TH", type: "website" }
};

export default function ThaiStorePage() {
  return <Suspense fallback={<CatalogLoading />}><Catalog locale="th" /></Suspense>;
}
