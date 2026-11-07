import Link from "next/link";
import { connection } from "next/server";

type Product = {
  sku: string;
  name: string;
  price_satang: number;
  stock: number;
  max_per_order: number;
};

type Locale = "en" | "th";

const copy = {
  en: {
    eyebrow: "THE TOP-UP SHOP",
    title: "Game on. We’ve got your back.",
    intro: "Your next win is a few clicks away. Fast, secure top-ups, made for players.",
    popular: "PLAYER FAVORITES",
    available: "Ready to top up",
    remaining: (count: number) => `${count} left`,
    button: "Choose this pack",
    note: "Secure checkout · Instant delivery · Real support",
    empty: "No packs are available right now."
  },
  th: {
    eyebrow: "ร้านเติมเกมของคุณ",
    title: "พร้อมลุย เราดูแลให้",
    intro: "เติมเกมได้ในไม่กี่ขั้นตอน จ่ายปลอดภัย รับไอเทมไวทุกครั้ง",
    popular: "แพ็กยอดนิยม",
    available: "พร้อมเติม",
    remaining: (count: number) => `เหลือ ${count} ชิ้น`,
    button: "เลือกแพ็กนี้",
    note: "จ่ายปลอดภัย · รับไอเทมทันที · มีทีมงานดูแล",
    empty: "ยังไม่มีแพ็กสินค้าในขณะนี้"
  }
} satisfies Record<Locale, {
  eyebrow: string;
  title: string;
  intro: string;
  popular: string;
  available: string;
  remaining: (count: number) => string;
  button: string;
  note: string;
  empty: string;
}>;

function baht(satang: number, locale: Locale) {
  const amount = BigInt(satang);
  const currencyLocale = locale === "th" ? "th-TH" : "en-US";
  const whole = (amount / 100n).toLocaleString(currencyLocale);
  const fraction = String(amount % 100n).padStart(2, "0");
  return `฿${whole}.${fraction}`;
}

async function getProducts(): Promise<Product[]> {
  await connection();
  const baseUrl = process.env.API_INTERNAL_URL || "http://localhost:3001";
  const response = await fetch(`${baseUrl}/api/v1/products`, { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load the product catalog");
  return response.json();
}

export async function Catalog({ locale }: { locale: Locale }) {
  const text = copy[locale];
  const products = await getProducts();
  const labels = locale === "th"
    ? ["เติมไวทุกแพ็ก", "จ่ายได้หลายทาง", "ราคาชัด ไม่มีบวกเพิ่ม"]
    : ["Fast delivery", "Flexible payment", "Clear, upfront pricing"];

  return (
    <main className="store-main">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{text.eyebrow}</p>
          <h1>{text.title}</h1>
          <p className="hero-intro">{text.intro}</p>
          <a className="button button-primary hero-cta" href="#packs">
            {locale === "th" ? "ดูแพ็กทั้งหมด" : "Explore packs"}
            <span aria-hidden="true">↓</span>
          </a>
          <div className="hero-trust">
            {labels.map((label) => <span key={label}><span aria-hidden="true">✓</span> {label}</span>)}
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orb orb-main">✦</div>
          <div className="orb orb-small">+1000</div>
          <div className="spark spark-one">✧</div>
          <div className="spark spark-two">✦</div>
          <div className="hero-art-caption">POWER UP<br /><strong>YOUR GAME</strong></div>
        </div>
      </section>

      <section className="catalog-section" id="packs">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{text.popular}</p>
            <h2>{locale === "th" ? "เลือกแพ็กที่ใช่" : "Find your next level"}</h2>
          </div>
          <span className="catalog-count">{products.length.toString().padStart(2, "0")} {locale === "th" ? "แพ็ก" : "PACKS"}</span>
        </div>

        {products.length === 0 ? (
          <div className="empty-state" role="status">{text.empty}</div>
        ) : (
          <div className="product-grid">
            {products.map((product, index) => (
              <article className={`product-card product-card-${index + 1}`} key={product.sku}>
                <div className="product-card-top">
                  <span className="product-kicker">{product.sku.replaceAll("-", " ")}</span>
                  {product.sku === "FLASH-SKIN-01" && (
                    <span className="sale-tag">{locale === "th" ? "มีจำนวนจำกัด" : "LIMITED"}</span>
                  )}
                  <div className={`product-symbol symbol-${index + 1}`} aria-hidden="true">
                    {index === 0 ? "✦" : index === 1 ? "✧" : index === 2 ? "◈" : "✺"}
                  </div>
                </div>
                <h3>{product.name}</h3>
                <div className="product-meta">
                  <span className="product-price">{baht(product.price_satang, locale)}</span>
                  <span className="stock-label">
                    <span className="stock-dot" />
                    {product.stock === -1 ? text.available : text.remaining(product.stock)}
                  </span>
                </div>
                <Link
                  className="button button-card"
                  href={`/checkout?sku=${encodeURIComponent(product.sku)}`}
                  aria-label={`${text.button}: ${product.name}`}
                >
                  {text.button}<span aria-hidden="true">↗</span>
                </Link>
              </article>
            ))}
          </div>
        )}
        <p className="catalog-note"><span aria-hidden="true">◉</span> {text.note}</p>
      </section>
    </main>
  );
}

export function CatalogLoading({ locale = "th" }: { locale?: Locale }) {
  return (
    <main className="store-main" aria-busy="true">
      <section className="hero hero-skeleton">
        <p className="eyebrow">{locale === "th" ? "กำลังโหลดร้านค้า" : "LOADING STORE"}</p>
        <div className="skeleton skeleton-heading" />
        <div className="skeleton skeleton-copy" />
      </section>
      <div className="product-grid" aria-hidden="true">
        {[1, 2, 3, 4].map((item) => <div className="skeleton skeleton-card" key={item} />)}
      </div>
    </main>
  );
}
