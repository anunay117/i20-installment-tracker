const corsHeaders = {
  "Access-Control-Allow-Origin": "https://anunay117.github.io",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_RECEIPT_CHARS = 1_600_000;
const SESSION_DAYS = 120;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders, ...extraHeaders }
  });
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const array of arrays) { out.set(array, offset); offset += array.length; }
  return out;
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hash(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function accessCodeHash(value, role, env) {
  if (!env.ACCESS_CODE_PEPPER) throw new Error("Code protection is not configured.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.ACCESS_CODE_PEPPER),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`autopay:${role}:${value.trim()}`));
  return base64url(new Uint8Array(signature));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function nowIso() { return new Date().toISOString(); }

async function readJson(request) {
  const text = await request.text();
  if (text.length > 1_800_000) throw new Error("Request is too large.");
  return JSON.parse(text || "{}");
}

async function actorFor(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  return env.DB.prepare(`SELECT id, role, display_name FROM sessions
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
    .bind(await hash(token), nowIso()).first();
}

async function requireActor(request, env, role = null) {
  const actor = await actorFor(request, env);
  if (!actor) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
  if (role && actor.role !== role) throw Object.assign(new Error("You do not have access to this action."), { status: 403 });
  return actor;
}

async function audit(env, actor, action, entityType, entityId, details = {}) {
  await env.DB.prepare(`INSERT INTO audit_events
    (id, actor_session, actor_name, actor_role, action, entity_type, entity_id, details, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), actor?.id || null, actor?.display_name || "System", actor?.role || "system",
      action, entityType, entityId || null, JSON.stringify(details), nowIso()).run();
}

async function setup(request, env) {
  if (!env.BOOTSTRAP_TOKEN) return json({ error: "Initial setup is not configured." }, 503);
  const body = await readJson(request);
  if (!constantTimeEqual(body.bootstrapToken, env.BOOTSTRAP_TOKEN)) return json({ error: "Setup code is incorrect." }, 403);
  const used = await env.DB.prepare("SELECT completed_at FROM app_setup WHERE id = 1").first();
  if (await env.DB.prepare("SELECT role FROM access_codes WHERE role = 'owner'").first()) {
    return json({ error: "A custom owner code is set. Sign in with that code; bootstrap recovery is disabled." }, 403);
  }
  const displayName = String(body.displayName || "Anunay").trim().slice(0, 50) || "Anunay";
  const token = randomToken();
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  const statements = [];
  if (!used) statements.push(env.DB.prepare("INSERT INTO app_setup (id, completed_at) VALUES (1, ?)").bind(createdAt));
  else statements.push(env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE role = 'owner' AND revoked_at IS NULL").bind(createdAt));
  statements.push(
    env.DB.prepare("INSERT INTO sessions (id, token_hash, role, display_name, created_at, expires_at) VALUES (?, ?, 'owner', ?, ?, ?)")
      .bind(id, await hash(token), displayName, createdAt, expiresAt),
    env.DB.prepare(`INSERT INTO audit_events
      (id, actor_session, actor_name, actor_role, action, entity_type, entity_id, details, occurred_at)
      VALUES (?, ?, ?, 'owner', ?, 'app', 'tracker', '{}', ?)`)
      .bind(crypto.randomUUID(), id, displayName, used ? "owner_access_recovered" : "initial_setup", createdAt)
  );
  await env.DB.batch(statements);
  return json({ token, role: "owner", displayName, expiresAt });
}

async function loginWithAccessCode(request, env) {
  const body = await readJson(request);
  const role = String(body.role || "");
  const code = String(body.code || "").trim();
  if (!['owner', 'friend'].includes(role) || code.length < 8 || code.length > 128) {
    return json({ error: "Enter a valid access code." }, 400);
  }
  const configured = await env.DB.prepare("SELECT code_hash FROM access_codes WHERE role = ?").bind(role).first();
  let valid = false;
  if (configured) valid = constantTimeEqual(configured.code_hash, await accessCodeHash(code, role, env));
  else if (role === "owner") valid = constantTimeEqual(code, env.BOOTSTRAP_TOKEN);
  if (!valid) return json({ error: "That access code is incorrect or not set up." }, 403);

  const displayName = role === "owner" ? "Anunay" : (String(body.displayName || "Friend").trim().slice(0, 50) || "Friend");
  const token = randomToken(), id = crypto.randomUUID(), createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, token_hash, role, display_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, await hash(token), role, displayName, createdAt, expiresAt),
    env.DB.prepare(`INSERT INTO audit_events
      (id, actor_session, actor_name, actor_role, action, entity_type, entity_id, details, occurred_at)
      VALUES (?, ?, ?, ?, 'access_code_login', 'session', ?, '{}', ?)`)
      .bind(crypto.randomUUID(), id, displayName, role, id, createdAt)
  ]);
  return json({ token, role, displayName, expiresAt });
}

async function setAccessCodes(request, env, actor) {
  if (actor.role !== "owner") return json({ error: "Only Anunay can set access codes." }, 403);
  const body = await readJson(request);
  const ownerCode = String(body.ownerCode || "").trim();
  const friendCode = String(body.friendCode || "").trim();
  if (ownerCode.length < 8 || ownerCode.length > 128 || friendCode.length < 8 || friendCode.length > 128) {
    return json({ error: "Each code must be between 8 and 128 characters." }, 400);
  }
  if (ownerCode === friendCode) return json({ error: "Choose different codes for owner and friend." }, 400);
  const updatedAt = nowIso();
  const ownerHash = await accessCodeHash(ownerCode, "owner", env);
  const friendHash = await accessCodeHash(friendCode, "friend", env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO access_codes (role, code_hash, updated_at) VALUES ('owner', ?, ?)
      ON CONFLICT(role) DO UPDATE SET code_hash = excluded.code_hash, updated_at = excluded.updated_at`).bind(ownerHash, updatedAt),
    env.DB.prepare(`INSERT INTO access_codes (role, code_hash, updated_at) VALUES ('friend', ?, ?)
      ON CONFLICT(role) DO UPDATE SET code_hash = excluded.code_hash, updated_at = excluded.updated_at`).bind(friendHash, updatedAt)
  ]);
  await audit(env, actor, "access_codes_updated", "access_codes", "owner-and-friend", { ownerConfigured: true, friendConfigured: true });
  return json({ ok: true, ownerConfigured: true, friendConfigured: true });
}

async function claimInvite(request, env) {
  const body = await readJson(request);
  const inviteToken = String(body.inviteToken || "");
  if (inviteToken.length < 30) return json({ error: "This invite link is invalid or expired." }, 400);
  const tokenHash = await hash(inviteToken);
  const invite = await env.DB.prepare(`SELECT token_hash, role FROM invites
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`).bind(tokenHash, nowIso()).first();
  if (!invite) return json({ error: "This invite link is invalid or expired." }, 404);
  const changed = await env.DB.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(nowIso(), tokenHash).run();
  if (!changed.meta?.changes) return json({ error: "This invite link has already been used." }, 409);
  const displayName = String(body.displayName || "Friend").trim().slice(0, 50) || "Friend";
  const token = randomToken();
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, token_hash, role, display_name, created_at, expires_at) VALUES (?, ?, 'friend', ?, ?, ?)")
      .bind(id, await hash(token), displayName, createdAt, expiresAt),
    env.DB.prepare(`INSERT INTO audit_events
      (id, actor_session, actor_name, actor_role, action, entity_type, entity_id, details, occurred_at)
      VALUES (?, ?, ?, 'friend', 'invite_claimed', 'session', ?, '{}', ?)`)
      .bind(crypto.randomUUID(), id, displayName, id, createdAt)
  ]);
  return json({ token, role: "friend", displayName, expiresAt });
}

async function calculateBalance(env, includePending = true) {
  const [plan, totals] = await Promise.all([
    env.DB.prepare("SELECT * FROM plan WHERE id = 1").first(),
    env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END), 0) AS approved,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) AS pending
      FROM payments`).first()
  ]);
  if (!plan) throw new Error("Plan is not configured.");
  const principal = Math.max(0, plan.sale_price - plan.down_payment);
  return { plan, principal, approved: totals.approved, pending: includePending ? totals.pending : 0,
    balance: Math.max(0, principal - totals.approved), available: Math.max(0, principal - totals.approved - totals.pending) };
}

async function status(request, env) {
  const actor = await requireActor(request, env);
  const { plan, principal, approved, pending, balance, available } = await calculateBalance(env);
  const [approvedPayments, pendingPayments, events] = await Promise.all([
    env.DB.prepare(`SELECT id, amount, paid_at, status, submitted_by, submitted_name, submitted_at,
      reviewed_name, reviewed_at, review_note FROM payments WHERE status = 'approved' ORDER BY paid_at DESC`).all(),
    actor.role === "owner"
      ? env.DB.prepare(`SELECT id, amount, paid_at, status, submitted_by, submitted_name, submitted_at, review_note
          FROM payments WHERE status = 'pending' ORDER BY submitted_at ASC`).all()
      : env.DB.prepare(`SELECT id, amount, paid_at, status, submitted_at, review_note
          FROM payments WHERE submitted_by = ? AND status != 'approved' ORDER BY submitted_at DESC`).bind(actor.id).all(),
    actor.role === "owner"
      ? env.DB.prepare(`SELECT id, actor_name, actor_role, action, entity_type, entity_id, details, occurred_at
          FROM audit_events ORDER BY occurred_at DESC LIMIT 100`).all()
      : { results: [] }
  ]);
  return json({ actor: { role: actor.role, displayName: actor.display_name }, plan,
    summary: { principal, approved, pending, balance, available,
      paidInstallments: approvedPayments.results.length,
      plannedInstallments: Math.ceil(principal / plan.monthly_installment) },
    payments: approvedPayments.results, pendingPayments: pendingPayments.results, audit: events.results });
}

async function createInvite(request, env, actor) {
  const token = randomToken();
  const tokenHash = await hash(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO invites (token_hash, role, created_by, created_at, expires_at) VALUES (?, 'friend', ?, ?, ?)")
    .bind(tokenHash, actor.id, createdAt, expiresAt).run();
  await audit(env, actor, "friend_invite_created", "invite", tokenHash.slice(0, 12), { expiresAt });
  return json({ inviteToken: token, expiresAt });
}

async function submitPayment(request, env, actor, ctx) {
  const body = await readJson(request);
  const amount = Number(body.amount);
  const paidAt = String(body.paidAt || "");
  const receipt = String(body.receipt || "");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(receipt);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 275000) return json({ error: "Enter a valid payment amount." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) return json({ error: "Choose the payment date." }, 400);
  if (!match || receipt.length > MAX_RECEIPT_CHARS) return json({ error: "Add a screenshot smaller than 1.2 MB." }, 400);
  const { available } = await calculateBalance(env);
  if (amount > available) return json({ error: `Only ₹${available.toLocaleString("en-IN")} is available for another submission while other payments are pending review.` }, 409);
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  await env.DB.prepare(`INSERT INTO payments
    (id, amount, paid_at, status, receipt_mime, receipt_data, submitted_by, submitted_name, submitted_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
    .bind(id, amount, paidAt, match[1], match[2], actor.id, actor.display_name, createdAt).run();
  await audit(env, actor, "payment_submitted", "payment", id, { amount, paidAt, receiptMime: match[1] });
  ctx.waitUntil(notifyRole(env, "owner", {
    title: "EMI payment needs review",
    body: `${actor.display_name} submitted a payment. Open AutoPay to review it.`,
    tag: `emi-pending-${id}`
  }));
  return json({ id, status: "pending", amount, paidAt, submittedAt: createdAt }, 201);
}

async function paymentAction(request, env, actor, paymentId, action, ctx) {
  const payment = await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(paymentId).first();
  if (!payment) return json({ error: "Payment record not found." }, 404);
  if (payment.status !== "pending") return json({ error: "This payment was already reviewed." }, 409);
  const body = await readJson(request);
  if (action === "approve") {
    const { available } = await calculateBalance(env);
    // The payment being reviewed currently reserves this amount as pending.
    const roomIncludingThisPayment = available + payment.amount;
    if (payment.amount > roomIncludingThisPayment) return json({ error: "This payment exceeds the remaining balance." }, 409);
    const changedAt = nowIso();
    await env.DB.prepare(`UPDATE payments SET status = 'approved', reviewed_by = ?, reviewed_name = ?, reviewed_at = ?, review_note = NULL
      WHERE id = ? AND status = 'pending'`)
      .bind(actor.id, actor.display_name, changedAt, paymentId).run();
    await audit(env, actor, "payment_approved", "payment", paymentId, { amount: payment.amount, paidAt: payment.paid_at });
    ctx.waitUntil(notifyRole(env, "friend", {
      title: "Anunay approved your EMI",
      body: "Your payment is now part of the tracker.",
      tag: `emi-approved-${paymentId}`
    }));
    return json({ id: paymentId, status: "approved" });
  }
  const note = String(body.note || "").trim().slice(0, 250);
  if (!note) return json({ error: "Add a short note explaining what needs correction." }, 400);
  const changedAt = nowIso();
  await env.DB.prepare(`UPDATE payments SET status = 'rejected', reviewed_by = ?, reviewed_name = ?, reviewed_at = ?, review_note = ?
    WHERE id = ? AND status = 'pending'`)
    .bind(actor.id, actor.display_name, changedAt, note, paymentId).run();
  await audit(env, actor, "payment_rejected", "payment", paymentId, { amount: payment.amount, note });
  ctx.waitUntil(notifyRole(env, "friend", {
    title: "EMI submission needs an update",
    body: "Anunay left a note. Open AutoPay to review it.",
    tag: `emi-rejected-${paymentId}`
  }));
  return json({ id: paymentId, status: "rejected" });
}

async function receipt(request, env, actor, paymentId) {
  const payment = await env.DB.prepare(`SELECT id, status, receipt_mime, receipt_data, submitted_by
    FROM payments WHERE id = ?`).bind(paymentId).first();
  if (!payment) return json({ error: "Receipt not found." }, 404);
  if (actor.role !== "owner" && payment.submitted_by !== actor.id) return json({ error: "You do not have access to this receipt." }, 403);
  return json({ id: payment.id, status: payment.status,
    receipt: `data:${payment.receipt_mime};base64,${payment.receipt_data}` });
}

async function saveSubscription(request, env, actor) {
  const subscription = await readJson(request);
  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth || subscription.endpoint.length > 2048) {
    return json({ error: "This browser returned an invalid push subscription." }, 400);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO push_subscriptions (id, session_id, role, endpoint, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET session_id = excluded.session_id, role = excluded.role,
      p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`)
    .bind(id, actor.id, actor.role, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, nowIso()).run();
  await audit(env, actor, "push_notifications_enabled", "device", id, {});
  return json({ ok: true });
}

async function sendVapid(endpoint, env) {
  const keyJwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", keyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const audience = new URL(endpoint).origin;
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64url(encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 3600 })));
  const unsigned = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned)));
  return `${unsigned}.${base64url(signature)}`;
}

async function encryptPushMessage(subscription, message) {
  const userPublic = fromBase64url(subscription.p256dh);
  const authSecret = fromBase64url(subscription.auth);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const userKey = await crypto.subtle.importKey("raw", userPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: userKey }, ephemeral.privateKey, 256));
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const info = concat(encoder.encode("WebPush: info\0"), userPublic, serverPublic);
  const ikmKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt: authSecret, info
  }, ikmKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmForContent = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cekBytes = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("Content-Encoding: aes128gcm\0")
  }, ikmForContent, 128));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("Content-Encoding: nonce\0")
  }, ikmForContent, 96));
  const cek = await crypto.subtle.importKey("raw", cekBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = concat(encoder.encode(JSON.stringify(message)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cek, plaintext));
  const recordSize = new Uint8Array([0, 0, 16, 0]);
  return concat(salt, recordSize, new Uint8Array([serverPublic.length]), serverPublic, ciphertext);
}

async function sendPush(env, subscription, message) {
  try {
    const jwt = await sendVapid(subscription.endpoint, env);
    const body = await encryptPushMessage(subscription, message);
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "60",
        Urgency: "high"
      },
      body
    });
    if (response.status === 404 || response.status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(subscription.endpoint).run();
    }
  } catch (error) {
    console.error("Web Push delivery failed", error?.message || error);
  }
}

async function notifyRole(env, role, message) {
  const { results } = await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE role = ?`).bind(role).all();
  await Promise.all(results.map(subscription => sendPush(env, subscription, message)));
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method === "GET" && path === "push-key") return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
  if (request.method === "POST" && path === "setup") return setup(request, env);
  if (request.method === "POST" && path === "login") return loginWithAccessCode(request, env);
  if (request.method === "POST" && path === "claim-invite") return claimInvite(request, env);

  const actor = await requireActor(request, env);
  if (request.method === "GET" && path === "status") return status(request, env);
  if (request.method === "POST" && path === "access-codes") return setAccessCodes(request, env, actor);
  if (request.method === "POST" && path === "invites") {
    if (actor.role !== "owner") return json({ error: "Only Anunay can create friend invites." }, 403);
    return createInvite(request, env, actor);
  }
  if (request.method === "POST" && path === "payments") {
    if (actor.role !== "friend") return json({ error: "Only the invited friend can submit a payment." }, 403);
    return submitPayment(request, env, actor, ctx);
  }
  if (request.method === "POST" && /^payments\/[a-f0-9-]+\/(approve|reject)$/.test(path)) {
    if (actor.role !== "owner") return json({ error: "Only Anunay can review a payment." }, 403);
    const [, paymentId, action] = path.split("/");
    return paymentAction(request, env, actor, paymentId, action, ctx);
  }
  if (request.method === "GET" && /^payments\/[a-f0-9-]+\/receipt$/.test(path)) {
    const paymentId = path.split("/")[1];
    return receipt(request, env, actor, paymentId);
  }
  if (request.method === "POST" && path === "push-subscriptions") return saveSubscription(request, env, actor);
  if (request.method === "POST" && path === "plan") {
    if (actor.role !== "owner") return json({ error: "Only Anunay can edit the plan." }, 403);
    const body = await readJson(request);
    const name = String(body.carName || "i20 Active").trim().slice(0, 50) || "i20 Active";
    const salePrice = Number(body.salePrice), downPayment = Number(body.downPayment), monthly = Number(body.monthlyInstallment);
    if (![salePrice, downPayment, monthly].every(Number.isInteger) || salePrice < downPayment || downPayment < 0 || monthly < 1) {
      return json({ error: "Enter valid plan amounts." }, 400);
    }
    const old = await env.DB.prepare("SELECT * FROM plan WHERE id = 1").first();
    await env.DB.prepare(`UPDATE plan SET car_name = ?, sale_price = ?, down_payment = ?, down_payment_date = ?,
      monthly_installment = ?, first_installment_date = ?, updated_at = ? WHERE id = 1`)
      .bind(name, salePrice, downPayment, String(body.downPaymentDate || old.down_payment_date), monthly,
        String(body.firstInstallmentDate || old.first_installment_date), nowIso()).run();
    await audit(env, actor, "plan_updated", "plan", "1", { before: old, after: { name, salePrice, downPayment, monthly } });
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== "https://anunay117.github.io" && !origin.startsWith("http://localhost:")) {
      return new Response("Origin not allowed.", { status: 403 });
    }
    try { return await route(request, env, ctx); }
    catch (error) {
      console.error("API request failed", error?.message || error);
      return json({ error: error.status ? error.message : "Something went wrong. Try again." }, error.status || 500);
    }
  }
};
