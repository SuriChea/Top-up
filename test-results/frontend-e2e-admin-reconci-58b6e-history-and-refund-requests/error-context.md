# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: frontend\e2e\admin-reconciliation.spec.ts >> checkout login gate, persistent English locale, purchase limits, account history, and refund requests
- Location: frontend\e2e\admin-reconciliation.spec.ts:179:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/th/checkout?sku=MONTHLY-PASS", waiting until "load"

```

# Test source

```ts
  83  |     return response.status;
  84  |   });
  85  |   expect(forbidden).toBe(403);
  86  |   await page.evaluate(async () => {
  87  |     const response = await fetch("/api/v1/auth/logout", { method: "POST" });
  88  |     if (!response.ok) throw new Error("Customer logout failed");
  89  |   });
  90  | 
  91  |   await signIn(page, adminEmail);
  92  |   await expect(page).toHaveURL(/\/th\/admin$/);
  93  |   await expect(page.getByRole("heading", { name: "Admin dashboard" })).toBeVisible();
  94  |   await expect(page.getByRole("heading", { name: "สินค้าและสต็อก" })).toBeVisible();
  95  | 
  96  |   await page.goto("/checkout?sku=DIAMOND-1000");
  97  |   await expect(page.getByLabel("อีเมลบัญชีที่เข้าสู่ระบบ")).toHaveValue(adminEmail);
  98  |   await page.getByLabel("Game UID").fill(`uid-${suffix}`);
  99  |   await page.getByRole("button", { name: "ดำเนินการชำระเงิน" }).click();
  100 |   const orderIdLocator = page.locator(".order-id-block strong");
  101 |   await expect(orderIdLocator).toBeVisible();
  102 |   const orderId = await orderIdLocator.innerText();
  103 |   const simulationResponse = page.waitForResponse((response) =>
  104 |     response.url().includes("/mock-pay/simulate") && response.request().method() === "POST"
  105 |   );
  106 |   await page.getByRole("button", { name: "จ่ายสำเร็จ" }).click();
  107 |   const simulation = await (await simulationResponse).json() as { eventId: string };
  108 |   await expect(page.locator(".timeline")).toContainText("เติมสำเร็จ", { timeout: 30_000 });
  109 | 
  110 |   const orderResponse = await page.evaluate(async (id) => {
  111 |     const response = await fetch("/api/v1/admin/orders");
  112 |     const orders = await response.json() as Array<{ id: string; totalSatang: number; status: string }>;
  113 |     if (!response.ok) throw new Error("Admin order list failed");
  114 |     const order = orders.find((item) => item.id === id);
  115 |     if (!order) throw new Error("Created order is missing from admin list");
  116 |     return order;
  117 |   }, orderId);
  118 |   expect(orderResponse.status).toBe("COMPLETED");
  119 | 
  120 |   await page.goto("/admin");
  121 |   await expect(page.getByRole("heading", { name: "Admin dashboard" })).toBeVisible();
  122 |   await page.getByLabel("เหตุผลคืนเงิน / หมายเหตุไม่อนุมัติ").fill("Automated end-to-end refund check");
  123 |   const orderRow = page.locator("tr", { hasText: orderId });
  124 |   await orderRow.getByRole("button", { name: "ขอคืนเงิน" }).click();
  125 |   await expect(page.getByRole("status")).toContainText("เข้าคิวแล้ว");
  126 |   await expect.poll(async () => page.evaluate(async (id) => {
  127 |     const response = await fetch("/api/v1/admin/orders");
  128 |     const orders = await response.json() as Array<{ id: string; status: string }>;
  129 |     return orders.find((item) => item.id === id)?.status;
  130 |   }, orderId), { timeout: 30_000 }).toBe("REFUNDED");
  131 | 
  132 |   const csv = [
  133 |     "event_id,order_id,amount_satang,currency,type",
  134 |     `${simulation.eventId},${orderId},${orderResponse.totalSatang},THB,payment.succeeded`
  135 |   ].join("\n");
  136 |   await page.locator('input[name="settlement"]').setInputFiles({
  137 |     name: "e2e-settlement.csv",
  138 |     mimeType: "text/csv",
  139 |     buffer: Buffer.from(csv)
  140 |   });
  141 |   await page.getByRole("button", { name: "นำเข้าและกระทบยอด" }).click();
  142 |   const firstImportNotice = page.getByRole("status");
  143 |   await expect(firstImportNotice).toContainText("ตรงกัน 1 รายการ");
  144 |   await expect(page.locator(".reconciliation-report")).toContainText("matched");
  145 |   const previousMismatches = Number(/ต้องตรวจสอบ (\d+) รายการ/.exec(await firstImportNotice.innerText())?.[1] || 0);
  146 | 
  147 |   const mismatchedCsv = [
  148 |     "event_id,order_id,amount_satang,currency,type",
  149 |     `${simulation.eventId},${orderId},${orderResponse.totalSatang + 1},THB,payment.succeeded`
  150 |   ].join("\n");
  151 |   await page.locator('input[name="settlement"]').setInputFiles({
  152 |     name: "e2e-mismatch.csv",
  153 |     mimeType: "text/csv",
  154 |     buffer: Buffer.from(mismatchedCsv)
  155 |   });
  156 |   await page.getByRole("button", { name: "นำเข้าและกระทบยอด" }).click();
  157 |   await expect(page.getByRole("status")).toContainText(`ต้องตรวจสอบ ${previousMismatches + 1} รายการ`);
  158 |   await expect(page.locator(".reconciliation-report")).toContainText("amount_mismatch");
  159 | 
  160 |   const stockField = page.getByLabel("FLASH-SKIN-01 stock");
  161 |   const stockRow = page.locator("tr", { hasText: "FLASH-SKIN-01" });
  162 |   await stockField.fill("99");
  163 |   const reduceStock = page.waitForResponse((response) =>
  164 |     response.url().includes("/api/v1/admin/products/FLASH-SKIN-01") && response.request().method() === "PATCH"
  165 |   );
  166 |   await stockRow.getByRole("button", { name: "บันทึก" }).click();
  167 |   expect((await reduceStock).ok()).toBe(true);
  168 |   await expect(page.getByLabel("FLASH-SKIN-01 stock")).toHaveValue("99");
  169 |   await expect(stockRow.getByRole("button", { name: "บันทึก" })).toBeEnabled();
  170 |   await page.getByLabel("FLASH-SKIN-01 stock").fill("100");
  171 |   const restoreStock = page.waitForResponse((response) =>
  172 |     response.url().includes("/api/v1/admin/products/FLASH-SKIN-01") && response.request().method() === "PATCH"
  173 |   );
  174 |   await stockRow.getByRole("button", { name: "บันทึก" }).click();
  175 |   expect((await restoreStock).ok()).toBe(true);
  176 |   await expect(page.getByLabel("FLASH-SKIN-01 stock")).toHaveValue("100");
  177 | });
  178 | 
  179 | test("checkout login gate, persistent English locale, purchase limits, account history, and refund requests", async ({ page }) => {
  180 |   const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  181 |   const customerEmail = `buyer-${suffix}@example.test`;
  182 | 
> 183 |   await page.goto("/th/checkout?sku=MONTHLY-PASS");
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  184 |   await expect(page.getByRole("heading", { name: "กรุณาเข้าสู่ระบบก่อนชำระเงิน" })).toBeVisible();
  185 |   const unauthenticatedCheckout = await page.evaluate(async () => {
  186 |     const response = await fetch("/api/v1/orders", {
  187 |       method: "POST",
  188 |       headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
  189 |       body: JSON.stringify({ sku: "MONTHLY-PASS", quantity: 1, email: "guest@example.test", playerId: "guest-123" })
  190 |     });
  191 |     return response.status;
  192 |   });
  193 |   expect(unauthenticatedCheckout).toBe(401);
  194 | 
  195 |   await page.getByRole("link", { name: "เข้าสู่ระบบเพื่อดำเนินการต่อ" }).click();
  196 |   await finishSignIn(page, customerEmail, "th");
  197 |   await expect(page).toHaveURL(/\/th\/checkout\?sku=MONTHLY-PASS$/);
  198 |   await expect(page.getByRole("button", { name: "ออกจากระบบ" })).toBeVisible();
  199 | 
  200 |   await page.getByRole("button", { name: "Switch language to English" }).click();
  201 |   await expect(page).toHaveURL(/\/en\/checkout\?sku=MONTHLY-PASS$/);
  202 |   await expect(page.getByRole("heading", { name: "Confirm your pack" })).toBeVisible();
  203 |   await page.goto("/en/tracking");
  204 |   await expect(page.getByRole("heading", { name: "Track your order" })).toBeVisible();
  205 |   await page.goto("/en/account");
  206 |   await expect(page.getByRole("heading", { name: "Your purchases" })).toBeVisible();
  207 |   await expect(page.locator(".account-email")).toContainText(customerEmail);
  208 | 
  209 |   const monthlyOrder = await createPaidOrder(page, "MONTHLY-PASS", 1, `uid-month-${suffix}`, "en");
  210 |   await page.goto("/en/checkout?sku=MONTHLY-PASS");
  211 |   await expect(page.getByRole("alert")).toContainText("limited to 1");
  212 |   await expect(page.getByRole("button", { name: "Continue to payment" })).toBeDisabled();
  213 | 
  214 |   await createPaidOrder(page, "FLASH-SKIN-01", 2, `uid-skin-${suffix}`, "en");
  215 |   await page.goto("/en/checkout?sku=FLASH-SKIN-01");
  216 |   await expect(page.getByRole("alert")).toContainText("limited to 2");
  217 |   await expect(page.getByRole("button", { name: "Continue to payment" })).toBeDisabled();
  218 | 
  219 |   await createPaidOrder(page, "DIAMOND-1000", 1, `uid-diamond-${suffix}`, "en", "SAVE10");
  220 |   await page.goto("/en/checkout?sku=DIAMOND-1000");
  221 |   await page.getByLabel("Game UID").fill(`uid-repeat-${suffix}`);
  222 |   await page.getByLabel("Discount code").fill("SAVE10");
  223 |   await page.getByRole("button", { name: "Continue to payment" }).click();
  224 |   await expect(page.getByRole("alert")).toContainText("already used");
  225 |   await expect(page.locator(".order-id-block")).toHaveCount(0);
  226 | 
  227 |   await page.goto("/en/account");
  228 |   await expect(page.locator(".account-email")).toContainText(customerEmail);
  229 |   const monthlyRow = page.locator("tr", { hasText: monthlyOrder });
  230 |   await monthlyRow.getByLabel(`Reason for refund ${monthlyOrder}`).fill("Automated customer refund request");
  231 |   await monthlyRow.getByRole("button", { name: "Request refund" }).click();
  232 |   await expect(page.getByRole("status")).toContainText("Refund request sent");
  233 |   await expect(monthlyRow).toContainText("Under review");
  234 | 
  235 |   await page.getByRole("button", { name: "Sign out" }).click();
  236 |   await signIn(page, adminEmail, "en");
  237 |   await expect(page).toHaveURL(/\/en\/admin$/);
  238 |   const refundRow = page.locator("tr", { hasText: monthlyOrder });
  239 |   await expect(refundRow).toBeVisible();
  240 |   await refundRow.getByRole("button", { name: "Approve" }).click();
  241 |   await expect(page.getByRole("status")).toContainText("Refund approved");
  242 |   await expect.poll(async () => page.evaluate(async (id) => {
  243 |     const response = await fetch("/api/v1/admin/orders");
  244 |     const orders = await response.json() as Array<{ id: string; status: string }>;
  245 |     return orders.find((item) => item.id === id)?.status;
  246 |   }, monthlyOrder), { timeout: 30_000 }).toBe("REFUNDED");
  247 | });
  248 | 
```