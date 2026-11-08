import { expect, test, type Page } from "@playwright/test";

const mailpitUrl = process.env.MAILPIT_API_URL || "http://127.0.0.1:8025";
const adminEmail = process.env.E2E_ADMIN_EMAIL || "admin@example.com";

async function getOtp(email: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const listResponse = await fetch(`${mailpitUrl}/api/v1/messages?limit=50`);
    if (!listResponse.ok) throw new Error(`Mailpit returned HTTP ${listResponse.status}`);
    const list = await listResponse.json() as { messages?: Array<{ ID?: string; To?: unknown }> };
    const message = (list.messages || []).find((item) => JSON.stringify(item.To || item).includes(email));
    if (message?.ID) {
      const detailResponse = await fetch(`${mailpitUrl}/api/v1/message/${encodeURIComponent(message.ID)}`);
      if (!detailResponse.ok) throw new Error(`Mailpit message lookup returned HTTP ${detailResponse.status}`);
      const detail = await detailResponse.json() as Record<string, unknown>;
      const content = [detail.Text, detail.HTML, detail.text, detail.html].map((value) =>
        typeof value === "string" ? value : JSON.stringify(value || "")
      ).join("\n");
      const code = /\b\d{6}\b/.exec(content)?.[0];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`No OTP email received for ${email}`);
}

async function finishSignIn(page: Page, email: string, locale: "en" | "th") {
  const english = locale === "en";
  await page.getByLabel(english ? "Email" : "อีเมล").fill(email);
  await page.getByRole("button", { name: english ? "Send OTP" : "ส่งรหัส OTP" }).click();
  await expect(page.getByRole("status")).toContainText(email);
  await page.getByLabel(english ? "Six-digit OTP" : "รหัส OTP 6 หลัก").fill(await getOtp(email));
  await page.getByRole("button", { name: english ? "Verify and sign in" : "ยืนยันและเข้าสู่ระบบ" }).click();
}

async function signIn(page: Page, email: string, locale: "en" | "th" = "th") {
  await page.goto(locale === "en" ? "/en/login" : "/login");
  await finishSignIn(page, email, locale);
}

async function createPaidOrder(
  page: Page,
  sku: string,
  quantity: number,
  playerId: string,
  locale: "en" | "th",
  discountCode = ""
) {
  const english = locale === "en";
  await page.goto(`/${locale}/checkout?sku=${encodeURIComponent(sku)}`);
  await page.getByLabel("Game UID").fill(playerId);
  if (quantity > 1) {
    await page.getByLabel(english ? "Quantity" : "จำนวน").fill(String(quantity));
  }
  if (discountCode) {
    await page.getByLabel(english ? "Discount code" : "โค้ดส่วนลด").fill(discountCode);
  }
  const submit = page.getByRole("button", { name: english ? "Continue to payment" : "ดำเนินการชำระเงิน" });
  await expect(submit).toBeEnabled();
  await submit.click();
  const orderIdLocator = page.locator(".order-id-block strong");
  await expect(orderIdLocator).toBeVisible();
  const orderId = await orderIdLocator.innerText();
  const simulationResponse = page.waitForResponse((response) =>
    response.url().includes("/mock-pay/simulate") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: english ? "Payment succeeded" : "จ่ายสำเร็จ" }).click();
  await simulationResponse;
  await expect(page.locator(".timeline")).toContainText(english ? "Completed" : "เติมสำเร็จ", { timeout: 30_000 });
  return orderId;
}

test("OTP login, customer RBAC, admin operations, refund, and settlement reconciliation", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const customerEmail = `customer-${suffix}@example.test`;

  await signIn(page, customerEmail);
  await expect(page).toHaveURL(/\/th\/account$/);
  await expect(page.getByRole("button", { name: "ออกจากระบบ" })).toBeVisible();
  const forbidden = await page.evaluate(async () => {
    const response = await fetch("/api/v1/admin/orders");
    return response.status;
  });
  expect(forbidden).toBe(403);
  await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error("Customer logout failed");
  });

  await signIn(page, adminEmail);
  await expect(page).toHaveURL(/\/th\/admin$/);
  await expect(page.getByRole("heading", { name: "Admin dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "สินค้าและสต็อก" })).toBeVisible();

  await page.goto("/checkout?sku=DIAMOND-1000");
  await expect(page.getByLabel("อีเมลบัญชีที่เข้าสู่ระบบ")).toHaveValue(adminEmail);
  await page.getByLabel("Game UID").fill(`uid-${suffix}`);
  await page.getByRole("button", { name: "ดำเนินการชำระเงิน" }).click();
  const orderIdLocator = page.locator(".order-id-block strong");
  await expect(orderIdLocator).toBeVisible();
  const orderId = await orderIdLocator.innerText();
  const simulationResponse = page.waitForResponse((response) =>
    response.url().includes("/mock-pay/simulate") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "จ่ายสำเร็จ" }).click();
  const simulation = await (await simulationResponse).json() as { eventId: string };
  await expect(page.locator(".timeline")).toContainText("เติมสำเร็จ", { timeout: 30_000 });

  const orderResponse = await page.evaluate(async (id) => {
    const response = await fetch("/api/v1/admin/orders");
    const orders = await response.json() as Array<{ id: string; totalSatang: number; status: string }>;
    if (!response.ok) throw new Error("Admin order list failed");
    const order = orders.find((item) => item.id === id);
    if (!order) throw new Error("Created order is missing from admin list");
    return order;
  }, orderId);
  expect(orderResponse.status).toBe("COMPLETED");

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin dashboard" })).toBeVisible();
  await page.getByLabel("เหตุผลคืนเงิน / หมายเหตุไม่อนุมัติ").fill("Automated end-to-end refund check");
  const orderRow = page.locator("tr", { hasText: orderId });
  await orderRow.getByRole("button", { name: "ขอคืนเงิน" }).click();
  await expect(page.getByRole("status")).toContainText("เข้าคิวแล้ว");
  await expect.poll(async () => page.evaluate(async (id) => {
    const response = await fetch("/api/v1/admin/orders");
    const orders = await response.json() as Array<{ id: string; status: string }>;
    return orders.find((item) => item.id === id)?.status;
  }, orderId), { timeout: 30_000 }).toBe("REFUNDED");

  const csv = [
    "event_id,order_id,amount_satang,currency,type",
    `${simulation.eventId},${orderId},${orderResponse.totalSatang},THB,payment.succeeded`
  ].join("\n");
  await page.locator('input[name="settlement"]').setInputFiles({
    name: "e2e-settlement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv)
  });
  await page.getByRole("button", { name: "นำเข้าและกระทบยอด" }).click();
  const firstImportNotice = page.getByRole("status");
  await expect(firstImportNotice).toContainText("ตรงกัน 1 รายการ");
  await expect(page.locator(".reconciliation-report")).toContainText("matched");
  const previousMismatches = Number(/ต้องตรวจสอบ (\d+) รายการ/.exec(await firstImportNotice.innerText())?.[1] || 0);

  const mismatchedCsv = [
    "event_id,order_id,amount_satang,currency,type",
    `${simulation.eventId},${orderId},${orderResponse.totalSatang + 1},THB,payment.succeeded`
  ].join("\n");
  await page.locator('input[name="settlement"]').setInputFiles({
    name: "e2e-mismatch.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(mismatchedCsv)
  });
  await page.getByRole("button", { name: "นำเข้าและกระทบยอด" }).click();
  await expect(page.getByRole("status")).toContainText(`ต้องตรวจสอบ ${previousMismatches + 1} รายการ`);
  await expect(page.locator(".reconciliation-report")).toContainText("amount_mismatch");

  const stockField = page.getByLabel("FLASH-SKIN-01 stock");
  const stockRow = page.locator("tr", { hasText: "FLASH-SKIN-01" });
  await stockField.fill("99");
  const reduceStock = page.waitForResponse((response) =>
    response.url().includes("/api/v1/admin/products/FLASH-SKIN-01") && response.request().method() === "PATCH"
  );
  await stockRow.getByRole("button", { name: "บันทึก" }).click();
  expect((await reduceStock).ok()).toBe(true);
  await expect(page.getByLabel("FLASH-SKIN-01 stock")).toHaveValue("99");
  await expect(stockRow.getByRole("button", { name: "บันทึก" })).toBeEnabled();
  await page.getByLabel("FLASH-SKIN-01 stock").fill("100");
  const restoreStock = page.waitForResponse((response) =>
    response.url().includes("/api/v1/admin/products/FLASH-SKIN-01") && response.request().method() === "PATCH"
  );
  await stockRow.getByRole("button", { name: "บันทึก" }).click();
  expect((await restoreStock).ok()).toBe(true);
  await expect(page.getByLabel("FLASH-SKIN-01 stock")).toHaveValue("100");
});

test("checkout login gate, persistent English locale, purchase limits, account history, and refund requests", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const customerEmail = `buyer-${suffix}@example.test`;

  await page.goto("/th/checkout?sku=MONTHLY-PASS");
  await expect(page.getByRole("heading", { name: "กรุณาเข้าสู่ระบบก่อนชำระเงิน" })).toBeVisible();
  const unauthenticatedCheckout = await page.evaluate(async () => {
    const response = await fetch("/api/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ sku: "MONTHLY-PASS", quantity: 1, email: "guest@example.test", playerId: "guest-123" })
    });
    return response.status;
  });
  expect(unauthenticatedCheckout).toBe(401);

  await page.getByRole("link", { name: "เข้าสู่ระบบเพื่อดำเนินการต่อ" }).click();
  await finishSignIn(page, customerEmail, "th");
  await expect(page).toHaveURL(/\/th\/checkout\?sku=MONTHLY-PASS$/);
  await expect(page.getByRole("button", { name: "ออกจากระบบ" })).toBeVisible();

  await page.getByRole("button", { name: "Switch language to English" }).click();
  await expect(page).toHaveURL(/\/en\/checkout\?sku=MONTHLY-PASS$/);
  await expect(page.getByRole("heading", { name: "Confirm your pack" })).toBeVisible();
  await page.goto("/en/tracking");
  await expect(page.getByRole("heading", { name: "Track your order" })).toBeVisible();
  await page.goto("/en/account");
  await expect(page.getByRole("heading", { name: "Your purchases" })).toBeVisible();
  await expect(page.locator(".account-email")).toContainText(customerEmail);

  const monthlyOrder = await createPaidOrder(page, "MONTHLY-PASS", 1, `uid-month-${suffix}`, "en");
  await page.goto("/en/checkout?sku=MONTHLY-PASS");
  await expect(page.locator(".notice-error")).toContainText("limited to 1");
  await expect(page.getByRole("button", { name: "Continue to payment" })).toBeDisabled();

  await createPaidOrder(page, "FLASH-SKIN-01", 2, `uid-skin-${suffix}`, "en");
  await page.goto("/en/checkout?sku=FLASH-SKIN-01");
  await expect(page.locator(".notice-error")).toContainText("limited to 2");
  await expect(page.getByRole("button", { name: "Continue to payment" })).toBeDisabled();

  await createPaidOrder(page, "DIAMOND-1000", 1, `uid-diamond-${suffix}`, "en", "SAVE10");
  await page.goto("/en/checkout?sku=DIAMOND-1000");
  await page.getByLabel("Game UID").fill(`uid-repeat-${suffix}`);
  await page.getByLabel("Discount code").fill("SAVE10");
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.locator(".notice-error")).toContainText("already used");
  await expect(page.locator(".order-id-block")).toHaveCount(0);

  await page.goto("/en/account");
  await expect(page.locator(".account-email")).toContainText(customerEmail);
  const monthlyRow = page.locator("tr", { hasText: monthlyOrder });
  await monthlyRow.getByLabel(`Reason for refund ${monthlyOrder}`).fill("Automated customer refund request");
  await monthlyRow.getByRole("button", { name: "Request refund" }).click();
  await expect(page.getByRole("status")).toContainText("Refund request sent");
  await expect(monthlyRow).toContainText("Under review");

  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, adminEmail, "en");
  await expect(page).toHaveURL(/\/en\/admin$/);
  const refundSection = page.locator(".admin-card").filter({
    has: page.getByRole("heading", { name: "Refund requests" })
  });
  const refundRow = refundSection.locator("tr", { hasText: monthlyOrder });
  await expect(refundRow).toBeVisible();
  await refundRow.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status")).toContainText("Refund approved");
  await expect.poll(async () => page.evaluate(async (id) => {
    const response = await fetch("/api/v1/admin/orders");
    const orders = await response.json() as Array<{ id: string; status: string }>;
    return orders.find((item) => item.id === id)?.status;
  }, monthlyOrder), { timeout: 30_000 }).toBe("REFUNDED");
});
