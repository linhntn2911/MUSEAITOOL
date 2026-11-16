"use strict";

(function () {
  const tiktokState = {
    settings: {},
    accounts: [],
    jobs: [],
    mediaAssets: [],
    filter: "all",
    search: "",
    selectedJobIds: new Set(),
    activeAccountId: null,
    museVideos: [],
    selectedMuseVideoIds: new Set(),
    cartMode: "affiliate", // affiliate | no_cart
    autoScheduleActive: false
  };

  function toast(msg) {
    const e = document.getElementById("toast");
    if (e) {
      e.textContent = msg;
      e.style.display = "block";
      clearTimeout(toast.t);
      toast.t = setTimeout(() => (e.style.display = "none"), 3500);
    } else {
      console.log("[Toast]", msg);
    }
  }

  function esc(v) {
    return String(v || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function formatTime(isoStr) {
    if (!isoStr) return "--";
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
    } catch {
      return isoStr;
    }
  }

  function toDatetimeLocal(d) {
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function getMediaAsset(id) {
    return tiktokState.mediaAssets.find(a => a.id === id) || null;
  }

  function getAccount(id) {
    return tiktokState.accounts.find(a => a.id === id) || null;
  }

  // --- RENDER COUNTERS & STATUSBAR ---
  function updateCounters() {
    const q = tiktokState.jobs;
    const cntQueue = document.getElementById("cntQueue");
    const cntScheduled = document.getElementById("cntScheduled");
    const cntPosted = document.getElementById("cntPosted");
    const cntFailed = document.getElementById("cntFailed");
    const badgeTabTT = document.getElementById("badgeTabTT");
    const navBadge = document.getElementById("tiktokNavCount");

    const counts = {
      scheduled: 0,
      posted: 0,
      failed: 0
    };

    q.forEach(j => {
      if (j.status === "scheduled" || j.status === "ready" || j.status === "waiting_product_confirmation") counts.scheduled++;
      if (j.status === "posted") counts.posted++;
      if (j.status === "failed" || j.status === "needs_reconciliation") counts.failed++;
    });

    if (cntQueue) cntQueue.textContent = q.length;
    if (cntScheduled) cntScheduled.textContent = counts.scheduled;
    if (cntPosted) cntPosted.textContent = counts.posted;
    if (cntFailed) cntFailed.textContent = counts.failed;
    if (navBadge) navBadge.textContent = q.length;

    const anyLive = tiktokState.accounts.some(a => a.status === "live");
    if (badgeTabTT) {
      badgeTabTT.textContent = anyLive ? "Tab TT: Đã mở" : "Tab TT: Chưa mở";
      badgeTabTT.style.color = anyLive ? "#28a745" : "#a45a00";
    }
  }

  // --- 1. RENDER NHIỀU KÊNH TIKTOK ---
  function renderAccountsSidebar() {
    const sel = document.getElementById("tiktokChannelSelect");
    const liveBadge = document.getElementById("accountLiveCount");
    const cardTitle = document.getElementById("activeAccountTitle");
    const cardPort = document.getElementById("activeAccountPort");
    const cardDot = document.getElementById("activeAccountDot");
    const cardMode = document.getElementById("activeAccountModeBadge");
    const cardAlert = document.getElementById("activeAccountAlert");
    const warnName = document.getElementById("activeAccountWarnName");

    const accs = tiktokState.accounts;
    const liveCount = accs.filter(a => a.status === "live").length;
    if (liveBadge) liveBadge.textContent = `(${liveCount} LIVE / ${accs.length} kênh)`;

    if (sel) {
      if (accs.length === 0) {
        sel.innerHTML = `<option value="">-- Chưa có kênh nào --</option>`;
      } else {
        sel.innerHTML = accs.map(a => {
          const isLive = a.status === "live";
          const prefix = isLive ? "● LIVE" : "Cần ĐN";
          const selected = a.id === tiktokState.activeAccountId ? "selected" : "";
          return `<option value="${a.id}" ${selected}>[${prefix}] ${esc(a.label || a.id)}</option>`;
        }).join("");
      }
    }

    let activeAcc = accs.find(a => a.id === tiktokState.activeAccountId) || accs[0] || null;
    if (activeAcc) {
      tiktokState.activeAccountId = activeAcc.id;
      if (cardTitle) cardTitle.textContent = activeAcc.label || activeAcc.id;
      if (cardPort) cardPort.textContent = activeAcc.cdpPort || "19400";
      const isLive = activeAcc.status === "live";
      if (cardDot) {
        cardDot.className = `channel-dot ${isLive ? 'live' : 'offline'}`;
      }
      if (cardMode) {
        cardMode.textContent = tiktokState.cartMode === "affiliate" ? "🛒 Có Giỏ hàng" : "🛍 Không giỏ";
      }
      if (cardAlert && warnName) {
        if (!isLive) {
          cardAlert.style.display = "flex";
          warnName.textContent = activeAcc.label || "Kênh";
        } else {
          cardAlert.style.display = "none";
        }
      }
    } else {
      if (cardTitle) cardTitle.textContent = "Chưa có kênh nào";
      if (cardPort) cardPort.textContent = "—";
      if (cardDot) cardDot.className = "channel-dot offline";
      if (cardAlert) cardAlert.style.display = "none";
    }
  }

  // --- 2. RENDER CHỌN VIDEO ĐÃ RENDER (TỪ MUSE) ---
  async function loadMuseCompletedVideos() {
    try {
      if (!window.museApp || !window.museApp.getState) return;
      const museState = await window.museApp.getState();
      const completedJobs = (museState.queue || []).filter(j => j.result?.videoPath);
      
      tiktokState.museVideos = completedJobs.map(j => {
        const filePath = j.result.videoPath;
        const fileName = filePath.split(/[/\\\\]/).pop();
        return {
          id: j.id,
          name: fileName,
          path: filePath,
          productImage: j.productImage,
          prompt: j.prompt,
          sizeMb: "50.0"
        };
      });

      renderMuseVideoList();
    } catch (err) {
      console.warn("Không thể tải video từ Muse:", err);
    }
  }

  function renderMuseVideoList() {
    const listEl = document.getElementById("museVideoList");
    const countEl = document.getElementById("museVideoCountText");
    if (!listEl) return;

    const list = tiktokState.museVideos;
    if (list.length === 0) {
      listEl.innerHTML = `<div class="empty-hint">Chưa có video Muse đã render hoặc video chọn từ máy</div>`;
      if (countEl) countEl.textContent = "0 video (0 đã chọn)";
      return;
    }

    listEl.innerHTML = list.map(v => {
      const checked = tiktokState.selectedMuseVideoIds.has(v.id) ? "checked" : "";
      return `
        <div class="video-item-row" data-vid="${v.id}">
          <input type="checkbox" class="muse-vid-check" data-id="${v.id}" ${checked}>
          <span class="video-item-name" title="${esc(v.path)}">📹 ${esc(v.name)}</span>
          <span class="video-item-size">${v.sizeMb} MB</span>
        </div>
      `;
    }).join("");

    if (countEl) {
      countEl.textContent = `${list.length} video (${tiktokState.selectedMuseVideoIds.size} đã chọn)`;
    }
  }

  // --- 3. RENDER BẢNG HÀNG ĐỢI XUẤT BẢN ---
  function renderQueueTable() {
    const tbody = document.getElementById("tiktokQueueTbody");
    const emptyEl = document.getElementById("tiktokEmpty");
    if (!tbody) return;

    updateCounters();
    renderAccountsSidebar();

    let filtered = tiktokState.jobs;
    if (tiktokState.filter !== "all") {
      filtered = filtered.filter(j => {
        if (tiktokState.filter === "ready") return ["ready", "draft", "waiting_content", "waiting_product_confirmation"].includes(j.status);
        if (tiktokState.filter === "active") return ["opening_studio", "uploading", "filling_metadata", "submitting"].includes(j.status);
        if (tiktokState.filter === "done") return ["scheduled", "posted"].includes(j.status);
        if (tiktokState.filter === "reconcile") return j.status === "needs_reconciliation" || j.status === "failed";
        return true;
      });
    }

    if (tiktokState.search) {
      const q = tiktokState.search.toLowerCase();
      filtered = filtered.filter(j => {
        const title = (j.content?.title || "").toLowerCase();
        const caption = (j.content?.caption || "").toLowerCase();
        const prod = (j.productMatch?.title || "").toLowerCase();
        return title.includes(q) || caption.includes(q) || prod.includes(q);
      });
    }

    if (filtered.length === 0) {
      tbody.innerHTML = "";
      if (emptyEl) emptyEl.style.display = "block";
      return;
    }

    if (emptyEl) emptyEl.style.display = "none";

    tbody.innerHTML = filtered.map((job, idx) => {
      const isSelected = tiktokState.selectedJobIds.has(job.id);
      const videoAsset = getMediaAsset(job.sourceVideoAssetId);
      const imgAsset = job.productImageAssetId ? getMediaAsset(job.productImageAssetId) : null;
      const fileName = videoAsset ? videoAsset.path.split(/[/\\\\]/).pop() : job.id;

      // Caption text
      const captionText = [job.content?.title || "", (job.content?.hashtags || []).join(" ")].filter(Boolean).join("\n") || "Chưa có nội dung. Bấm để nhập hoặc AI Viết...";

      // Showcase fields
      const isCart = job.accountMode === "affiliate";
      const prodId = job.productMatch?.productId || "";
      const prodName = job.productMatch?.title || "";
      const prodConfirmed = job.productMatch?.confirmed;

      // Channel dropdown options
      const channelOptions = [
        `<option value="">Tự chọn kênh đầu</option>`,
        ...tiktokState.accounts.map(a => `<option value="${a.id}" ${a.id === job.accountId ? "selected" : ""}>${esc(a.label)}</option>`)
      ].join("");

      // Date time
      const targetTimeVal = job.schedule?.targetTime ? job.schedule.targetTime.slice(0, 16) : "";

      return `
        <tr data-job-id="${job.id}" class="${isSelected ? 'selected' : ''}">
          <td>
            <input type="checkbox" class="job-check" data-id="${job.id}" ${isSelected ? 'checked' : ''}>
          </td>
          <td>${idx + 1}</td>
          <td>
            <div class="table-video-info">
              ${imgAsset ? `<img src="${imgAsset.path}" class="table-video-thumb" onerror="this.style.display='none'">` : ''}
              <div class="table-video-name" title="${videoAsset?.path || ''}">📹 ${esc(fileName)}</div>
              ${imgAsset ? `<span class="badge-evidence">📸 Có ảnh SP đối chiếu</span>` : ''}
              <select class="channel-badge-select" data-job-id="${job.id}">
                ${channelOptions}
              </select>
            </div>
          </td>
          <td>
            <textarea class="table-caption-edit" data-job-id="${job.id}" title="Bấm để sửa tiêu đề, hashtag trực tiếp">${esc(captionText)}</textarea>
          </td>
          <td>
            <div class="showcase-cell">
              <label class="checkbox-row" style="font-size:11px;">
                <input type="checkbox" class="chk-row-cart" data-job-id="${job.id}" ${isCart ? 'checked' : ''}>
                <b>Gắn Giỏ hàng (Showcase)</b>
              </label>
              ${isCart ? `
                <div style="font-size:10px; color:${prodConfirmed ? '#28a745' : '#d48806'};">
                  ${prodConfirmed ? '✅ Đã duyệt đúng SP' : '⏳ Chờ bấm "🔍 Kiểm tra đúng SP Showcase"'}
                </div>
                <input class="showcase-input input-row-pid" data-job-id="${job.id}" placeholder="ID SP Showcase" value="${esc(prodId)}">
                <input class="showcase-input input-row-pname" data-job-id="${job.id}" placeholder="Tên SP Showcase" value="${esc(prodName)}">
              ` : '<span style="color:#8a7040;font-size:11px;">Chế độ không giỏ hàng</span>'}
            </div>
          </td>
          <td>
            <div class="row-schedule-cell">
              <select class="select-row-mode" data-job-id="${job.id}" style="font-size:11px;padding:3px;">
                <option value="native_schedule" ${job.schedule?.mode === 'native_schedule' ? 'selected' : ''}>📅 Lịch TikTok</option>
                <option value="immediate" ${job.schedule?.mode === 'immediate' ? 'selected' : ''}>⚡ Đăng ngay</option>
              </select>
              <input type="datetime-local" class="input-row-time" data-job-id="${job.id}" value="${targetTimeVal}" style="font-size:11px;padding:2px;">
              <div style="display:flex;gap:6px;font-size:10px;margin-top:2px;">
                <label><input type="checkbox" checked disabled> Gốc</label>
                <label><input type="checkbox" checked disabled> NhạcĐX</label>
              </div>
            </div>
          </td>
          <td>
            <div class="progress-cell">
              <span class="badge ${job.status === 'posted' ? 'badge-success' : job.status === 'failed' ? 'badge-danger' : 'badge-waiting'}" style="font-size:10px;">
                ${job.status === 'posted' ? 'Đã đăng' : job.status === 'scheduled' ? 'Đã lên lịch' : '⏳ Chờ kiểm/lịch'}
              </span>
              <div class="progress-bar-wrap" style="width:90px;height:4px;margin-top:4px;">
                <div class="progress-bar" style="width:${job.progress || 0}%"></div>
              </div>
              <span style="font-size:9px;color:#7a6030;display:block;margin-top:2px;">${job.progress || 0}%</span>
            </div>
          </td>
          <td>
            <div style="display:flex;gap:4px;">
              <button class="btn-icon btn-run-one" data-id="${job.id}" title="Chạy ngay dòng này">▶</button>
              <button class="btn-icon delete btn-del-one" data-id="${job.id}" title="Xóa dòng này">🗑</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  // --- EVENT LISTENERS & SETUP ---
  function setupEventListeners() {
    // Tab switching
    const tabMuse = document.getElementById("tabMuse");
    const tabTikTok = document.getElementById("tabTikTok");
    const viewMuse = document.getElementById("viewMuse");
    const viewTikTok = document.getElementById("viewTikTok");

    if (tabMuse && tabTikTok && viewMuse && viewTikTok) {
      tabMuse.addEventListener("click", () => {
        tabMuse.classList.add("active");
        tabTikTok.classList.remove("active");
        viewMuse.style.display = "flex";
        viewTikTok.style.display = "none";
      });

      tabTikTok.addEventListener("click", () => {
        tabTikTok.classList.add("active");
        tabMuse.classList.remove("active");
        viewMuse.style.display = "none";
        viewTikTok.style.display = "flex";
        loadMuseCompletedVideos();
        renderQueueTable();
      });
    }

    // Modal Add Account
    const modalAdd = document.getElementById("modalAddAccount");
    const btnOpenAdd = document.getElementById("btnOpenNewAccountModal");
    const btnCloseAdd = document.getElementById("btnCloseAddAccount");
    const btnCancelAdd = document.getElementById("btnCancelAddAccount");
    const btnConfirmAdd = document.getElementById("btnConfirmAddAccount");
    const inputLabel = document.getElementById("inputNewAccountLabel");

    if (btnOpenAdd && modalAdd) {
      btnOpenAdd.addEventListener("click", () => {
        if (inputLabel) {
          inputLabel.value = `Kênh TikTok #${tiktokState.accounts.length + 1}`;
        }
        modalAdd.style.display = "flex";
      });
    }
    const closeModal = () => { if (modalAdd) modalAdd.style.display = "none"; };
    if (btnCloseAdd) btnCloseAdd.addEventListener("click", closeModal);
    if (btnCancelAdd) btnCancelAdd.addEventListener("click", closeModal);

    if (btnConfirmAdd) {
      btnConfirmAdd.addEventListener("click", async () => {
        const label = inputLabel ? inputLabel.value.trim() : "";
        if (!label) return toast("Vui lòng nhập tên kênh");
        closeModal();

        if (window.tiktokApp && window.tiktokApp.addAccount) {
          toast(`Đang khởi tạo ${label} và mở Chrome riêng...`);
          const res = await window.tiktokApp.addAccount(label);
          if (res && res.account) {
            tiktokState.activeAccountId = res.account.id;
            // Launch Chrome immediately to TikTok Studio login page
            if (window.tiktokApp.showAccount) {
              await window.tiktokApp.showAccount(res.account.id);
            }
            toast(`Đã mở Chrome cho ${label}. Hãy đăng nhập TikTok trên cửa sổ vừa mở!`);
          }
        }
      });
    }

    // Check account single & check all
    const btnCheckCurrent = document.getElementById("btnCheckCurrentAccount");
    const btnCheckIcon = document.getElementById("btnCheckAccountSingle");
    const btnCheckAll = document.getElementById("btnCheckAllAccounts");

    const doCheckAccount = async (accId) => {
      if (!accId) return;
      toast("Đang kiểm tra đăng nhập TikTok...");
      if (window.tiktokApp && window.tiktokApp.checkAccount) {
        const res = await window.tiktokApp.checkAccount(accId);
        if (res.status === "live") {
          toast("✓ Kênh đã đăng nhập sẵn sàng (LIVE)!");
        } else {
          toast("⚠ Kênh chưa đăng nhập TikTok. Cửa sổ Chrome đã được mở để bạn đăng nhập!");
        }
      }
    };

    if (btnCheckCurrent) {
      btnCheckCurrent.addEventListener("click", () => doCheckAccount(tiktokState.activeAccountId));
    }
    if (btnCheckIcon) {
      btnCheckIcon.addEventListener("click", () => doCheckAccount(tiktokState.activeAccountId));
    }
    if (btnCheckAll) {
      btnCheckAll.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.checkAccount) {
          toast("Đang kiểm tra tất cả các kênh và mở tab Chrome đăng nhập...");
          await window.tiktokApp.checkAccount("all");
          toast("Đã kiểm tra xong các kênh. Hãy đăng nhập nếu cửa sổ yêu cầu!");
        }
      });
    }

    // Show Chrome / Hide Chrome buttons
    const btnShowChrome = document.getElementById("btnShowAccountChrome");
    const btnOpenStudio = document.getElementById("btnOpenBrowserStudio");
    const btnAlertShow = document.getElementById("btnAlertShowTab");
    const btnShowAll = document.getElementById("btnShowAllChrome");
    const btnHideAll = document.getElementById("btnHideAllChrome");

    const openActiveChrome = async () => {
      if (tiktokState.activeAccountId && window.tiktokApp && window.tiktokApp.showAccount) {
        await window.tiktokApp.showAccount(tiktokState.activeAccountId);
        toast("Đã mở cửa sổ Chrome TikTok Studio.");
      }
    };

    if (btnShowChrome) btnShowChrome.addEventListener("click", openActiveChrome);
    if (btnOpenStudio) btnOpenStudio.addEventListener("click", openActiveChrome);
    if (btnAlertShow) btnAlertShow.addEventListener("click", openActiveChrome);
    if (btnShowAll) {
      btnShowAll.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.showAccount) {
          await window.tiktokApp.showAccount("all");
          toast("Đã hiện tất cả cửa sổ Chrome TikTok.");
        }
      });
    }
    if (btnHideAll) {
      btnHideAll.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.hideAccount) {
          await window.tiktokApp.hideAccount("all");
          toast("Đã ẩn cửa sổ Chrome TikTok.");
        }
      });
    }

    // Delete account
    const btnDeleteAcc = document.getElementById("btnDeleteAccount");
    if (btnDeleteAcc) {
      btnDeleteAcc.addEventListener("click", async () => {
        if (!tiktokState.activeAccountId) return;
        if (confirm("Bạn có chắc muốn xóa kênh này không?")) {
          if (window.tiktokApp && window.tiktokApp.removeAccount) {
            await window.tiktokApp.removeAccount(tiktokState.activeAccountId, true);
            tiktokState.activeAccountId = null;
            toast("Đã xóa kênh.");
          }
        }
      });
    }

    // Channel select dropdown change
    const selAcc = document.getElementById("tiktokChannelSelect");
    if (selAcc) {
      selAcc.addEventListener("change", (e) => {
        tiktokState.activeAccountId = e.target.value;
        renderAccountsSidebar();
      });
    }

    // Toggle Cart mode buttons
    const btnModeCart = document.getElementById("btnModeCart");
    const btnModeNoCart = document.getElementById("btnModeNoCart");
    if (btnModeCart && btnModeNoCart) {
      btnModeCart.addEventListener("click", () => {
        tiktokState.cartMode = "affiliate";
        btnModeCart.classList.add("active");
        btnModeNoCart.classList.remove("active");
        renderAccountsSidebar();
      });
      btnModeNoCart.addEventListener("click", () => {
        tiktokState.cartMode = "no_cart";
        btnModeNoCart.classList.add("active");
        btnModeCart.classList.remove("active");
        renderAccountsSidebar();
      });
    }

    // Block 2: Muse video selector actions
    const btnSelectAllMuse = document.getElementById("btnSelectAllMuseVideos");
    const btnDeselectAllMuse = document.getElementById("btnDeselectAllMuseVideos");
    const btnAddExt = document.getElementById("btnAddExternalVideo");
    const btnRefMuse = document.getElementById("btnRefreshMuseVideos");

    if (btnSelectAllMuse) {
      btnSelectAllMuse.addEventListener("click", () => {
        tiktokState.selectedMuseVideoIds = new Set(tiktokState.museVideos.map(v => v.id));
        renderMuseVideoList();
      });
    }
    if (btnDeselectAllMuse) {
      btnDeselectAllMuse.addEventListener("click", () => {
        tiktokState.selectedMuseVideoIds.clear();
        renderMuseVideoList();
      });
    }
    if (btnAddExt) {
      btnAddExt.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.addFiles) {
          const res = await window.tiktokApp.addFiles();
          if (res && res.added) {
            toast(`Đã thêm ${res.added.length} video từ máy vào hàng đợi!`);
          }
        }
      });
    }
    if (btnRefMuse) {
      btnRefMuse.addEventListener("click", () => {
        loadMuseCompletedVideos();
        toast("Đã làm mới danh sách video Muse.");
      });
    }

    // List item check delegate
    const museListEl = document.getElementById("museVideoList");
    if (museListEl) {
      museListEl.addEventListener("click", (e) => {
        const row = e.target.closest(".video-item-row");
        if (!row) return;
        const vid = row.getAttribute("data-vid");
        if (!vid) return;

        if (e.target.type !== "checkbox") {
          const chk = row.querySelector(".muse-vid-check");
          if (chk) chk.checked = !chk.checked;
        }

        const isChecked = row.querySelector(".muse-vid-check").checked;
        if (isChecked) {
          tiktokState.selectedMuseVideoIds.add(vid);
        } else {
          tiktokState.selectedMuseVideoIds.delete(vid);
        }
        renderMuseVideoList();
      });
    }

    // Set default schedule time to current time + 10 mins
    const inputSchedule = document.getElementById("inputScheduleStart");
    if (inputSchedule && !inputSchedule.value) {
      const now = new Date();
      now.setMinutes(now.getMinutes() + 15);
      inputSchedule.value = toDatetimeLocal(now);
    }

    // Block 4: Button "➕ ĐƯA VÀO HÀNG ĐỢI CHỜ KIỂM TRA"
    const btnPushQueue = document.getElementById("btnPushToQueue");
    if (btnPushQueue) {
      btnPushQueue.addEventListener("click", async () => {
        const selectedVids = Array.from(tiktokState.selectedMuseVideoIds);
        if (selectedVids.length === 0) {
          return toast("Hãy tick chọn ít nhất một video ở mục [2] CHỌN VIDEO ĐÃ RENDER");
        }

        toast(`Đang đưa ${selectedVids.length} video vào hàng đợi TikTok...`);
        if (window.tiktokApp && window.tiktokApp.addMuseResults) {
          const res = await window.tiktokApp.addMuseResults(selectedVids);
          toast(`Đã thêm ${res.jobs ? res.jobs.length : selectedVids.length} video vào hàng đợi thành công!`);
          tiktokState.selectedMuseVideoIds.clear();
          renderMuseVideoList();
        }
      });
    }

    // Right Table Filters
    const filterButtons = document.querySelectorAll("#tiktokFilters button");
    filterButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        filterButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        tiktokState.filter = btn.getAttribute("data-filter") || "all";
        renderQueueTable();
      });
    });

    // Right Table Search
    const searchInput = document.getElementById("tiktokSearch");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        tiktokState.search = e.target.value.trim();
        renderQueueTable();
      });
    }

    // Select all in table
    const chkSelectAll = document.getElementById("tiktokSelectAll");
    if (chkSelectAll) {
      chkSelectAll.addEventListener("change", (e) => {
        if (e.target.checked) {
          tiktokState.selectedJobIds = new Set(tiktokState.jobs.map(j => j.id));
        } else {
          tiktokState.selectedJobIds.clear();
        }
        renderQueueTable();
      });
    }

    // Action Toolbar buttons
    const btnSchedAll = document.getElementById("btnScheduleAll");
    if (btnSchedAll) {
      btnSchedAll.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.runJobs) {
          toast("Đang bắt đầu lên lịch tất cả các bài...");
          await window.tiktokApp.runJobs(null);
        }
      });
    }

    const btnRunSel = document.getElementById("btnRunSelected");
    if (btnRunSel) {
      btnRunSel.addEventListener("click", async () => {
        const ids = Array.from(tiktokState.selectedJobIds);
        if (ids.length === 0) return toast("Chưa chọn dòng nào để chạy");
        toast(`Đang chạy ${ids.length} bài được chọn...`);
        if (window.tiktokApp && window.tiktokApp.runJobs) {
          await window.tiktokApp.runJobs(ids);
        }
      });
    }

    const btnDelSel = document.getElementById("btnDeleteSelected");
    if (btnDelSel) {
      btnDelSel.addEventListener("click", async () => {
        const ids = Array.from(tiktokState.selectedJobIds);
        if (ids.length === 0) return toast("Chưa chọn dòng nào để xóa");
        if (confirm(`Bạn có chắc muốn xóa ${ids.length} dòng đã chọn không?`)) {
          if (window.tiktokApp && window.tiktokApp.removeJobs) {
            await window.tiktokApp.removeJobs(ids, true);
            tiktokState.selectedJobIds.clear();
            toast(`Đã xóa ${ids.length} dòng.`);
          }
        }
      });
    }

    const btnVerifyAll = document.getElementById("btnVerifyShowcaseAll");
    if (btnVerifyAll) {
      btnVerifyAll.addEventListener("click", async () => {
        toast("Đang kiểm tra Showcase đối chiếu sản phẩm...");
        const cartJobs = tiktokState.jobs.filter(j => j.accountMode === "affiliate");
        for (const j of cartJobs) {
          if (window.tiktokApp && window.tiktokApp.verifyProduct) {
            await window.tiktokApp.verifyProduct(j.id);
          }
        }
        toast("Hoàn tất kiểm tra sản phẩm Showcase!");
      });
    }

    const btnAIGen = document.getElementById("btnAIGenerateSelected");
    if (btnAIGen) {
      btnAIGen.addEventListener("click", async () => {
        const ids = Array.from(tiktokState.selectedJobIds);
        const targetIds = ids.length > 0 ? ids : tiktokState.jobs.map(j => j.id);
        if (targetIds.length === 0) return toast("Hàng đợi chưa có video nào");
        toast(`AI đang viết tiêu đề và hashtag cho ${targetIds.length} video...`);
        for (const jId of targetIds) {
          if (window.tiktokApp && window.tiktokApp.generateContent) {
            try {
              await window.tiktokApp.generateContent(jId, { tone: "review" });
            } catch (err) {
              console.warn("Lỗi sinh AI cho job:", jId, err);
            }
          }
        }
        toast("Đã tạo nội dung AI xong!");
      });
    }

    // Table row delegate actions
    const tbody = document.getElementById("tiktokQueueTbody");
    if (tbody) {
      tbody.addEventListener("click", async (e) => {
        const runBtn = e.target.closest(".btn-run-one");
        if (runBtn) {
          const jId = runBtn.getAttribute("data-id");
          if (jId && window.tiktokApp && window.tiktokApp.runJobs) {
            toast(`Bắt đầu đăng video #${jId}...`);
            await window.tiktokApp.runJobs([jId]);
          }
          return;
        }

        const delBtn = e.target.closest(".btn-del-one");
        if (delBtn) {
          const jId = delBtn.getAttribute("data-id");
          if (jId && confirm("Bạn có chắc muốn xóa video này khỏi hàng đợi không?")) {
            if (window.tiktokApp && window.tiktokApp.removeJobs) {
              await window.tiktokApp.removeJobs([jId], true);
              toast("Đã xóa dòng khỏi hàng đợi.");
            }
          }
          return;
        }

        const chk = e.target.closest(".job-check");
        if (chk) {
          const jId = chk.getAttribute("data-id");
          if (chk.checked) tiktokState.selectedJobIds.add(jId);
          else tiktokState.selectedJobIds.delete(jId);
        }
      });

      // Direct editing change listener
      tbody.addEventListener("change", async (e) => {
        const jId = e.target.getAttribute("data-job-id");
        if (!jId) return;

        // Caption edit
        if (e.target.classList.contains("table-caption-edit")) {
          const text = e.target.value.trim();
          const lines = text.split("\n");
          const title = lines[0] || "";
          const hashtags = text.match(/#[^\s#]+/g) || [];
          if (window.tiktokApp && window.tiktokApp.updateJob) {
            await window.tiktokApp.updateJob(jId, {
              content: { title, caption: text, hashtags }
            });
            toast("Đã cập nhật tiêu đề/mô tả.");
          }
        }

        // Channel select per row
        if (e.target.classList.contains("channel-badge-select")) {
          const accId = e.target.value;
          if (window.tiktokApp && window.tiktokApp.updateJob) {
            await window.tiktokApp.updateJob(jId, { accountId: accId });
            toast("Đã gán kênh cho video.");
          }
        }

        // Cart toggle per row
        if (e.target.classList.contains("chk-row-cart")) {
          const isCart = e.target.checked;
          if (window.tiktokApp && window.tiktokApp.updateJob) {
            await window.tiktokApp.updateJob(jId, {
              accountMode: isCart ? "affiliate" : "no_cart"
            });
          }
        }

        // Product ID / Name edit per row
        if (e.target.classList.contains("input-row-pid") || e.target.classList.contains("input-row-pname")) {
          const row = e.target.closest("tr");
          const pid = row.querySelector(".input-row-pid")?.value.trim() || "";
          const pname = row.querySelector(".input-row-pname")?.value.trim() || "";
          if (window.tiktokApp && window.tiktokApp.updateJob) {
            await window.tiktokApp.updateJob(jId, {
              productMatch: { productId: pid, title: pname, confirmed: Boolean(pid) }
            });
          }
        }

        // Schedule mode & time edit per row
        if (e.target.classList.contains("select-row-mode") || e.target.classList.contains("input-row-time")) {
          const row = e.target.closest("tr");
          const mode = row.querySelector(".select-row-mode")?.value || "native_schedule";
          const timeVal = row.querySelector(".input-row-time")?.value || "";
          if (window.tiktokApp && window.tiktokApp.updateJob) {
            await window.tiktokApp.updateJob(jId, {
              schedule: {
                mode,
                targetTime: timeVal ? new Date(timeVal).toISOString() : new Date().toISOString()
              }
            });
          }
        }
      });
    }
  }

  // --- INITIALIZATION ---
  function init() {
    setupEventListeners();

    if (window.tiktokApp) {
      // Load initial state
      if (window.tiktokApp.getState) {
        window.tiktokApp.getState().then(state => {
          if (state) {
            tiktokState.settings = state.settings || {};
            tiktokState.accounts = state.accounts || [];
            tiktokState.jobs = state.jobs || [];
            tiktokState.mediaAssets = state.mediaAssets || [];
            if (!tiktokState.activeAccountId && tiktokState.accounts.length > 0) {
              tiktokState.activeAccountId = tiktokState.accounts[0].id;
            }
            renderQueueTable();
          }
        });
      }

      // Listen for broadcasted state updates
      if (window.museApp && window.museApp.onState) {
        window.museApp.onState(state => {
          if (state?.tiktok) {
            const s = state.tiktok;
            tiktokState.settings = s.settings || {};
            tiktokState.accounts = s.accounts || [];
            tiktokState.jobs = s.jobs || [];
            tiktokState.mediaAssets = s.mediaAssets || [];
            if (!tiktokState.activeAccountId && tiktokState.accounts.length > 0) {
              tiktokState.activeAccountId = tiktokState.accounts[0].id;
            }
            renderQueueTable();
          }
        });
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
