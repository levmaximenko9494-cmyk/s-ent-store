import express from "express";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const db=new Database(path.join(__dirname,"scent-store.db"));
const PORT=process.env.PORT||3000;
const SECRET=process.env.JWT_SECRET||"dev-only-change-me";

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"100kb"}));
app.use(express.static(__dirname));

db.exec(`
CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
 notes TEXT NOT NULL, price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL,
 phone TEXT NOT NULL, email TEXT NOT NULL, address TEXT NOT NULL,
 total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
 product_id INTEGER NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL,
 FOREIGN KEY(order_id) REFERENCES orders(id)
);
CREATE TABLE IF NOT EXISTS admins(
 id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL
);`);

const count=db.prepare("SELECT COUNT(*) c FROM products").get().c;
if(!count){
 const ins=db.prepare("INSERT INTO products(id,name,category,notes,price,stock) VALUES(?,?,?,?,?,?)");
 [
 [1,"Santal 01","woody","Сандал · Кедр · Амбра",8900,20],
 [2,"Rose No. 7","floral","Роза · Ирис · Мускус",7600,18],
 [3,"Thé Vert","fresh","Зелёный чай · Бергамот · Нероли",6900,25],
 [4,"Velours","floral","Пион · Ваниль · Белый мускус",8200,14],
 [5,"Bois Noir","woody","Ветивер · Пачули · Кожа",9400,12],
 [6,"Côte Blanche","fresh","Морская соль · Лимон · Кедр",7300,20],
 [7,"Ambre 24","unisex","Амбра · Тонка · Ладан",9700,10],
 [8,"Fleur Blanche","unisex","Жасмин · Груша · Сандал",7800,15]
 ].forEach(x=>ins.run(...x));
}
if(!db.prepare("SELECT 1 FROM admins LIMIT 1").get()){
 const email=process.env.ADMIN_EMAIL||"admin@scent-store.ru";
 const pass=process.env.ADMIN_PASSWORD||"change-this-password";
 db.prepare("INSERT INTO admins(email,password_hash) VALUES(?,?)").run(email,bcrypt.hashSync(pass,12));
}

const apiLimiter=rateLimit({windowMs:15*60*1000,max:200});
const loginLimiter=rateLimit({windowMs:15*60*1000,max:20});
app.use("/api/",apiLimiter);

function auth(req,res,next){
 try{
  const h=req.headers.authorization||"";
  const token=h.startsWith("Bearer ")?h.slice(7):"";
  req.admin=jwt.verify(token,SECRET); next();
 }catch{res.status(401).json({error:"Требуется авторизация"})}
}

app.get("/api/products",(req,res)=>{
 res.json(db.prepare("SELECT id,name,category,notes,price,stock,active FROM products WHERE active=1 ORDER BY id").all());
});

app.post("/api/orders",(req,res)=>{
 const {name,phone,email,address,items}=req.body||{};
 if(!name||!phone||!email||!address||!Array.isArray(items)||!items.length)
  return res.status(400).json({error:"Заполните все поля заказа"});
 const get=db.prepare("SELECT id,name,price,stock FROM products WHERE id=? AND active=1");
 const checked=[]; let total=0;
 for(const item of items){
  const p=get.get(Number(item.productId));
  const qty=Math.max(1,Math.min(99,Number(item.qty)||1));
  if(!p) return res.status(400).json({error:"Товар не найден"});
  if(p.stock<qty) return res.status(400).json({error:`Недостаточно товара: ${p.name}`});
  checked.push({...p,qty}); total+=p.price*qty;
 }
 const tx=db.transaction(()=>{
  const order=db.prepare("INSERT INTO orders(customer_name,phone,email,address,total) VALUES(?,?,?,?,?)").run(name,phone,email,address,total);
  const oi=db.prepare("INSERT INTO order_items(order_id,product_id,name,price,qty) VALUES(?,?,?,?,?)");
  const dec=db.prepare("UPDATE products SET stock=stock-? WHERE id=?");
  checked.forEach(p=>{oi.run(order.lastInsertRowid,p.id,p.name,p.price,p.qty);dec.run(p.qty,p.id)});
  return Number(order.lastInsertRowid);
 });
 const id=tx();
 res.status(201).json({orderId:id,total,status:"new"});
});

app.post("/api/admin/login",loginLimiter,(req,res)=>{
 const {email,password}=req.body||{};
 const a=db.prepare("SELECT * FROM admins WHERE email=?").get(email);
 if(!a||!bcrypt.compareSync(password||"",a.password_hash)) return res.status(401).json({error:"Неверный email или пароль"});
 res.json({token:jwt.sign({id:a.id,email:a.email},SECRET,{expiresIn:"8h"})});
});

app.get("/api/admin/orders",auth,(req,res)=>{
 const orders=db.prepare("SELECT * FROM orders ORDER BY id DESC").all();
 const items=db.prepare("SELECT * FROM order_items WHERE order_id=?");
 res.json(orders.map(o=>({...o,items:items.all(o.id)})));
});

app.patch("/api/admin/orders/:id",auth,(req,res)=>{
 const allowed=["new","paid","processing","shipped","completed","cancelled"];
 if(!allowed.includes(req.body.status)) return res.status(400).json({error:"Недопустимый статус"});
 db.prepare("UPDATE orders SET status=? WHERE id=?").run(req.body.status,req.params.id);
 res.json({ok:true});
});

app.get("/api/admin/products",auth,(req,res)=>{
 res.json(db.prepare("SELECT * FROM products ORDER BY id").all());
});
app.post("/api/admin/products",auth,(req,res)=>{
 const {name,category,notes,price,stock}=req.body||{};
 if(!name||!category||!notes||!Number(price)) return res.status(400).json({error:"Нужны name/category/notes/price"});
 const r=db.prepare("INSERT INTO products(name,category,notes,price,stock) VALUES(?,?,?,?,?)").run(name,category,notes,Number(price),Number(stock)||0);
 res.status(201).json({id:r.lastInsertRowid});
});
app.patch("/api/admin/products/:id",auth,(req,res)=>{
 const p=req.body||{};
 db.prepare("UPDATE products SET name=COALESCE(?,name),category=COALESCE(?,category),notes=COALESCE(?,notes),price=COALESCE(?,price),stock=COALESCE(?,stock),active=COALESCE(?,active) WHERE id=?")
 .run(p.name??null,p.category??null,p.notes??null,p.price??null,p.stock??null,p.active??null,req.params.id);
 res.json({ok:true});
});

app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"admin.html")));
app.listen(PORT,()=>console.log(`Scent Store: http://localhost:${PORT}`));
