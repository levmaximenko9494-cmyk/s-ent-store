import express from "express";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import ExcelJS from "exceljs";
import { fileURLToPath } from "url";

dotenv.config();

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  console.error("JWT_SECRET is required");
  process.exit(1);
}

// Partner tokens use a distinct signing key and cannot authenticate as admins.
const PARTNER_SECRET = process.env.PARTNER_JWT_SECRET || `${SECRET}:partners`;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});
const auth = (req, res, next) => {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Требуется авторизация" });
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, SECRET);

    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Недействительный токен" });
  }
};
const partnerAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Требуется вход партнёра" });
    }
    const decoded = jwt.verify(header.slice(7), PARTNER_SECRET, { audience: "scent-partner" });
    const partnerId = Number(decoded.sub);
    if (!Number.isInteger(partnerId) || partnerId <= 0) {
      return res.status(401).json({ error: "Недействительный токен партнёра" });
    }
    const result = await pool.query(
      `SELECT id,email,contact_name,phone,company,inn,status,created_at,approved_at
       FROM partners WHERE id=$1`,
      [partnerId]
    );
    const partner = result.rows[0];
    if (!partner) return res.status(401).json({ error: "Партнёр не найден" });
    if (partner.status !== "approved") {
      return res.status(403).json({ error: "Доступ партнёра приостановлен" });
    }
    req.partner = partner;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Недействительный токен партнёра" });
  }
};
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(extension === ".xlsx" ? null : new Error("Разрешены только XLSX-файлы"), extension === ".xlsx");
  }
});
const importPreviews = new Map();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins(
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partners(
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      company TEXT,
      inn TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'blocked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    ALTER TABLE partners
      ALTER COLUMN company DROP NOT NULL,
      ALTER COLUMN inn DROP NOT NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      notes TEXT NOT NULL,
      price INTEGER NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS products_id_seq;
  `);

  await pool.query(`
    SELECT setval(
      'products_id_seq',
      COALESCE((SELECT MAX(id) FROM products), 0) + 1,
      false
    );
  `);

  await pool.query(`
    ALTER TABLE products
    ALTER COLUMN id SET DEFAULT nextval('products_id_seq');
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders(
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      address TEXT NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'paid', 'processing', 'shipped', 'completed', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS brand TEXT,
      ADD COLUMN IF NOT EXISTS volume TEXT,
      ADD COLUMN IF NOT EXISTS sku TEXT,
      ADD COLUMN IF NOT EXISTS wholesale_price INTEGER,
      ADD COLUMN IF NOT EXISTS min_qty INTEGER;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique
    ON products(sku) WHERE sku IS NOT NULL;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'products_wholesale_price_nonnegative'
          AND conrelid = 'products'::regclass
      ) THEN
        ALTER TABLE products ADD CONSTRAINT products_wholesale_price_nonnegative
          CHECK (wholesale_price IS NULL OR wholesale_price >= 0);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'products_min_qty_positive'
          AND conrelid = 'products'::regclass
      ) THEN
        ALTER TABLE products ADD CONSTRAINT products_min_qty_positive
          CHECK (min_qty IS NULL OR min_qty > 0);
      END IF;
    END
    $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items(
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      qty INTEGER NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_requests(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT,
      comment TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS suppliers(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      default_markup_percent NUMERIC(7,2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (default_markup_percent IS NULL OR default_markup_percent >= 0)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS supplier_offers(
      id BIGSERIAL PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      supplier_sku TEXT NOT NULL,
      original_name TEXT NOT NULL,
      purchase_price NUMERIC(14,2) NOT NULL CHECK (purchase_price >= 0),
      currency CHAR(3) NOT NULL DEFAULT 'USD',
      automatic_sale_price NUMERIC(14,2),
      manual_sale_price NUMERIC(14,2),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (supplier_id, supplier_sku),
      CHECK (automatic_sale_price IS NULL OR automatic_sale_price >= 0),
      CHECK (manual_sale_price IS NULL OR manual_sale_price >= 0)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS supplier_price_history(
      id BIGSERIAL PRIMARY KEY,
      supplier_offer_id BIGINT NOT NULL REFERENCES supplier_offers(id) ON DELETE CASCADE,
      old_price NUMERIC(14,2) NOT NULL,
      new_price NUMERIC(14,2) NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const products = [
    [1,"Santal 01","woody","Сандал · Кедр · Амбра",8900,20],
    [2,"Rose No. 7","floral","Роза · Ирис · Мускус",7600,18],
    [3,"Thé Vert","fresh","Зелёный чай · Бергамот · Нероли",6900,25],
    [4,"Velours","floral","Пион · Ваниль · Белый мускус",8200,14],
    [5,"Bois Noir","woody","Ветивер · Пачули · Кожа",9400,12],
    [6,"Côte Blanche","fresh","Морская соль · Лимон · Кедр",7300,20],
    [7,"Ambre 24","unisex","Амбра · Тонка · Ладан",9700,10],
    [8,"Fleur Blanche","unisex","Жасмин · Груша · Сандал",7800,15]
  ];

  const count = (await pool.query("SELECT COUNT(*)::int AS c FROM products")).rows[0].c;
  if (!count) {
    for (const p of products) {
      await pool.query(
        `INSERT INTO products(id,name,category,notes,price,stock)
         VALUES($1,$2,$3,$4,$5,$6)`,
        p
      );
    }
  }

  const adminCount = (await pool.query("SELECT COUNT(*)::int AS c FROM admins")).rows[0].c;
  if (!adminCount) {
    const email = process.env.ADMIN_EMAIL || "admin@scent-store.ru";
    const pass = process.env.ADMIN_PASSWORD || "change-this-password";
    const hash = await bcrypt.hash(pass, 12);
    await pool.query(
      "INSERT INTO admins(email,password_hash) VALUES($1,$2)",
      [email, hash]
    );
  }
}

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const partnerAuthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use("/api/", apiLimiter);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function validateProductExtensions(product, partial = false) {
  const values = {};
  for (const field of ["brand", "volume", "sku"]) {
    if (partial && !hasOwn(product, field)) continue;
    const raw = product[field];
    if (raw != null && typeof raw !== "string") {
      return { error: `${field} должен быть строкой` };
    }
    values[field] = typeof raw === "string" ? raw.trim() || null : null;
  }

  if (!partial || hasOwn(product, "wholesale_price")) {
    const raw = product.wholesale_price;
    if (raw == null || raw === "") values.wholesale_price = null;
    else {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        return { error: "Оптовая цена должна быть целым неотрицательным числом" };
      }
      values.wholesale_price = value;
    }
  }

  if (!partial || hasOwn(product, "min_qty")) {
    const raw = product.min_qty;
    if (raw == null || raw === "") values.min_qty = null;
    else {
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: "Минимальная партия должна быть положительным целым числом" };
      }
      values.min_qty = value;
    }
  }
  return { values };
}

function excelCellValue(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "result")) return value.result ?? "";
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text ?? "").join("");
    if (typeof value.text === "string") return value.text;
  }
  return cell.text || "";
}
const normalizeHeader = value => String(value ?? "").trim().toLocaleLowerCase("ru-RU");
function normalizePurchasePrice(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const text = String(value ?? "").trim().replace(/\s/g, "").replace(/\$/g, "");
  if (!text) return null;
  let normalized = text;
  if (text.includes(",") && text.includes(".")) {
    normalized = text.lastIndexOf(",") > text.lastIndexOf(".")
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if (text.includes(",")) {
    normalized = text.replace(",", ".");
  }
  const price = Number(normalized);
  return Number.isFinite(price) && price >= 0 ? price : null;
}
async function parseXlsxPrice(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer, { ignoreNodes: ["dataValidations"] });
  } catch (error) {
    throw new Error("Файл повреждён или не является поддерживаемым XLSX-файлом");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("В XLSX нет листов с данными");
  const wanted = { "артикул": "supplier_sku", "наименование": "original_name", "цена": "purchase_price" };
  let headerRowNumber = -1;
  let columns = null;
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const normalized = Array.from({ length: row.cellCount }, (_, index) =>
      normalizeHeader(excelCellValue(row.getCell(index + 1)))
    );
    if (Object.keys(wanted).every(header => normalized.includes(header))) {
      headerRowNumber = rowNumber;
      columns = Object.fromEntries(Object.entries(wanted).map(([header, field]) => [field, normalized.indexOf(header)]));
      break;
    }
  }
  if (headerRowNumber < 0) throw new Error("Не найдена строка заголовков: Артикул, Наименование, Цена");

  const items = [];
  let skipped = 0;
  const seen = new Set();
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = Array.from({ length: row.cellCount }, (_, index) => excelCellValue(row.getCell(index + 1)));
    if (values.every(value => String(value ?? "").trim() === "")) continue;
    const supplierSku = String(excelCellValue(row.getCell(columns.supplier_sku + 1)) ?? "").trim();
    const originalName = String(excelCellValue(row.getCell(columns.original_name + 1)) ?? "");
    const purchasePrice = normalizePurchasePrice(excelCellValue(row.getCell(columns.purchase_price + 1)));
    if (!supplierSku || !originalName.trim() || purchasePrice === null || seen.has(supplierSku)) {
      skipped += 1;
      continue;
    }
    seen.add(supplierSku);
    items.push({ supplier_sku: supplierSku, original_name: originalName, purchase_price: purchasePrice.toFixed(2) });
  }
  if (!items.length) throw new Error("В файле нет корректных позиций для импорта");
  return { items, skipped, foundColumns: ["Артикул", "Наименование", "Цена"] };
}



app.get("/api/products", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,name,category,notes,price,stock,active,
              brand,volume,sku,wholesale_price,min_qty
       FROM products WHERE active=TRUE ORDER BY id`
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.post("/api/orders", async (req, res) => {
  const { name, phone, email, address, items } = req.body || {};
  if (!name || !phone || !email || !address || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: "Заполните все поля заказа" });

  const quantities = new Map();
  for (const item of items) {
    const productId = Number(item?.productId);
    const qty = Number(item?.qty);
    if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ error: "Некорректные товар или количество" });
    }
    quantities.set(productId, (quantities.get(productId) || 0) + qty);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const checked = [];
    let total = 0;

    for (const [productId, qty] of quantities) {
      const r = await client.query(
        "SELECT id,name,price,stock FROM products WHERE id=$1 AND active=TRUE FOR UPDATE",
        [productId]
      );
      const p = r.rows[0];
      if (!p) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Товар не найден" });
      }
      if (p.stock < qty) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Недостаточно товара: ${p.name}` });
      }

      const updated = await client.query(
        "UPDATE products SET stock=stock-$1 WHERE id=$2 AND stock >= $1 RETURNING id",
        [qty, p.id]
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Недостаточно товара: ${p.name}` });
      }

      checked.push({ ...p, qty });
      total += p.price * qty;
    }

    const order = await client.query(
      `INSERT INTO orders(customer_name,phone,email,address,total)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [name, phone, email, address, total]
    );
    const orderId = order.rows[0].id;

    for (const p of checked) {
      await client.query(
        `INSERT INTO order_items(order_id,product_id,name,price,qty)
         VALUES($1,$2,$3,$4,$5)`,
        [orderId, p.id, p.name, p.price, p.qty]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ orderId, total, status: "new" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Не удалось создать заказ" });
  } finally {
    client.release();
  }
});

app.post("/api/price-requests", async (req, res) => {
  const { name, phone, email, company, comment } = req.body || {};
  const required = [name, phone, email];
  if (required.some(value => typeof value !== "string" || !value.trim())) {
    return res.status(400).json({ error: "Укажите имя, телефон и email" });
  }
  try {
    const request = await pool.query(
      `INSERT INTO price_requests(name,phone,email,company,comment)
       VALUES($1,$2,$3,$4,$5) RETURNING id,status`,
      [
        name.trim(), phone.trim(), email.trim(),
        typeof company === "string" ? company.trim() || null : null,
        typeof comment === "string" ? comment.trim() || null : null
      ]
    );
    res.status(201).json(request.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось отправить запрос прайс-листа" });
  }
});

app.post("/api/partners/register", partnerAuthLimiter, async (req, res) => {
  const { email, password, contact_name, phone } = req.body || {};
  if ([email, password, contact_name, phone]
    .some(value => typeof value !== "string" || !value.trim())) {
    return res.status(400).json({ error: "Заполните все поля регистрации" });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: "Укажите корректный email" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Пароль должен содержать не менее 8 символов" });
  }
  try {
    const existing = await pool.query("SELECT id FROM partners WHERE email=$1", [normalizedEmail]);
    if (existing.rowCount) {
      return res.status(409).json({ error: "Партнёр с таким email уже зарегистрирован" });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO partners(email,password_hash,contact_name,phone)
       VALUES($1,$2,$3,$4) RETURNING id,status`,
      [normalizedEmail, passwordHash, contact_name.trim(), phone.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Партнёр с таким email уже зарегистрирован" });
    }
    res.status(500).json({ error: "Не удалось отправить заявку партнёра" });
  }
});

app.post("/api/partners/login", partnerAuthLimiter, async (req, res) => {
  const normalizedEmail = typeof req.body?.email === "string"
    ? req.body.email.trim().toLowerCase()
    : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  try {
    const result = await pool.query(
      "SELECT id,password_hash,status FROM partners WHERE email=$1",
      [normalizedEmail]
    );
    const partner = result.rows[0];
    if (!partner || !(await bcrypt.compare(password, partner.password_hash))) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }
    if (partner.status === "pending") {
      return res.status(403).json({ error: "Ваша заявка ожидает подтверждения" });
    }
    if (partner.status === "rejected") {
      return res.status(403).json({ error: "Заявка партнёра отклонена. Свяжитесь с менеджером SCENTÉVIA" });
    }
    if (partner.status === "blocked") {
      return res.status(403).json({ error: "Доступ партнёра заблокирован. Свяжитесь с менеджером SCENTÉVIA" });
    }
    const token = jwt.sign({}, PARTNER_SECRET, {
      subject: String(partner.id), audience: "scent-partner", expiresIn: "8h"
    });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка входа партнёра" });
  }
});

app.get("/api/partners/me", partnerAuth, (req, res) => {
  res.json(req.partner);
});

app.post("/api/admin/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await pool.query("SELECT * FROM admins WHERE email=$1", [email]);
    const a = r.rows[0];
    if (!a || !(await bcrypt.compare(password || "", a.password_hash)))
      return res.status(401).json({ error: "Неверный email или пароль" });

    res.json({ token: jwt.sign({ id: a.id, email: a.email }, SECRET, { expiresIn: "8h" }) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка входа" });
  }
});

app.get("/api/admin/orders", auth, async (req, res) => {
  try {
    const orders = (await pool.query("SELECT * FROM orders ORDER BY id DESC")).rows;
    const items = (await pool.query("SELECT * FROM order_items ORDER BY id")).rows;
    const byOrder = new Map();
    for (const item of items) {
      if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
      byOrder.get(item.order_id).push(item);
    }
    res.json(orders.map(o => ({ ...o, items: byOrder.get(o.id) || [] })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.get("/api/admin/price-requests", auth, async (req, res) => {
  try {
    const requests = await pool.query(
      `SELECT id,name,phone,email,company,comment,status,created_at
       FROM price_requests ORDER BY created_at DESC, id DESC`
    );
    res.json(requests.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.get("/api/admin/partners", auth, async (req, res) => {
  try {
    const partners = await pool.query(
      `SELECT id,email,contact_name,phone,status,created_at,approved_at
       FROM partners
       ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, created_at DESC, id DESC`
    );
    res.json(partners.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.patch("/api/admin/partners/:id/status", auth, async (req, res) => {
  const allowed = ["approved", "rejected", "blocked"];
  if (!allowed.includes(req.body?.status)) {
    return res.status(400).json({ error: "Недопустимый статус партнёра" });
  }
  const partnerId = Number(req.params.id);
  if (!Number.isInteger(partnerId) || partnerId <= 0) {
    return res.status(400).json({ error: "Некорректный партнёр" });
  }
  try {
    const result = await pool.query(
      `UPDATE partners
       SET status=$1,
           approved_at=CASE WHEN $1='approved' THEN NOW() ELSE approved_at END
       WHERE id=$2 RETURNING id,status,approved_at`,
      [req.body.status, partnerId]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Партнёр не найден" });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось изменить статус партнёра" });
  }
});

app.patch("/api/admin/orders/:id", auth, async (req, res) => {
  const allowed = ["new", "paid", "processing", "shipped", "completed", "cancelled"];
  if (!allowed.includes(req.body.status))
    return res.status(400).json({ error: "Недопустимый статус" });
  try {
    await pool.query("UPDATE orders SET status=$1 WHERE id=$2", [
      req.body.status, Number(req.params.id)
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.get("/api/admin/suppliers", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id,s.name,s.active,s.default_markup_percent,s.created_at,s.updated_at,
              COUNT(o.id)::int AS offers_count,
              COUNT(o.id) FILTER (WHERE o.active)::int AS active_offers_count
       FROM suppliers s LEFT JOIN supplier_offers o ON o.supplier_id=s.id
       GROUP BY s.id ORDER BY s.name,s.id`
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось загрузить поставщиков" });
  }
});

app.post("/api/admin/suppliers", auth, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const markupRaw = req.body?.default_markup_percent;
  const markup = markupRaw === "" || markupRaw == null ? null : Number(markupRaw);
  if (!name) return res.status(400).json({ error: "Укажите название поставщика" });
  if (markup !== null && (!Number.isFinite(markup) || markup < 0)) {
    return res.status(400).json({ error: "Наценка должна быть неотрицательным числом" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO suppliers(name,default_markup_percent) VALUES($1,$2)
       RETURNING id,name,active,default_markup_percent,created_at,updated_at`,
      [name, markup]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось создать поставщика" });
  }
});

app.patch("/api/admin/suppliers/:id", auth, async (req, res) => {
  const supplierId = Number(req.params.id);
  if (!Number.isInteger(supplierId) || supplierId <= 0) {
    return res.status(400).json({ error: "Некорректный поставщик" });
  }
  const hasActive = hasOwn(req.body || {}, "active");
  const hasMarkup = hasOwn(req.body || {}, "default_markup_percent");
  if (!hasActive && !hasMarkup) return res.status(400).json({ error: "Нет изменений" });
  if (hasActive && typeof req.body.active !== "boolean") {
    return res.status(400).json({ error: "active должен быть логическим значением" });
  }
  const markupRaw = req.body?.default_markup_percent;
  const markup = markupRaw === "" || markupRaw == null ? null : Number(markupRaw);
  if (hasMarkup && markup !== null && (!Number.isFinite(markup) || markup < 0)) {
    return res.status(400).json({ error: "Наценка должна быть неотрицательным числом" });
  }
  try {
    const result = await pool.query(
      `UPDATE suppliers SET
         active=CASE WHEN $1 THEN $2 ELSE active END,
         default_markup_percent=CASE WHEN $3 THEN $4 ELSE default_markup_percent END,
         updated_at=NOW()
       WHERE id=$5 RETURNING id,name,active,default_markup_percent,created_at,updated_at`,
      [hasActive, hasActive ? req.body.active : null, hasMarkup, markup, supplierId]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Поставщик не найден" });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось изменить поставщика" });
  }
});

app.get("/api/admin/suppliers/:id/offers", auth, async (req, res) => {
  const supplierId = Number(req.params.id);
  if (!Number.isInteger(supplierId) || supplierId <= 0) {
    return res.status(400).json({ error: "Некорректный поставщик" });
  }
  const paginationRequested = ["search", "page", "limit"].some(key => hasOwn(req.query, key));
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const page = req.query.page == null || req.query.page === "" ? 1 : Number(req.query.page);
  const limit = req.query.limit == null || req.query.limit === "" ? 25 : Number(req.query.limit);
  if (search.length > 200) {
    return res.status(400).json({ error: "Поисковый запрос слишком длинный" });
  }
  if (paginationRequested && (!Number.isInteger(page) || page < 1)) {
    return res.status(400).json({ error: "Некорректный номер страницы" });
  }
  if (paginationRequested && ![25, 50, 100].includes(limit)) {
    return res.status(400).json({ error: "Допустимое количество строк: 25, 50 или 100" });
  }
  try {
    if (paginationRequested) {
      const where = search
        ? "supplier_id=$1 AND (supplier_sku ILIKE $2 OR original_name ILIKE $2)"
        : "supplier_id=$1";
      const values = search ? [supplierId, `%${search}%`] : [supplierId];
      const limitParameter = values.length + 1;
      const offsetParameter = values.length + 2;
      const [countResult, offersResult] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total FROM supplier_offers WHERE ${where}`, values),
        pool.query(
          `SELECT id,supplier_sku,original_name,purchase_price,currency,
                  automatic_sale_price,manual_sale_price,active,imported_at,updated_at
           FROM supplier_offers WHERE ${where}
           ORDER BY active DESC,supplier_sku,id LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
          [...values, limit, (page - 1) * limit]
        )
      ]);
      const total = countResult.rows[0].total;
      return res.json({
        items: offersResult.rows,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      });
    }
    const result = await pool.query(
      `SELECT id,supplier_sku,original_name,purchase_price,currency,
              automatic_sale_price,manual_sale_price,active,imported_at,updated_at
       FROM supplier_offers WHERE supplier_id=$1 ORDER BY active DESC,supplier_sku LIMIT 500`,
      [supplierId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось загрузить предложения" });
  }
});

const receiveXlsx = (req, res, next) => xlsxUpload.single("file")(req, res, error => {
  if (error) return res.status(400).json({ error: error.message || "Не удалось загрузить XLSX" });
  next();
});

app.post("/api/admin/suppliers/:id/import-preview", auth, receiveXlsx, async (req, res) => {
  const supplierId = Number(req.params.id);
  if (!Number.isInteger(supplierId) || supplierId <= 0 || !req.file) {
    return res.status(400).json({ error: req.file ? "Некорректный поставщик" : "Выберите XLSX-файл" });
  }
  try {
    const supplier = await pool.query("SELECT id FROM suppliers WHERE id=$1", [supplierId]);
    if (!supplier.rowCount) return res.status(404).json({ error: "Поставщик не найден" });
    const parsed = await parseXlsxPrice(req.file.buffer);
    const previewToken = crypto.randomUUID();
    const now = Date.now();
    for (const [token, preview] of importPreviews) {
      if (preview.expiresAt <= now) importPreviews.delete(token);
    }
    importPreviews.set(previewToken, {
      supplierId, adminId: req.admin.id, fileName: req.file.originalname,
      items: parsed.items, skipped: parsed.skipped, expiresAt: now + PREVIEW_TTL_MS
    });
    res.json({
      previewToken, fileName: req.file.originalname, foundColumns: parsed.foundColumns,
      validRows: parsed.items.length, skippedRows: parsed.skipped,
      sample: parsed.items.slice(0, 5), currency: "USD", expiresInMinutes: 30
    });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "Не удалось прочитать XLSX" });
  }
});

app.post("/api/admin/suppliers/:id/import-confirm", auth, async (req, res) => {
  const supplierId = Number(req.params.id);
  const previewToken = typeof req.body?.previewToken === "string" ? req.body.previewToken : "";
  const preview = importPreviews.get(previewToken);
  if (!preview || preview.expiresAt <= Date.now()) {
    if (preview) importPreviews.delete(previewToken);
    return res.status(400).json({ error: "Предпросмотр не найден или истёк. Загрузите файл снова." });
  }
  if (preview.supplierId !== supplierId || preview.adminId !== req.admin.id) {
    return res.status(403).json({ error: "Предпросмотр создан для другого поставщика или администратора" });
  }
  importPreviews.delete(previewToken);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const supplier = await client.query("SELECT id FROM suppliers WHERE id=$1 FOR UPDATE", [supplierId]);
    if (!supplier.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Поставщик не найден" });
    }
    let created = 0;
    let priceChanged = 0;
    let unchanged = 0;
    for (const item of preview.items) {
      const existing = await client.query(
        `SELECT id,purchase_price FROM supplier_offers
         WHERE supplier_id=$1 AND supplier_sku=$2 FOR UPDATE`,
        [supplierId, item.supplier_sku]
      );
      if (!existing.rowCount) {
        await client.query(
          `INSERT INTO supplier_offers
             (supplier_id,supplier_sku,original_name,purchase_price,currency,active,imported_at,updated_at)
           VALUES($1,$2,$3,$4,'USD',TRUE,NOW(),NOW())`,
          [supplierId, item.supplier_sku, item.original_name, item.purchase_price]
        );
        created += 1;
        continue;
      }
      const offer = existing.rows[0];
      const changed = Number(offer.purchase_price) !== Number(item.purchase_price);
      if (changed) {
        await client.query(
          `INSERT INTO supplier_price_history(supplier_offer_id,old_price,new_price)
           VALUES($1,$2,$3)`,
          [offer.id, offer.purchase_price, item.purchase_price]
        );
        priceChanged += 1;
      } else {
        unchanged += 1;
      }
      await client.query(
        `UPDATE supplier_offers SET original_name=$1,purchase_price=$2,currency='USD',
           active=TRUE,imported_at=NOW(),updated_at=NOW() WHERE id=$3`,
        [item.original_name, item.purchase_price, offer.id]
      );
    }
    const deactivated = await client.query(
      `UPDATE supplier_offers SET active=FALSE,updated_at=NOW()
       WHERE supplier_id=$1 AND active=TRUE AND NOT (supplier_sku = ANY($2::text[]))`,
      [supplierId, preview.items.map(item => item.supplier_sku)]
    );
    await client.query("COMMIT");
    res.json({
      processed: preview.items.length, created, priceChanged, unchanged,
      deactivated: deactivated.rowCount, skipped: preview.skipped
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Импорт отменён: данные не были изменены" });
  } finally {
    client.release();
  }
});

app.get("/api/admin/products", auth, async (req, res) => {
  try {
    res.json((await pool.query("SELECT * FROM products ORDER BY id")).rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.post("/api/admin/products", auth, async (req, res) => {
  const product = req.body || {};
  const { name, category, notes, price, stock } = product;
  if (!name || !category || !notes || !Number(price))
    return res.status(400).json({ error: "Нужны name/category/notes/price" });
  const extension = validateProductExtensions(product);
  if (extension.error) return res.status(400).json({ error: extension.error });
  const { brand, volume, sku, wholesale_price, min_qty } = extension.values;
  try {
    const r = await pool.query(
      `INSERT INTO products(name,category,notes,price,stock,brand,volume,sku,wholesale_price,min_qty)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [name, category, notes, Number(price), Number(stock) || 0,
       brand, volume, sku, wholesale_price, min_qty]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    if (e.code === "23505") return res.status(409).json({ error: "Такой артикул уже существует" });
    res.status(500).json({ error: "Не удалось добавить товар" });
  }
});

app.patch("/api/admin/products/:id", auth, async (req, res) => {
  const p = req.body || {};
  const extension = validateProductExtensions(p, true);
  if (extension.error) return res.status(400).json({ error: extension.error });
  const value = field => extension.values[field] ?? null;
  const changes = field => hasOwn(extension.values, field);
  try {
    await pool.query(
      `UPDATE products SET
       name=COALESCE($1,name), category=COALESCE($2,category),
       notes=COALESCE($3,notes), price=COALESCE($4,price),
       stock=COALESCE($5,stock), active=COALESCE($6,active),
       brand=CASE WHEN $7 THEN $8 ELSE brand END,
       volume=CASE WHEN $9 THEN $10 ELSE volume END,
       sku=CASE WHEN $11 THEN $12 ELSE sku END,
       wholesale_price=CASE WHEN $13 THEN $14 ELSE wholesale_price END,
       min_qty=CASE WHEN $15 THEN $16 ELSE min_qty END
       WHERE id=$17`,
      [
        p.name ?? null, p.category ?? null, p.notes ?? null,
        p.price ?? null, p.stock ?? null, p.active ?? null,
        changes("brand"), value("brand"),
        changes("volume"), value("volume"),
        changes("sku"), value("sku"),
        changes("wholesale_price"), value("wholesale_price"),
        changes("min_qty"), value("min_qty"),
        Number(req.params.id)
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    if (e.code === "23505") return res.status(409).json({ error: "Такой артикул уже существует" });
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});
app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "admin.html"))
);

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Scent Store listening on ${PORT}`));
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
