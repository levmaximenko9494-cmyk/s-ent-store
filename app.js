const products=[
{id:1,name:"Santal 01",category:"woody",notes:"Сандал · Кедр · Амбра",price:8900,tone:"tone1"},
{id:2,name:"Rose No. 7",category:"floral",notes:"Роза · Ирис · Мускус",price:7600,tone:"tone2"},
{id:3,name:"Thé Vert",category:"fresh",notes:"Зелёный чай · Бергамот · Нероли",price:6900,tone:"tone3"},
{id:4,name:"Velours",category:"floral",notes:"Пион · Ваниль · Белый мускус",price:8200,tone:"tone4"},
{id:5,name:"Bois Noir",category:"woody",notes:"Ветивер · Пачули · Кожа",price:9400,tone:"tone5"},
{id:6,name:"Côte Blanche",category:"fresh",notes:"Морская соль · Лимон · Кедр",price:7300,tone:"tone3"},
{id:7,name:"Ambre 24",category:"unisex",notes:"Амбра · Тонка · Ладан",price:9700,tone:"tone1"},
{id:8,name:"Fleur Blanche",category:"unisex",notes:"Жасмин · Груша · Сандал",price:7800,tone:"tone4"}];
let cart=JSON.parse(localStorage.getItem("scent-cart")||"[]");
const PARTNER_TOKEN_KEY="scent-partner-token";
let approvedPartner=null;
const reducedMotion=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if(!reducedMotion) document.documentElement.classList.add("motion-ready");

function initRevealAnimations(){
 if(reducedMotion||!("IntersectionObserver" in window))return;
 const targets=document.querySelectorAll("#catalog .section-top, #products, .story, .features, footer");
 targets.forEach(target=>target.classList.add("reveal"));
 const observer=new IntersectionObserver(entries=>{
  entries.forEach(entry=>{
   if(!entry.isIntersecting)return;
   entry.target.classList.add("is-visible");
   observer.unobserve(entry.target);
  });
 },{threshold:.12,rootMargin:"0px 0px -45px"});
 targets.forEach(target=>observer.observe(target));
}
async function loadServerProducts(){
 try{
  const r=await fetch("/api/products"); if(!r.ok)return;
  const data=await r.json();
  if(data.length) products.splice(0,products.length,...data.map(p=>({...p,tone:["tone1","tone2","tone3","tone4","tone5"][p.id%5]})));
  renderProducts(); renderCart();
 }catch(e){}
}
const money=n=>n.toLocaleString("ru-RU")+" ₽";
const escapeHtml=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
function renderProducts(list = products) {
  document.querySelector("#products").innerHTML = list.length
    ? list.map(p => `
      <article class="product">

        <div class="visual product-photo-wrap">
          <div class="product-photo-placeholder"><span>SCENTÉVIA</span><small>Фото товара скоро появится</small></div>
          ${p.image_url ? `<img class="product-photo" src="${escapeHtml(p.image_url)}" alt="${escapeHtml(`${p.brand ? `${p.brand} ` : ""}${p.name}`)}" loading="lazy" onerror="this.remove()">` : ""}
        </div>

        <div class="details">
          ${p.brand ? `<small class="product-brand">${escapeHtml(p.brand)}</small>` : ""}
          <h3>${escapeHtml(p.name)}</h3>
          ${p.volume || p.sku ? `<div class="product-meta">${p.volume ? `<span>${escapeHtml(p.volume)}</span>` : ""}${p.sku ? `<span>Артикул: ${escapeHtml(p.sku)}</span>` : ""}</div>` : ""}

          <div class="catalog-actions">
            <button class="price-request" type="button" onclick="requestProductPrice(${p.id})">Запросить цену</button>
          </div>
        </div>

      </article>
    `).join("")
    : "<p>Товары не найдены</p>";
}
       
function addToCart(id){cart.push(id);save();openCart()}
function save(){localStorage.setItem("scent-cart",JSON.stringify(cart));renderCart()}
function renderCart(){const box=document.querySelector("#cartItems");document.querySelector("#cartCount").textContent=cart.length;if(!cart.length){box.innerHTML='<p style="color:#766f68">Оптовая корзина пуста. Добавьте товары из каталога.</p>'}else{box.innerHTML=cart.map((id,i)=>{const p=products.find(x=>x.id===id);return `<div class="cart-item"><div class="cart-thumb ${p.tone}"></div><div><h4>${p.name}</h4><div>${money(p.price)} за единицу</div><button class="remove" onclick="removeItem(${i})">Удалить</button></div></div>`}).join("")}document.querySelector("#cartTotal").textContent=money(cart.reduce((s,id)=>s+products.find(p=>p.id===id).price,0))}
function removeItem(i){cart.splice(i,1);save()}
function openCart(){document.querySelector("#drawer").classList.add("open");renderCart()}
 document.querySelectorAll(".filters button").forEach(b=>b.onclick=()=>{document.querySelectorAll(".filters button").forEach(x=>x.classList.remove("active"));b.classList.add("active");const c=b.dataset.cat;renderProducts(c==="all"?products:products.filter(p=>p.category===c))});
document.querySelector("#cartOpen").onclick=openCart;document.querySelector("#cartClose").onclick=()=>document.querySelector("#drawer").classList.remove("open");
document.querySelector("#checkout").onclick=()=>{if(!cart.length)return alert("Сначала добавьте товары в оптовую корзину.");document.querySelector("#drawer").classList.remove("open");document.querySelector("#modal").classList.add("open")};
document.querySelector("#modalClose").onclick=()=>document.querySelector("#modal").classList.remove("open");
const priceRequestModal=document.querySelector("#priceRequestModal");
const priceRequestStatus=document.querySelector("#priceRequestStatus");
const priceRequestForm=document.querySelector("#priceRequestForm");
function openPriceRequest(product=null){
 priceRequestStatus.textContent="";
 priceRequestStatus.className="form-status";
 if(product){
  const reference=[product.brand,product.name,product.volume,product.sku&&`арт. ${product.sku}`].filter(Boolean).join(" · ");
  priceRequestForm.elements.comment.value=`Интересует актуальная оптовая цена: ${reference}`;
 }
 priceRequestModal.classList.add("open");
}
function requestProductPrice(id){
 const product=products.find(item=>item.id===id);
 if(product)openPriceRequest(product);
}
window.requestProductPrice=requestProductPrice;
document.querySelector("#priceRequestOpen").onclick=()=>openPriceRequest();
document.querySelector("#priceRequestClose").onclick=()=>priceRequestModal.classList.remove("open");
priceRequestForm.onsubmit=async e=>{
 e.preventDefault();
 const button=e.submitter;
 if(!button||button.disabled)return;
 button.disabled=true;
 priceRequestStatus.textContent="Отправляем запрос…";
 priceRequestStatus.className="form-status";
 try{
  const f=new FormData(e.target);
  const r=await fetch("/api/price-requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:f.get("name"),phone:f.get("phone"),email:f.get("email"),company:f.get("company"),comment:f.get("comment")})});
  let data={};
  try{data=await r.json()}catch(e){}
  if(!r.ok)throw new Error(data.error||"Не удалось отправить запрос");
  e.target.reset();
  priceRequestStatus.textContent="Запрос отправлен. Менеджер свяжется с вами в ближайшее время.";
  priceRequestStatus.className="form-status success";
 }catch(error){
  priceRequestStatus.textContent=error.message||"Не удалось связаться с сервером. Попробуйте ещё раз.";
  priceRequestStatus.className="form-status error";
 }finally{
  button.disabled=false;
 }
};
const partnerModal=document.querySelector("#partnerModal");
const partnerStatus=document.querySelector("#partnerStatus");
const partnerLoginForm=document.querySelector("#partnerLoginForm");
const partnerRegisterForm=document.querySelector("#partnerRegisterForm");
const partnerOpen=document.querySelector("#partnerOpen");
const partnerLogout=document.querySelector("#partnerLogout");
function showPartnerTab(tab){
 document.querySelectorAll("[data-partner-tab]").forEach(button=>button.classList.toggle("active",button.dataset.partnerTab===tab));
 partnerLoginForm.hidden=tab!=="login";
 partnerRegisterForm.hidden=tab!=="register";
 partnerStatus.textContent="";
 partnerStatus.className="form-status";
}
partnerOpen.onclick=()=>{showPartnerTab("login");partnerModal.classList.add("open")};
document.querySelector("#partnerClose").onclick=()=>partnerModal.classList.remove("open");
document.querySelectorAll("[data-partner-tab]").forEach(button=>button.onclick=()=>showPartnerTab(button.dataset.partnerTab));
partnerRegisterForm.onsubmit=async e=>{
 e.preventDefault();
 const button=e.submitter;
 if(!button||button.disabled)return;
 button.disabled=true;
 partnerStatus.textContent="Отправляем заявку…";
 partnerStatus.className="form-status";
 try{
  const f=new FormData(e.target);
  const r=await fetch("/api/partners/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.fromEntries(f))});
  let data={};
  try{data=await r.json()}catch(e){}
  if(!r.ok)throw new Error(data.error||"Не удалось отправить заявку");
  e.target.reset();
  partnerStatus.textContent="Заявка отправлена. После проверки мы откроем доступ к оптовым условиям SCENTÉVIA.";
  partnerStatus.className="form-status success";
 }catch(error){
  partnerStatus.textContent=error.message||"Не удалось связаться с сервером. Попробуйте ещё раз.";
  partnerStatus.className="form-status error";
 }finally{button.disabled=false}
};
partnerLoginForm.onsubmit=async e=>{
 e.preventDefault();
 const button=e.submitter;
 if(!button||button.disabled)return;
 button.disabled=true;
 partnerStatus.textContent="Проверяем данные…";
 partnerStatus.className="form-status";
 try{
  const f=new FormData(e.target);
  const r=await fetch("/api/partners/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.fromEntries(f))});
  let data={};
  try{data=await r.json()}catch(e){}
  if(!r.ok)throw new Error(data.error||"Не удалось войти");
  localStorage.setItem(PARTNER_TOKEN_KEY,data.token);
  e.target.reset();
  await restorePartnerSession();
  partnerModal.classList.remove("open");
 }catch(error){
  localStorage.removeItem(PARTNER_TOKEN_KEY);
  partnerStatus.textContent=error.message||"Не удалось связаться с сервером. Попробуйте ещё раз.";
  partnerStatus.className="form-status error";
 }finally{button.disabled=false}
};
function updatePartnerUi(){
 partnerOpen.textContent=approvedPartner?.contact_name||"Для партнёров";
 partnerLogout.hidden=!approvedPartner;
 document.body.classList.toggle("partner-approved",Boolean(approvedPartner));
}
async function clearPartnerSession(){
 localStorage.removeItem(PARTNER_TOKEN_KEY);
 approvedPartner=null;
 updatePartnerUi();
 await loadServerProducts();
}
async function restorePartnerSession(){
 const token=localStorage.getItem(PARTNER_TOKEN_KEY);
 if(!token){approvedPartner=null;updatePartnerUi();await loadServerProducts();return}
 try{
  const me=await fetch("/api/partners/me",{headers:{Authorization:`Bearer ${token}`}});
  if(!me.ok)throw new Error("Сессия недействительна");
  const partner=await me.json();
  if(partner.status!=="approved")throw new Error("Нет партнёрского доступа");
  approvedPartner=partner;
  updatePartnerUi();
  await loadServerProducts();
 }catch(e){await clearPartnerSession()}
}
partnerLogout.onclick=clearPartnerSession;
document.querySelector("#orderForm").onsubmit=async e=>{
 e.preventDefault();
 const button=e.submitter||e.target.querySelector('button[type="submit"], button:not([type])');
 if(button.disabled)return;
 button.disabled=true;
 try{
  const f=new FormData(e.target);
  const items=cart.map(id=>({productId:id,qty:1}));
  const r=await fetch("/api/orders",{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({name:f.get("name"),phone:f.get("phone"),email:f.get("email"),address:f.get("address"),items})});
  let d={};
  try{d=await r.json()}catch(e){}
  if(!r.ok){alert(d.error||"Не удалось оформить заказ");return}
  alert("Оптовый заказ #"+d.orderId+" принят!");
  cart=[];save();e.target.reset();document.querySelector("#modal").classList.remove("open")
 }catch(e){
  alert("Не удалось связаться с сервером. Проверьте подключение и попробуйте снова.")
 }finally{
  button.disabled=false;
 }
};
document.querySelector("#searchOpen").onclick=()=>{const q=prompt("Что ищем? Например: Rose");if(q===null)return;renderProducts(products.filter(p=>(p.name+" "+p.notes).toLowerCase().includes(q.toLowerCase())))};
renderProducts();renderCart();initRevealAnimations();restorePartnerSession();
