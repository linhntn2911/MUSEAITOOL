"use strict";
const $=id=>document.getElementById(id);let state={config:{},queue:[],logs:[]},products=[],character="",filter="all",previewCache=new Map();
function toast(m){const e=$("toast");e.textContent=m;e.style.display="block";clearTimeout(toast.t);toast.t=setTimeout(()=>e.style.display="none",3500)}
function esc(v){return String(v||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c])}
function selected(){return [...document.querySelectorAll('.job-check:checked')].map(e=>e.value)}
function label(s){return({pending:"Chờ chạy",running:"Đang tạo",completed:"Hoàn tất",error:"Bị lỗi"})[s]||s}
async function loadPreviews(paths){const missing=[...new Set(paths.filter(Boolean))].filter(p=>!previewCache.has(p));if(!missing.length)return;const list=await window.museApp.previewFiles(missing);list.forEach(x=>previewCache.set(x.path,x));}
function thumb(item,index,kind){return `<div class="thumb"><img src="${item.dataUrl}" title="${esc(item.name)}"><button data-remove-${kind}="${index}">×</button></div>`}
async function renderChosen(){await loadPreviews([...products,character]);$("productPreviews").innerHTML=products.map((p,i)=>thumb(previewCache.get(p),i,"product")).join("");$("characterPreview").innerHTML=character?thumb(previewCache.get(character),0,"character"):"";$("productCount").textContent=`${products.length} SP`;document.querySelectorAll('[data-remove-product]').forEach(b=>b.onclick=()=>{products.splice(Number(b.dataset.removeProduct),1);renderChosen()});document.querySelectorAll('[data-remove-character]').forEach(b=>b.onclick=()=>{character="";renderChosen()})}
async function render(next=state){state=next;const c=state.config||{};["aspect","duration","quality","concurrency","delaySeconds"].forEach(id=>{if(c[id]!==undefined&&document.activeElement!==$(id))$(id).value=c[id]});await loadPreviews(state.queue.map(j=>j.productImage));const q=(state.queue||[]),search=$("search").value.toLowerCase();const shown=q.filter(j=>(filter==="all"||j.status===filter)&&(!search||`${j.prompt} ${j.productImage}`.toLowerCase().includes(search)));$("queue").innerHTML=shown.map((j,i)=>{const img=previewCache.get(j.productImage),pct=Math.max(0,Math.min(100,Number(j.progress)||0));return `<tr><td><input class="job-check" type="checkbox" value="${j.id}"></td><td>${i+1}</td><td><b>${esc((j.productImage||"").split(/[\\/]/).pop())}</b></td><td class="prompt"><div class="prompt-clamp" title="${esc(j.prompt)}">${esc(j.prompt)}</div></td><td>${img?`<img class="job-img" src="${img.dataUrl}">`:"—"}</td><td>${esc(j.aspect)} · ${esc(j.duration)} · ${esc(j.quality)}</td><td><span class="status ${j.status}">${j.status==="running"?`⏳ ${pct}% · `:""}${label(j.status)}</span><div class="progress"><i style="width:${pct}%"></i></div><div class="detail">${state.control?.paused&&(state.control?.currentJobIds||[]).includes(j.id)?"⏸ Đã tạm dừng":esc(j.detail)}</div>${j.error?`<div class="error">${esc(j.error)}</div>`:""}</td><td>${j.result?.videoPath?`<button class="result-btn" data-result="${j.id}">📂 Video</button>`:"—"}</td><td><div class="row-actions"><button title="Chạy luồng này" data-play="${j.id}">▶</button><button class="delete" title="Xóa luồng" data-delete="${j.id}">🗑</button></div></td></tr>`}).join("");$("empty").style.display=q.length?"none":"block";const counts=q.reduce((a,j)=>(a[j.status]=(a[j.status]||0)+1,a),{}),overall=q.length?Math.round(q.reduce((n,j)=>n+(Number(j.progress)||0),0)/q.length):0;$("navCount").textContent=$("totalCount").textContent=q.length;$("runningCount").textContent=counts.running||0;$("doneCount").textContent=counts.completed||0;$("overallProgress").textContent=`${overall}%${state.control?.paused?" · PAUSE":""}`;$("log").textContent=(state.logs||[]).join("\n");$("log").scrollTop=$("log").scrollHeight;document.querySelectorAll('[data-result]').forEach(b=>b.onclick=()=>{const j=q.find(x=>x.id===b.dataset.result);if(j?.result?.videoPath)window.museApp.showResult(j.result.videoPath)});document.querySelectorAll('[data-play]').forEach(b=>b.onclick=()=>window.museApp.runOne(b.dataset.play).then(showAction));document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>window.museApp.removeJobs([b.dataset.delete]))}
async function saveConfig(){return window.museApp.saveConfig({aspect:$("aspect").value,duration:$("duration").value,quality:$("quality").value,concurrency:Math.max(1,Math.min(20,Number($("concurrency").value)||20)),delaySeconds:Math.max(0,Number($("delaySeconds").value)||0)})}
async function chooseProducts(){const paths=await window.museApp.chooseProductImages();products=[...new Set([...products,...paths])];await renderChosen()}
$("chooseProducts").onclick=e=>{e.stopPropagation();chooseProducts()};$("chooseCharacter").onclick=async()=>{character=await window.museApp.chooseCharacterImage();renderChosen()};
const drop=$("productDrop");["dragenter","dragover"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.add("drag")}));["dragleave","drop"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.remove("drag")}));drop.addEventListener("drop",e=>{const paths=[...e.dataTransfer.files].map(f=>f.path).filter(Boolean).filter(p=>/\.(png|jpe?g|webp)$/i.test(p));products=[...new Set([...products,...paths])];renderChosen()});
$("createJobs").onclick=async()=>{const prompt=$("prompt").value.trim();if(!prompt)return toast("Chưa có prompt");if(!products.length)return toast("Hãy chọn ít nhất một ảnh sản phẩm");const config={aspect:$("aspect").value,duration:$("duration").value,quality:$("quality").value};await saveConfig();await window.museApp.addJobs(products.map(productImage=>({prompt,productImage,characterImage:character,mode:selectedPreset,...config})));toast(`Đã tạo ${products.length} luồng — mỗi ảnh một luồng`)};
function showAction(r){toast(r?.ok?"Đã nhận lệnh":(r?.error||"Không thực hiện được"));return r}
async function play(){
  try{
    await saveConfig();
    const prompt=$("prompt").value.trim();
    const runnable=(state.queue||[]).some(j=>j.status==="pending"||j.status==="error");
    if(!runnable){
      if(!prompt)return toast("Chưa có prompt video");
      if(!products.length)return toast("Chưa có luồng và chưa chọn ảnh sản phẩm");
      const existing=new Set((state.queue||[]).filter(j=>j.status!=="completed").map(j=>j.productImage));
      const fresh=products.filter(p=>!existing.has(p));
      if(!fresh.length)return toast("Các ảnh này đã có trong hàng đợi");
      const config={aspect:$("aspect").value,duration:$("duration").value,quality:$("quality").value};
      await window.museApp.addJobs(fresh.map(productImage=>({prompt,productImage,characterImage:character,mode:selectedPreset,...config})));
      toast(`Đã tự tạo ${fresh.length} luồng — đang bắt đầu sản xuất`);
    }
    return await window.museApp.runQueue().then(showAction);
  }catch(e){toast(`Lỗi: ${e.message}`)}
}
$("run").onclick=play;$("playTop").onclick=()=>state.control?.paused?window.museApp.resumeQueue().then(showAction):play();$("pause").onclick=$("pauseTop").onclick=()=>window.museApp.pauseQueue().then(showAction);$("resume").onclick=()=>window.museApp.resumeQueue().then(showAction);$("stop").onclick=$("stopTop").onclick=()=>window.museApp.stopQueue().then(showAction);
$("openMuse").onclick=()=>window.museApp.openMuse().then(()=>toast("Đã mở Chrome riêng. Hãy đăng nhập Muse.ai"));$("checkMuse").onclick=()=>window.museApp.status().then(s=>{const ok=!!s.ok;$("connection").className=`pill ${ok?'online':'offline'}`;$("connection").textContent=ok?"Muse LIVE":"Chưa đăng nhập";$("accountBadge").textContent=ok?1:0;toast(ok?"Tài khoản Muse hoạt động":"Hãy đăng nhập Muse.ai trong Chrome")}).catch(e=>toast(e.message));$("showChrome").onclick=()=>window.museApp.showChrome();$("hideChrome").onclick=()=>window.museApp.hideChrome();
$("remove").onclick=()=>{const ids=selected();if(!ids.length)return toast("Chưa chọn luồng");window.museApp.removeJobs(ids)};$("retry").onclick=()=>window.museApp.retryJobs(selected());$("selectAll").onchange=e=>document.querySelectorAll('.job-check').forEach(x=>x.checked=e.target.checked);$("selectErrors").onclick=()=>{const wanted=new Set(state.queue.filter(j=>j.status==="pending"||j.status==="error").map(j=>j.id));document.querySelectorAll('.job-check').forEach(x=>x.checked=wanted.has(x.value))};
$("selectCompleted").onclick=async()=>{filter="all";document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x.dataset.filter==="all"));await render();const wanted=new Set(state.queue.filter(j=>j.status==="completed"&&j.result?.videoPath).map(j=>j.id));document.querySelectorAll('.job-check').forEach(x=>x.checked=wanted.has(x.value));$("selectAll").checked=false;toast(`Đã chọn ${wanted.size} video hoàn tất`)};
$("deleteCompletedVideos").onclick=async()=>{const ids=selected();if(!ids.length)return toast("Hãy bấm Chọn video xong hoặc tích các video cần xóa");const r=await window.museApp.deleteCompletedVideos(ids);if(r?.cancelled)return toast("Đã hủy xóa video");if(!r?.ok)return toast(r?.error||"Không xóa được video");toast(`Đã xóa vĩnh viễn ${r.deleted} video${r.failed?.length?` · ${r.failed.length} file lỗi`:""}`)};
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.classList.remove('active'));b.classList.add('active');filter=b.dataset.filter;render()});$("search").oninput=()=>render();$("openDownloads").onclick=$("openDownloadsTop").onclick=()=>window.museApp.openDownloads();$("clearLog").onclick=()=>$("log").textContent="";
let selectedPreset = "household";
const promptPresets={
  fashion:{
    duration:"20s",
    hint:"Thời trang: chọn ảnh người mẫu ở Ảnh nhân vật, ảnh bộ đồ ở Ảnh sản phẩm; điện thoại luôn che kín mặt.",
    prompt:`Tạo video thời trang 20 giây, tỷ lệ 9:16. Dùng ảnh người mẫu làm tham chiếu nhân vật và ảnh quần áo làm tham chiếu trang phục. Thay toàn bộ quần áo hiện tại của người mẫu bằng đúng bộ trang phục trong ảnh sản phẩm.

Khóa cứng trang phục: giữ chính xác kiểu dáng, chiều dài, tỷ lệ, form, màu sắc, chất liệu, họa tiết, đường may, cổ áo, tay áo và mọi chi tiết của quần áo gốc; không tự thiết kế lại, không kéo dài hoặc làm ngắn trang phục, không đổi màu và không thêm phụ kiện.

Giữ nguyên vóc dáng, mái tóc và làn da của người mẫu. Điện thoại phải che kín toàn bộ khuôn mặt trong suốt video; tuyệt đối không để lộ mặt ở bất kỳ khung hình, góc máy, gương hoặc hình phản chiếu nào. Khi người mẫu xoay người, điện thoại phải di chuyển theo đầu và tiếp tục che kín mặt.

Khóa cứng giải phẫu: người mẫu chỉ có đúng HAI cánh tay, HAI bàn tay và MƯỜI ngón tay. Một tay thật luôn cầm điện thoại che mặt và không được chỉnh quần áo; chỉ tay thật còn lại được chỉnh một vị trí trang phục tại một thời điểm. Tuyệt đối không sinh tay thứ ba, bàn tay bay, cánh tay mọc từ thân hoặc quần áo, tay bị nhân đôi, đổi bên, hợp nhất hay thêm ngón. Nếu xuất hiện chi thừa thì phải loại cảnh đó và tạo lại.

Chuyển động phải rõ ràng và tự nhiên: người mẫu bước vào khung hình, một tay giữ điện thoại che kín mặt, tay còn lại chỉnh nhẹ trang phục; xoay người chậm 30–45 độ để giới thiệu form; bước hai bước trong khi camera di chuyển theo; trở lại gần chính diện và tạo dáng kết thúc. Vải phải chuyển động chân thực. Không biến dạng tay chân, không thay đổi trang phục giữa các cảnh, không rung hình, không nhấp nháy và không chỉ zoom hoặc pan trên một ảnh tĩnh.`
  },
  household:{
    duration:"20s",
    hint:"Gia dụng: ảnh sản phẩm được đặt trong hộp mica; người cầm hộp tuyệt đối không lộ mặt.",
    prompt:`Sản phẩm chính nằm trong CHỈ MỘT hộp mica/acrylic trong suốt có quai xách ở tiền cảnh. Một bàn tay nữ cầm quai giới thiệu hộp. Người cầm hộp chỉ được xuất hiện từ cổ hoặc vai trở xuống; tuyệt đối không để lộ khuôn mặt trong bất kỳ khung hình, góc máy, gương hoặc phản chiếu trên hộp mica nào. Camera wide-angle 24–28mm, đứng đủ xa, nhìn thấy trọn hộp từ quai đến đáy và phần lớn cửa hàng phía sau. Hộp chiếm khoảng 45–55% chiều cao khung hình, tạo nhiều khoảng thở để thấy rõ quy mô cửa hàng. Đặt số lượng lớn sản phẩm giống chính xác ảnh tham chiếu vào hộp. Bàn tay nâng, xoay và giới thiệu hộp tự nhiên; camera tracking nhẹ để tạo chuyển động rõ ràng.`
  },
  store:{
    duration:"20s",
    hint:"Cửa hàng: video giới thiệu sản phẩm trong không gian bán lẻ quy mô lớn.",
    prompt:`Tạo video giới thiệu sản phẩm trong một cửa hàng quy mô lớn, tỷ lệ 9:16. Giữ sản phẩm giống chính xác ảnh tham chiếu về hình dáng, tỷ lệ, bao bì, nhãn, logo, chữ và màu sắc. Camera wide-angle 24–28mm nhìn thấy rõ sản phẩm ở tiền cảnh và nhiều kệ hàng phía sau. Một bàn tay chỉ xuất hiện từ cổ hoặc vai trở xuống để cầm và giới thiệu sản phẩm; tuyệt đối không lộ khuôn mặt qua góc máy, gương hoặc bề mặt phản chiếu. Bàn tay xoay sản phẩm nhẹ 25–35 độ, camera tracking ngang tạo parallax rõ ràng rồi kết thúc ở góc hero shot. Không tạo ảnh tĩnh chỉ zoom hoặc rung nhẹ.`
  }
};
document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{
  const preset=promptPresets[b.dataset.preset];
  selectedPreset=b.dataset.preset;
  if(!preset)return;
  $("prompt").value=(b.dataset.preset==="fashion" ? "[FASHION_TRY_ON_MODE — THAY NGUYÊN BỘ TRANG PHỤC]\n" : "")+preset.prompt;
  if(preset.duration)$("duration").value=preset.duration;
  if($("promptPresetHint"))$("promptPresetHint").textContent=preset.hint;
  document.querySelectorAll('[data-preset]').forEach(x=>x.classList.toggle("active",x===b));
  toast(`Đã chọn mẫu ${b.textContent.trim()} — bạn có thể sửa prompt trước khi chạy`);
});
window.museApp.onState(s=>render(s));window.museApp.onLog(line=>{const e=$("log");e.textContent+=(e.textContent?"\n":"")+line;e.scrollTop=e.scrollHeight});window.museApp.getState().then(s=>render(s));renderChosen();
